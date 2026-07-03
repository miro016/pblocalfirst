import type PocketBase from 'pocketbase'
import type { RecordService } from 'pocketbase'
import { QueryError, notFoundError } from './errors'
import { createLiveQuery, type LiveQuery } from './live'
import { applyExpand } from './query/expand'
import { applyFields } from './query/fields'
import { compileFilter, type EvalContext } from './query/filter'
import { sortRecords } from './query/sort'
import type { ReactivityAdapter } from './reactivity'
import type { CollectionStore } from './store'
import type { CollectionSync, SyncManager } from './sync/engine'
import type {
  BaseRecord,
  FullListQueryOptions,
  ListQueryOptions,
  ListResult,
  QueryOptions,
  RecordSubscription,
  UnsubscribeFunc,
} from './types'
import { clone, generateId, nowPocketBaseDate } from './utils'

/** Apply a PocketBase create/update body locally, including `field+` / `+field` / `field-` modifiers. */
function applyBodyLocally(base: Record<string, unknown>, body: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base }
  for (const [key, value] of Object.entries(body)) {
    if (key.length > 1 && key.endsWith('+')) {
      const field = key.slice(0, -1)
      const current = out[field]
      if (Array.isArray(current)) out[field] = [...current, ...(Array.isArray(value) ? value : [value])]
      else if (typeof current === 'number') out[field] = current + Number(value)
      else out[field] = value
    } else if (key.length > 1 && key.startsWith('+')) {
      const field = key.slice(1)
      const current = out[field]
      if (Array.isArray(current)) out[field] = [...(Array.isArray(value) ? value : [value]), ...current]
      else out[field] = value
    } else if (key.length > 1 && key.endsWith('-')) {
      const field = key.slice(0, -1)
      const current = out[field]
      if (Array.isArray(current)) {
        const removals = Array.isArray(value) ? value : [value]
        out[field] = current.filter((item) => !removals.includes(item))
      } else if (typeof current === 'number') out[field] = current - Number(value)
    } else {
      out[key] = value
    }
  }
  return out
}

interface CollectionDeps {
  pb: PocketBase
  evalCtx: EvalContext
  reactivity: ReactivityAdapter
  /** Subscribe to changes of every cached store (for live queries that traverse relations). */
  subscribeAllStores(listener: () => void): () => void
  /**
   * Resolves when every cached collection is readable. Queries can traverse
   * relations into any cached collection, so reads gate on all of them —
   * otherwise a filter like `author.name = "x"` evaluated mid-initial-sync
   * could return different results than the server.
   */
  allReadable(): Promise<void>
}

/**
 * Drop-in replacement for the PocketBase SDK's RecordService. For cached
 * collections all reads/queries/subscriptions are served from the local db
 * (and work offline); for non-cached collections everything passes through
 * to the remote server. Method signatures and result shapes match the SDK.
 */
export class LocalFirstCollection<T extends BaseRecord = BaseRecord> {
  private localSubs = new Map<string, Set<() => void>>()

  constructor(
    public readonly name: string,
    private deps: CollectionDeps,
    private store: CollectionStore<T> | null = null,
    private engine: CollectionSync<T> | null = null,
    private manager: SyncManager | null = null,
  ) {}

  /** Whether this collection is mirrored into the local db. */
  get isCached(): boolean {
    return this.store !== null
  }

  private get remote(): RecordService<T> {
    return this.deps.pb.collection(this.name) as unknown as RecordService<T>
  }

  private get localStore(): CollectionStore<T> {
    if (!this.store) {
      throw new QueryError(
        `Collection "${this.name}" is not cached locally. Enable \`cache: true\` in the collections config to use local/reactive reads.`,
      )
    }
    return this.store
  }

  private async awaitReadable(): Promise<void> {
    if (this.engine) await this.deps.allReadable()
  }

  // ---------------------------------------------------------------------------
  // Local query pipeline
  // ---------------------------------------------------------------------------

  private select(records: T[], options: QueryOptions = {}): T[] {
    const predicate = compileFilter(options.filter, this.name, this.deps.evalCtx)
    return sortRecords(records.filter(predicate), options.sort)
  }

  /** expand -> copy -> fields; applied only to the records actually returned. */
  private finalize(records: T[], options: QueryOptions = {}): T[] {
    let out = applyExpand(records, this.name, options.expand, this.deps.evalCtx)
    out = out.map((record) => ({ ...record }))
    return applyFields(out, options.fields)
  }

  // ---------------------------------------------------------------------------
  // PocketBase-compatible async API
  // ---------------------------------------------------------------------------

  async getList(page = 1, perPage = 30, options: ListQueryOptions = {}): Promise<ListResult<T>> {
    if (!this.isCached) return (await this.remote.getList(page, perPage, options as never)) as ListResult<T>
    await this.awaitReadable()
    const matching = this.select(this.localStore.getAll(), options)
    const items = this.finalize(matching.slice((page - 1) * perPage, page * perPage), options)
    const skipTotal = !!options.skipTotal
    return {
      page,
      perPage,
      totalItems: skipTotal ? -1 : matching.length,
      totalPages: skipTotal ? -1 : Math.ceil(matching.length / perPage),
      items,
    }
  }

