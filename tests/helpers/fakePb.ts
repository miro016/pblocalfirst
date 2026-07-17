import { ClientResponseError } from 'pocketbase'
import type { EvalContext } from '../../src/query/filter'
import { compileFilter } from '../../src/query/filter'
import { sortRecords } from '../../src/query/sort'
import { applyFields } from '../../src/query/fields'
import type { BaseRecord } from '../../src/types'

/**
 * Minimal in-memory PocketBase server double: enough of the SDK surface for
 * the sync engine and collection API (getFullList/getList/getOne/create/
 * update/delete/subscribe, realtime events, health, authStore). Timestamps
 * are strictly increasing so `updated`-based sync logic is deterministic.
 *
 * On top of the plain-server surface it can simulate everything a
 * pbreplication cluster does to a client connected to one node: changes
 * applied without realtime delivery (replicated writes while the SSE
 * connection is down), bulk change bursts (snapshot resyncs), records
 * vanishing silently (compacted tombstones), request latency and targeted
 * failures.
 */

export function networkError(): ClientResponseError {
  return new ClientResponseError({ url: '', status: 0, response: {}, originalError: new Error('network down') })
}

export function validationError(message = 'Failed to create record.'): ClientResponseError {
  return new ClientResponseError({ url: '', status: 400, response: { code: 400, message, data: {} } })
}

export function notFound(): ClientResponseError {
  return new ClientResponseError({ url: '', status: 404, response: { code: 404, message: 'Not found.', data: {} } })
}

type Subscriber = { topic: string; cb: (e: { action: string; record: BaseRecord }) => void; filter?: string }

export interface ServerWriteOptions {
  /** Emit a realtime event (default true). false = the change reached the server but no event was delivered. */
  emit?: boolean
  /** Exact `updated` timestamp to store (skips the clock tick) — for equal-timestamp scenarios. */
  updated?: string
}

interface FailRule {
  pattern: string | RegExp
  error: Error
  times: number
}

export class FakePb {
  online = true
  /** When set, all writes throw this error (for rollback tests). */
  failWrites: Error | null = null
  /** Connected, but realtime events are silently lost (dropped SSE). */
  dropRealtime = false
  /** Delay every request by this many ms (in-flight/race tests). */
  latencyMs = 0
  /** Server clock; tests can move it into the future to control last-update-wins outcomes. */
  clockMs = Date.parse('2024-01-01T00:00:00.000Z')
  private data = new Map<string, Map<string, BaseRecord>>()
  private subscribers = new Map<string, Subscriber[]>()
  private authListeners: Array<() => void> = []
  private failRules: FailRule[] = []
  requestLog: string[] = []
  /** Detailed request log incl. options — for asserting fetch strategies (chunking, filters, fields). */
  requests: Array<{ what: string; options: Record<string, unknown> }> = []

  authStore = {
    token: 'token-a',
    record: { id: 'user-a' } as BaseRecord | null,
    onChange: (cb: () => void) => {
      this.authListeners.push(cb)
      return () => {
        this.authListeners = this.authListeners.filter((c) => c !== cb)
      }
    },
  }

  health = {
    check: async (_opts?: unknown) => {
      await this.guard('health', {})
      return { code: 200, message: 'ok' }
    },
  }

  constructor(private relations: Record<string, Record<string, string>> = {}) {}

  setAuth(record: BaseRecord | null): void {
    this.authStore.record = record
    this.authStore.token = record ? `token-${record.id}` : ''
    for (const cb of [...this.authListeners]) cb()
  }

  tick(): string {
    this.clockMs += 1000
    return new Date(this.clockMs).toISOString().replace('T', ' ')
  }

  /** Fail the next `times` requests whose `what` (e.g. "update:posts") matches. */
  failNext(pattern: string | RegExp, error: Error, times = 1): void {
    this.failRules.push({ pattern, error, times })
  }

  table(name: string): Map<string, BaseRecord> {
    let t = this.data.get(name)
    if (!t) {
      t = new Map()
      this.data.set(name, t)
    }
    return t
  }

  /** Seed a record directly ("another client/node wrote this"), emitting realtime events by default. */
  serverWrite(collection: string, record: Partial<BaseRecord> & { id: string }, opts: ServerWriteOptions = {}): BaseRecord {
    const table = this.table(collection)
    const existing = table.get(record.id)
    const now = opts.updated ?? this.tick()
    const full: BaseRecord = existing
      ? { ...existing, ...record, updated: now }
      : { created: now, updated: now, collectionName: collection, ...record }
    table.set(record.id, full)
    if (opts.emit !== false) this.emit(collection, existing ? 'update' : 'create', full)
    return full
  }

  serverDelete(collection: string, id: string, opts: { emit?: boolean } = {}): void {
    const table = this.table(collection)
    const record = table.get(id)
    if (!record) return
    table.delete(id)
    if (opts.emit !== false) this.emit(collection, 'delete', record)
  }

  /** Delete server-side with NO realtime event — a reconcile-detected deletion / compacted tombstone. */
  serverVanish(collection: string, id: string): void {
    this.serverDelete(collection, id, { emit: false })
  }

  /**
   * Apply many records in one burst (a replicated bulk apply / snapshot resync).
   * `sameTimestamp` stores one identical `updated` on every record.
   */
  bulkServerWrite(
    collection: string,
    records: Array<Partial<BaseRecord> & { id: string }>,
    opts: { emit?: boolean; sameTimestamp?: boolean } = {},
  ): BaseRecord[] {
    const shared = opts.sameTimestamp ? this.tick() : undefined
    return records.map((record) => this.serverWrite(collection, record, { emit: opts.emit ?? false, updated: shared }))
  }