  async getFullList(batchOrOptions?: number | FullListQueryOptions, options?: FullListQueryOptions): Promise<T[]> {
    const opts: FullListQueryOptions =
      typeof batchOrOptions === 'number' ? { batch: batchOrOptions, ...options } : (batchOrOptions ?? {})
    if (!this.isCached) return (await this.remote.getFullList(opts as never)) as T[]
    await this.awaitReadable()
    return this.finalize(this.select(this.localStore.getAll(), opts), opts)
  }

  async getFirstListItem(filter: string, options: ListQueryOptions = {}): Promise<T> {
    if (!this.isCached) return (await this.remote.getFirstListItem(filter, options as never)) as T
    await this.awaitReadable()
    const matching = this.select(this.localStore.getAll(), { ...options, filter })
    if (matching.length === 0) throw notFoundError()
    return this.finalize([matching[0]], options)[0]
  }

  async getOne(id: string, options: QueryOptions = {}): Promise<T> {
    if (!this.isCached) return (await this.remote.getOne(id, options as never)) as T
    await this.awaitReadable()
    if (!id) throw notFoundError()
    const record = this.localStore.get(id)
    if (!record) throw notFoundError()
    return this.finalize([record], options)[0]
  }

  async create(bodyParams: Partial<T> | Record<string, unknown> | FormData, options: QueryOptions = {}): Promise<T> {
    if (!this.isCached) return (await this.remote.create(bodyParams as never, options as never)) as T

    if (bodyParams instanceof FormData) {
      // file uploads can't be applied offline; pass through when online
      return this.passthroughWrite(() => this.remote.create(bodyParams as never, options as never))
    }

    const body = bodyParams as Record<string, unknown>
    const id = typeof body.id === 'string' && body.id ? body.id : generateId()
    const now = nowPocketBaseDate()
    const optimistic = {
      ...applyBodyLocally({}, body),
      id,
      created: now,
      updated: now,
      collectionName: this.name,
    } as unknown as T
    this.localStore.upsert(optimistic)

    const result = await this.manager!.submit<T>(
      { collection: this.name, type: 'create', id, data: { ...body, id }, base: null, opTime: now },
      optimistic,
    )
    const record = result ?? this.localStore.peek(id) ?? optimistic
    return this.finalize([record], options)[0]
  }

  async update(id: string, bodyParams: Partial<T> | Record<string, unknown> | FormData, options: QueryOptions = {}): Promise<T> {
    if (!this.isCached) return (await this.remote.update(id, bodyParams as never, options as never)) as T
    await this.awaitReadable()

    if (bodyParams instanceof FormData) {
      const record = await this.passthroughWrite(() => this.remote.update(id, bodyParams as never, options as never))
      this.localStore.upsert(record)
      return record
    }

    const base = this.localStore.peek(id)
    if (!base) throw notFoundError()

    const body = bodyParams as Record<string, unknown>
    const now = nowPocketBaseDate()
    const optimistic = { ...applyBodyLocally(base, body), id, updated: now } as unknown as T
    this.localStore.upsert(optimistic)

    const result = await this.manager!.submit<T>(
      { collection: this.name, type: 'update', id, data: body, base, opTime: now },
      optimistic,
    )
    const record = result ?? this.localStore.peek(id) ?? optimistic
    return this.finalize([record], options)[0]
  }

  async delete(id: string, options: QueryOptions = {}): Promise<boolean> {
    if (!this.isCached) return await this.remote.delete(id, options as never)
    await this.awaitReadable()
    const base = this.localStore.peek(id)
    if (!base) throw notFoundError()
    this.localStore.remove(id)
    await this.manager!.submit<T>({ collection: this.name, type: 'delete', id, base, opTime: nowPocketBaseDate() }, null)
    return true
  }

  private async passthroughWrite<R>(run: () => Promise<R>): Promise<R> {
    if (this.manager && !this.manager.monitor.online) {
      throw new QueryError(
        `File uploads (FormData) cannot be queued offline for cached collection "${this.name}". Retry while online.`,
      )
    }
    const result = await run()
    if (result && this.store && typeof result === 'object' && 'id' in (result as object)) {
      this.store.upsert(result as unknown as T)
    }
    return result
  }

  // ---------------------------------------------------------------------------
  // Realtime-compatible subscriptions
  // ---------------------------------------------------------------------------

  /**
   * Same contract as the SDK's `subscribe`. For cached collections events are
   * emitted from the local db — they fire for remote realtime changes *and*
   * local (optimistic/offline) writes, so the UI is always live.
   */
  async subscribe(
    topic: string,
    callback: (e: RecordSubscription<T>) => void,
    options: QueryOptions = {},
  ): Promise<UnsubscribeFunc> {
    if (!this.isCached) return await this.remote.subscribe(topic, callback as never, options as never)

    const predicate = compileFilter(options.filter, this.name, this.deps.evalCtx)
    const unsub = this.localStore.onChange((events) => {
      for (const event of events) {
        if (topic !== '*' && event.record.id !== topic) continue
        if (!predicate(event.record)) continue
        let record = event.record
        if (event.action !== 'delete' && (options.expand || options.fields)) {
          record = this.finalize([record], options)[0]
        } else {
          record = { ...record }
        }
        callback({ action: event.action, record })
      }
    })

    let topicSubs = this.localSubs.get(topic)
    if (!topicSubs) {
      topicSubs = new Set()
      this.localSubs.set(topic, topicSubs)
    }
    const tracked = () => {
      unsub()
      this.localSubs.get(topic)?.delete(tracked)
    }
    topicSubs.add(tracked)
    return async () => tracked()
  }

  async unsubscribe(topic?: string): Promise<void> {
    if (!this.isCached) {
      await this.remote.unsubscribe(topic)
      return
    }
    const topics = topic ? [topic] : [...this.localSubs.keys()]
    for (const t of topics) {
      for (const dispose of [...(this.localSubs.get(t) ?? [])]) dispose()
      this.localSubs.delete(t)
    }
  }

  // ---------------------------------------------------------------------------
  // Reactive synchronous reads (cached collections)
  // ---------------------------------------------------------------------------

  /**
   * Reactive query: returns matching records and registers a dependency when
   * called inside a reactive scope (Angular `computed`/`effect`, ...).
   */
  list(options: QueryOptions = {}): T[] {
    return this.finalize(this.select(this.localStore.getAll(), options), options)
  }

  /** Reactive single-record read. */
  one(id: string, options: QueryOptions = {}): T | undefined {
    const record = this.localStore.get(id)
    if (!record) return undefined
    return this.finalize([record], options)[0]
  }

  /** Reactive "first match" read. */
  first(filter?: string, options: QueryOptions = {}): T | undefined {
    const matching = this.select(this.localStore.getAll(), { ...options, filter })
    if (matching.length === 0) return undefined
    return this.finalize([matching[0]], options)[0]
  }

  /** Reactive count. */
  count(filter?: string): number {
    const predicate = compileFilter(filter, this.name, this.deps.evalCtx)
    return this.localStore.getAll().filter(predicate).length
  }

  // ---------------------------------------------------------------------------
  // Live queries (work for cached AND non-cached collections)
  // ---------------------------------------------------------------------------

  /**
   * Continuously updated list. Cached collections recompute from the local db
   * on every change; non-cached collections refetch from the server whenever
   * a realtime event for the collection arrives.
   */
  liveList(options: QueryOptions = {}): LiveQuery<T[]> {
    if (this.isCached) {
      const usesRelations = !!options.expand || (options.filter ?? '').includes('.') || (options.filter ?? '').includes('_via_')
      return createLiveQuery<T[]>([], {
        compute: async () => {
          await this.awaitReadable()
          return this.finalize(this.select(this.localStore.peekAll(), options), options)
        },
        connect: (invalidate) =>
          usesRelations ? this.deps.subscribeAllStores(invalidate) : this.localStore.onChange(invalidate),
      }, this.deps.reactivity)
    }
    return this.remoteLive<T[]>([], () => this.remote.getFullList(options as never) as Promise<T[]>, '*', options)
  }

  /** Continuously updated single record (`undefined` once deleted / while missing). */
  liveOne(id: string, options: QueryOptions = {}): LiveQuery<T | undefined> {
    if (this.isCached) {
      return createLiveQuery<T | undefined>(undefined, {
        compute: async () => {
          await this.awaitReadable()
          const record = this.localStore.peek(id)
          return record ? this.finalize([record], options)[0] : undefined
        },
        connect: (invalidate) => (options.expand ? this.deps.subscribeAllStores(invalidate) : this.localStore.onChange(invalidate)),
      }, this.deps.reactivity)
    }
    return this.remoteLive<T | undefined>(
      undefined,
      () => this.remote.getOne(id, options as never).catch(() => undefined) as Promise<T | undefined>,
      id,
      options,
    )
  }

  private remoteLive<V>(initial: V, fetcher: () => Promise<V>, topic: string, options: QueryOptions): LiveQuery<V> {
    return createLiveQuery<V>(initial, {
      compute: fetcher,
      connect: (invalidate) => {
        let unsub: UnsubscribeFunc | null = null
        let disposed = false
        const subOptions: QueryOptions = {}
        if (options.filter && topic === '*') subOptions.filter = options.filter
        void this.remote
          .subscribe(topic, () => invalidate(), subOptions as never)
          .then((fn) => {
            if (disposed) void fn()
            else unsub = fn
          })
          .catch(() => {})
        return () => {
          disposed = true
          if (unsub) void unsub()
        }
      },
    }, this.deps.reactivity)
  }
}

export { clone as cloneRecord }