  /**
   * Replace a table wholesale: ids missing from `records` vanish silently and
   * the rest are written with one shared fresh timestamp. Models what a
   * client sees after the node it talks to performed a full snapshot resync.
   */
  restartWithSnapshot(
    collection: string,
    records: Array<Partial<BaseRecord> & { id: string }>,
    opts: { emit?: boolean } = {},
  ): void {
    const keep = new Set(records.map((r) => r.id))
    for (const id of [...this.table(collection).keys()]) {
      if (!keep.has(id)) this.table(collection).delete(id)
    }
    this.bulkServerWrite(collection, records, { emit: opts.emit ?? false, sameTimestamp: true })
  }

  /** Inject an arbitrary realtime event (stale/out-of-order/duplicate event simulation). */
  emitRaw(collection: string, action: 'create' | 'update' | 'delete', record: BaseRecord): void {
    this.deliver(collection, action, record)
  }

  private emit(collection: string, action: string, record: BaseRecord): void {
    if (!this.online) return // a disconnected client receives no realtime events
    if (this.dropRealtime) return // connected, but the event is lost
    this.deliver(collection, action, record)
  }

  private deliver(collection: string, action: string, record: BaseRecord): void {
    const subs = this.subscribers.get(collection) ?? []
    const ctx = this.evalCtx()
    for (const sub of [...subs]) {
      if (sub.topic !== '*' && sub.topic !== record.id) continue
      if (sub.filter) {
        const predicate = compileFilter(sub.filter, collection, ctx)
        if (!predicate(record)) continue
      }
      sub.cb({ action, record: { ...record } })
    }
  }

  private evalCtx(): EvalContext {
    return {
      getRelations: (collection) => this.relations[collection],
      getAll: (collection) => [...this.table(collection).values()],
      getById: (collection, id) => this.table(collection).get(id),
    }
  }

  private async guard(what: string, options: Record<string, unknown>): Promise<void> {
    this.requestLog.push(what)
    this.requests.push({ what, options })
    if (!this.online) throw networkError()
    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs))
      // the connection may have dropped while the request was in flight
      if (!this.online) throw networkError()
    }
    for (const rule of this.failRules) {
      const matches = typeof rule.pattern === 'string' ? what.includes(rule.pattern) : rule.pattern.test(what)
      if (matches && rule.times > 0) {
        rule.times--
        throw rule.error
      }
    }
  }

  collection(name: string) {
    const table = () => this.table(name)
    const query = (options: { filter?: string; sort?: string; fields?: string } = {}) => {
      const predicate = compileFilter(options.filter, name, this.evalCtx())
      let records = [...table().values()].filter(predicate)
      records = sortRecords(records, options.sort)
      records = records.map((r) => ({ ...r }))
      return applyFields(records, options.fields)
    }

    return {
      getFullList: async (options: Record<string, unknown> = {}) => {
        await this.guard(`getFullList:${name}`, options)
        return query(options)
      },
      getList: async (page = 1, perPage = 30, options: Record<string, unknown> = {}) => {
        await this.guard(`getList:${name}`, options)
        const all = query(options)
        return {
          page,
          perPage,
          totalItems: options.skipTotal ? -1 : all.length,
          totalPages: options.skipTotal ? -1 : Math.ceil(all.length / perPage),
          items: all.slice((page - 1) * perPage, page * perPage),
        }
      },
      getFirstListItem: async (filter: string, options: Record<string, unknown> = {}) => {
        await this.guard(`getFirstListItem:${name}`, { ...options, filter })
        const all = query({ ...options, filter })
        if (all.length === 0) throw notFound()
        return all[0]
      },
      getOne: async (id: string, options: Record<string, unknown> = {}) => {
        await this.guard(`getOne:${name}`, { ...options, id })
        const record = table().get(id)
        if (!record) throw notFound()
        return { ...record }
      },
      create: async (body: Record<string, unknown>, options: Record<string, unknown> = {}) => {
        await this.guard(`create:${name}`, options)
        if (this.failWrites) throw this.failWrites
        const id = (body.id as string) || Math.random().toString(36).slice(2, 17)
        if (table().has(id)) throw validationError('Record id already exists.')
        const now = this.tick()
        const record: BaseRecord = { ...body, id, created: now, updated: now, collectionName: name }
        table().set(id, record)
        this.emit(name, 'create', record)
        return { ...record }
      },
      update: async (id: string, body: Record<string, unknown>, options: Record<string, unknown> = {}) => {
        await this.guard(`update:${name}`, { ...options, id })
        if (this.failWrites) throw this.failWrites
        const existing = table().get(id)
        if (!existing) throw notFound()
        const record: BaseRecord = { ...existing, ...body, id, updated: this.tick() }
        table().set(id, record)
        this.emit(name, 'update', record)
        return { ...record }
      },
      delete: async (id: string, options: Record<string, unknown> = {}) => {
        await this.guard(`delete:${name}`, { ...options, id })
        if (this.failWrites) throw this.failWrites
        const existing = table().get(id)
        if (!existing) throw notFound()
        table().delete(id)
        this.emit(name, 'delete', existing)
        return true
      },
      subscribe: async (topic: string, cb: Subscriber['cb'], options: Record<string, unknown> = {}) => {
        await this.guard(`subscribe:${name}`, options)
        const sub: Subscriber = { topic, cb, filter: options.filter as string | undefined }
        const subs = this.subscribers.get(name) ?? []
        subs.push(sub)
        this.subscribers.set(name, subs)
        return async () => {
          const current = this.subscribers.get(name) ?? []
          this.subscribers.set(
            name,
            current.filter((s) => s !== sub),
          )
        }
      },
      unsubscribe: async (_topic?: string) => {
        this.subscribers.set(name, [])
      },
    }
  }
}
