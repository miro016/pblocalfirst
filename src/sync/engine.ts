import type PocketBase from 'pocketbase'
import type { RecordService } from 'pocketbase'
import { isNetworkError, isNotFound } from '../errors'
import type { PersistenceAdapter } from '../persistence/types'
import type { ReactiveDependency, ReactivityAdapter } from '../reactivity'
import type { CollectionStore } from '../store'
import type { BaseRecord, CollectionConfig, ConflictResolver, SyncErrorInfo, SyncStatus } from '../types'
import { chunk, clone, debounce, deepEqual, nowPocketBaseDate } from '../utils'
import type { PendingOp, WriteQueue } from './queue'
import { OnlineMonitor } from './monitor'

const SYSTEM_FIELDS = ['id', 'created', 'updated', 'collectionId', 'collectionName', 'expand'] as const

function stripSystem(data: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data }
  for (const field of SYSTEM_FIELDS) delete out[field]
  return out
}

/** Default conflict strategy: the side with the latest update timestamp wins. */
function lastUpdateWins<T extends BaseRecord>(local: T | null, remote: T | null, localOpTime: string): T | null {
  if (remote === null) return null // remote deletion wins (its timestamp is unknown; keep behavior predictable)
  if (local === null) {
    // local pending delete vs remote change
    return localOpTime > (remote.updated ?? '') ? null : remote
  }
  return localOpTime > (remote.updated ?? '') ? local : remote
}

interface EngineContext {
  pb: PocketBase
  queue: WriteQueue
  persistence: PersistenceAdapter
  namespace: string
  globalResolver?: ConflictResolver
  onSyncError: (info: SyncErrorInfo) => void
  isInFlight: (seq: number) => boolean
}

/**
 * Sync of a single cached collection: pulls (delta + full reconcile),
 * realtime subscription, conflict-aware application of remote changes and
 * pushing of pending local ops.
 */
export class CollectionSync<T extends BaseRecord = BaseRecord> {
  private cursor = ''
  private unsubscribeRealtime: (() => Promise<void> | void) | null = null
  private persistNow: (() => void) & { flush(): void }
  private storeUnsub: () => void
  private readableResolve!: () => void
  /**
   * Resolves once local reads are meaningful: either persisted data from a
   * previous session was loaded, or the first sync finished (or was skipped
   * because the client is offline). Read methods await this so a cold start
   * doesn't answer queries from an empty cache while the initial sync runs.
   */
  readonly readable: Promise<void> = new Promise((resolve) => {
    this.readableResolve = resolve
  })

  constructor(
    public readonly name: string,
    private cfg: CollectionConfig<T>,
    public readonly store: CollectionStore<T>,
    private ctx: EngineContext,
  ) {
    this.persistNow = debounce(() => {
      void this.ctx.persistence.save(this.dataKey, { records: this.store.peekAll(), cursor: this.cursor }).catch(() => {})
    }, 200)
    this.storeUnsub = this.store.onChange(() => this.persistNow())
  }

  private get dataKey(): string {
    return `${this.ctx.namespace}:data:${this.name}`
  }

  private get coll(): RecordService<T> {
    return this.ctx.pb.collection(this.name) as unknown as RecordService<T>
  }

  private get resolver(): ConflictResolver<T> | undefined {
    return this.cfg.conflictResolver ?? (this.ctx.globalResolver as ConflictResolver<T> | undefined)
  }

  async loadPersisted(): Promise<void> {
    const saved = (await this.ctx.persistence.load(this.dataKey).catch(() => undefined)) as
      | { records?: T[]; cursor?: string }
      | undefined
    if (saved?.records) {
      this.store.batch(() => {
        for (const record of saved.records!) this.store.upsert(record)
      })
      this.cursor = saved.cursor ?? ''
    }
    if (saved?.cursor) this.markReadable() // synced before; cached data is usable immediately
  }

  markReadable(): void {
    this.readableResolve()
  }

  async clearLocal(): Promise<void> {
    this.cursor = ''
    this.store.replaceAll([])
    this.persistNow.flush()
    await this.ctx.persistence.remove(this.dataKey).catch(() => {})
  }

  dispose(): void {
    this.storeUnsub()
    // a clean shutdown must not lose the debounce window: persist the latest
    // snapshot now so a restart sees the same data the queue ops assume
    this.persistNow.flush()
    void this.stopRealtime()
  }

  // -------------------------------------------------------------------------
  // Pull
  // -------------------------------------------------------------------------

  /** Fetch records changed since the cursor. Cheap; does not detect deletions. */
  async pullDelta(): Promise<void> {
    if (!this.cursor) {
      await this.reconcile()
      return
    }
    const filter = this.combineFilter(`updated >= "${this.cursor}"`)
    const items = await this.coll.getFullList({
      batch: this.cfg.sync?.batch ?? 500,
      filter,
      sort: 'updated',
      requestKey: null,
    })
    await this.applyRemoteRecords(items)
  }

  /**
   * Full reconcile: index scan (id + updated) to detect deletions and
   * changes, then fetch changed records. Run at start, on reconnect and
   * periodically.
   */
  async reconcile(): Promise<void> {
    const index = await this.coll.getFullList({
      batch: 1000,
      fields: 'id,updated',
      filter: this.combineFilter(),
      requestKey: null,
    })
    const remoteIndex = new Map<string, string>()
    for (const item of index) remoteIndex.set(item.id, (item as BaseRecord).updated ?? '')

    // deletions
    const deleteConflicts: string[] = []
    this.store.batch(() => {
      for (const record of this.store.peekAll()) {
        if (remoteIndex.has(record.id)) continue
        const pending = this.ctx.queue.getForId(this.name, record.id)
        if (!pending) this.store.remove(record.id)
        else if (pending.type !== 'create') deleteConflicts.push(record.id)
        // pending creates simply haven't reached the server yet
      }
    })
    for (const id of deleteConflicts) await this.handleRemoteChange(id, null)

    // new / changed records
    const toFetch: string[] = []
    for (const [id, updated] of remoteIndex) {
      const local = this.store.peek(id)
      if (!local) {
        toFetch.push(id)
        continue
      }
      const pending = this.ctx.queue.getForId(this.name, id)
      const baseline = pending?.base?.updated ?? local.updated ?? ''
      if (updated !== baseline) toFetch.push(id)
    }

    if (toFetch.length > 0) {
      if (toFetch.length > 300 && toFetch.length > remoteIndex.size / 2) {
        // cheaper to refetch everything
        const items = await this.coll.getFullList({
          batch: this.cfg.sync?.batch ?? 500,
          filter: this.combineFilter(),
          requestKey: null,
        })
        await this.applyRemoteRecords(items)
      } else {
        for (const ids of chunk(toFetch, 100)) {
          const filter = ids.map((id) => `id="${id}"`).join(' || ')
          const items = await this.coll.getFullList({ batch: ids.length, filter, requestKey: null })
          await this.applyRemoteRecords(items)
        }
      }
    }

    for (const updated of remoteIndex.values()) {
      if (updated > this.cursor) this.cursor = updated
    }
    this.persistNow()
    this.markReadable()
  }

  // -------------------------------------------------------------------------
  // Realtime
  // -------------------------------------------------------------------------

  async startRealtime(): Promise<void> {
    if (this.unsubscribeRealtime) return
    const options: Record<string, unknown> = { requestKey: null }
    if (this.cfg.sync?.filter) options.filter = this.cfg.sync.filter
    this.unsubscribeRealtime = await this.coll.subscribe(
      '*',
      (e) => {
        void this.onRealtimeEvent(e.action, e.record as T)
      },
      options,
    )
  }

  async stopRealtime(): Promise<void> {
    const unsub = this.unsubscribeRealtime
    this.unsubscribeRealtime = null
    if (unsub) await unsub()
  }

  private async onRealtimeEvent(action: string, record: T): Promise<void> {
    if ((record.updated ?? '') > this.cursor) {
      this.cursor = record.updated ?? this.cursor
    }
    if (action === 'delete') {
      await this.handleRemoteChange(record.id, null)
    } else {
      await this.handleRemoteChange(record.id, record)
    }
    this.persistNow()
  }

  // -------------------------------------------------------------------------
  // Applying remote state (conflict aware)
  // -------------------------------------------------------------------------

  private async applyRemoteRecords(items: T[]): Promise<void> {
    const conflicted: T[] = []
    this.store.batch(() => {
      for (const record of items) {
        if ((record.updated ?? '') > this.cursor) this.cursor = record.updated ?? this.cursor
        if (this.ctx.queue.getForId(this.name, record.id)) conflicted.push(record)
        else this.store.upsert(record)
      }
    })
    for (const record of conflicted) await this.handleRemoteChange(record.id, record)
    this.persistNow()
  }

  /**
   * Apply a remote change (record or deletion) for a single id, resolving
   * against any pending local op.
   */
  private async handleRemoteChange(id: string, remote: T | null): Promise<void> {
    const pending = this.ctx.queue.getForId(this.name, id)
    if (!pending) {
      if (remote === null) this.store.remove(id)
      else this.store.upsert(remote)
      return
    }
    if (this.ctx.isInFlight(pending.seq)) {
      // our own write is being pushed right now; the push result is authoritative
      return
    }
    await this.resolveAgainstRemote(pending as PendingOp<T>, remote)
  }

  /**
   * The record state the pending op intends locally. Usually the store copy;
   * when it is missing (e.g. the persisted queue survived a crash but the
   * debounced data snapshot did not), reconstruct it from the op's base and
   * payload — otherwise a restored pending update would be indistinguishable
   * from a local deletion and last-update-wins would turn it into a delete.
   */
  private localIntent(pending: PendingOp<T>): T | null {
    const stored = (this.store.peek(pending.id) as T | undefined) ?? null
    if (stored) return stored
    if (!pending.data) return null
    return { ...(pending.base ?? {}), ...pending.data, id: pending.id } as T
  }

  private async runResolver(pending: PendingOp<T>, remote: T | null): Promise<T | null> {
    const local = pending.type === 'delete' ? null : this.localIntent(pending)
    const resolver = this.resolver
    if (resolver) {
      return await resolver({
        collection: this.name,
        local: local ? clone(local) : null,
        remote: remote ? clone(remote) : null,
        base: pending.base ? clone(pending.base as T) : null,
      })
    }
    return lastUpdateWins(local, remote, pending.opTime)
  }

  /** Resolve a conflict between a pending local op and the remote state, updating store + queue. */
  private async resolveAgainstRemote(pending: PendingOp<T>, remote: T | null): Promise<void> {
    const winner = await this.runResolver(pending, remote)

    if (winner === null) {
      // the record should not exist
      if (remote === null) {
        // remote already deleted it: drop the local op and the local copy
        this.ctx.queue.removeSeq(pending.seq)
        this.store.remove(pending.id)
      } else if (pending.type === 'delete') {
        // keep the pending delete; refresh its base so the push wins cleanly
        this.ctx.queue.replace({ ...pending, base: remote })
      } else {
        // resolver decided the record must go although both sides have data
        this.store.remove(pending.id)
        this.ctx.queue.replace({ ...pending, type: 'delete', data: undefined, base: remote, opTime: nowPocketBaseDate() })
      }
      return
    }

    if (remote !== null && deepEqual(stripSystem(winner), stripSystem(remote))) {
      // remote version wins: drop the local op, accept the server record
      this.ctx.queue.removeSeq(pending.seq)
      this.store.upsert(remote)
      return
    }

    // local/merged version wins: keep it locally and keep pushing it
    if (remote === null) {
      // remote deleted, but resolver kept the local data -> re-create on push
      const record = { ...winner, id: pending.id } as T
      this.store.upsert(record)
      this.ctx.queue.replace({ ...pending, type: 'create', data: stripSystem(record), base: null, opTime: pending.opTime })
    } else {
      // the record exists remotely, so even a pending create must continue as
      // an update — pushing it as a create would be rejected as a duplicate id
      const record = { ...winner, id: pending.id } as T
      this.store.upsert(record)
      this.ctx.queue.replace({
        ...pending,
        type: 'update',
        data: stripSystem(record),
        base: remote,
        opTime: pending.opTime,
      })
    }
  }

  // -------------------------------------------------------------------------
  // Push (called by the SyncManager flush loop)
  // -------------------------------------------------------------------------

  /**
   * Push one pending op to the server. Returns the resulting local record
   * (or null for deletions / when the remote side won). Throws on network
   * errors (op stays queued) and on permanent errors (flush rolls back).
   */
  async push(op: PendingOp<T>): Promise<T | null> {
    if (op.type === 'create') {
      const record = await this.coll.create({ ...stripSystem(op.data), id: op.id } as never, { requestKey: null })
      this.store.upsert(record)
      this.persistNow()
      return record
    }

    if (op.type === 'update') {
      let remote: T | null = null
      try {
        remote = await this.coll.getOne(op.id, { requestKey: null })
      } catch (err) {
        if (!isNotFound(err)) throw err
        remote = null
      }

      if (remote === null) {
        // deleted remotely while we edited locally
        const winner = await this.runResolver(op, null)
        if (winner === null) {
          this.store.remove(op.id)
          this.persistNow()
          return null
        }
        const record = await this.coll.create({ ...stripSystem(winner), id: op.id } as never, { requestKey: null })
        this.store.upsert(record)
        this.persistNow()
        return record
      }

      if (op.base && (remote.updated ?? '') !== ((op.base as T).updated ?? '')) {
        // changed remotely since our base -> conflict
        const winner = await this.runResolver(op, remote)
        if (winner === null) {
          try {
            await this.coll.delete(op.id, { requestKey: null })
          } catch (err) {
            if (!isNotFound(err)) throw err
          }
          this.store.remove(op.id)
          this.persistNow()
          return null
        }
        if (deepEqual(stripSystem(winner), stripSystem(remote))) {
          this.store.upsert(remote)
          this.persistNow()
          return remote
        }
        const record = await this.coll.update(op.id, stripSystem(winner) as never, { requestKey: null })
        this.store.upsert(record)
        this.persistNow()
        return record
      }

      const record = await this.coll.update(op.id, stripSystem(op.data) as never, { requestKey: null })
      this.store.upsert(record)
      this.persistNow()
      return record
    }

    // delete
    try {
      await this.coll.delete(op.id, { requestKey: null })
    } catch (err) {
      if (!isNotFound(err)) throw err
    }
    this.store.remove(op.id)
    this.persistNow()
    return null
  }

  /** Undo the local optimistic effect of a permanently failed op. */
  rollback(op: PendingOp<T>): void {
    if (op.type === 'create') {
      this.store.remove(op.id)
    } else if (op.base) {
      this.store.upsert(op.base as T)
    } else {
      this.store.remove(op.id)
    }
    this.persistNow()
  }

  private combineFilter(extra?: string): string | undefined {
    const parts = [this.cfg.sync?.filter, extra].filter((p): p is string => !!p)
    if (parts.length === 0) return undefined
    if (parts.length === 1) return parts[0]
    return parts.map((p) => `(${p})`).join(' && ')
  }
}

// ---------------------------------------------------------------------------
// SyncManager
// ---------------------------------------------------------------------------

export interface SyncManagerConfig {
  namespace: string
  reconcileIntervalMs: number
  healthCheckIntervalMs: number
  conflictResolver?: ConflictResolver
  onSyncError?: (info: SyncErrorInfo) => void
}

/**
 * Coordinates all cached collections: owns the shared write queue, the flush
 * loop pushing local changes in order, connectivity, periodic reconciles and
 * the auth-change reset.
 */
export class SyncManager {
  readonly monitor: OnlineMonitor
  readonly engines = new Map<string, CollectionSync<any>>()
  private flushing: Promise<void> | null = null
  private inFlightSeq: number | null = null
  private reconcileTimer: ReturnType<typeof setInterval> | undefined
  private authUnsub: (() => void) | null = null
  private lastAuthId: string | null | undefined
  private started = false
  private stopped = false

  private syncing = false
  private lastSyncedAt = 0
  private statusDep: ReactiveDependency
  private statusListeners = new Set<(status: SyncStatus) => void>()

  private readyResolve!: () => void
  readonly ready: Promise<void> = new Promise((resolve) => {
    this.readyResolve = resolve
  })

  constructor(
    private pb: PocketBase,
    readonly queue: WriteQueue,
    private persistence: PersistenceAdapter,
    reactivity: ReactivityAdapter,
    private cfg: SyncManagerConfig,
  ) {
    this.monitor = new OnlineMonitor(pb, cfg.healthCheckIntervalMs)
    this.statusDep = reactivity.create()
    this.queue.isLocked = (seq) => this.inFlightSeq === seq
    this.queue.onChange(() => this.statusChanged())
  }

  registerCollection<T extends BaseRecord>(name: string, config: CollectionConfig<T>, store: CollectionStore<T>): CollectionSync<T> {
    const engine = new CollectionSync<T>(name, config, store, {
      pb: this.pb,
      queue: this.queue,
      persistence: this.persistence,
      namespace: this.cfg.namespace,
      globalResolver: this.cfg.conflictResolver,
      onSyncError: (info) => this.cfg.onSyncError?.(info),
      isInFlight: (seq) => this.inFlightSeq === seq,
    })
    this.engines.set(name, engine)
    return engine
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.lastAuthId = this.authRecordId()

    await this.queue.load()
    await Promise.all([...this.engines.values()].map((engine) => engine.loadPersisted()))
    this.readyResolve()

    this.monitor.start()
    this.monitor.onChange((online) => {
      this.statusChanged()
      if (online) {
        void this.syncAll().then(() => this.flush())
      }
    })
    this.authUnsub = this.pb.authStore.onChange(() => void this.handleAuthChange())

    if (this.cfg.reconcileIntervalMs > 0) {
      this.reconcileTimer = setInterval(() => {
        if (this.monitor.online) void this.syncAll().then(() => this.flush())
      }, this.cfg.reconcileIntervalMs)
    }

    if (this.monitor.online) {
      void this.initialSync().finally(() => {
        for (const engine of this.engines.values()) engine.markReadable()
      })
    } else {
      // offline start: local (possibly empty) data is the best we have
      for (const engine of this.engines.values()) engine.markReadable()
    }
  }

  stop(): void {
    this.stopped = true
    for (const engine of this.engines.values()) engine.markReadable()
    this.monitor.stop()
    if (this.reconcileTimer) clearInterval(this.reconcileTimer)
    this.authUnsub?.()
    for (const engine of this.engines.values()) engine.dispose()
  }

  private async initialSync(): Promise<void> {
    await this.syncAll()
    await this.flush()
  }

  private currentSync: Promise<void> | null = null
  private queuedSync: Promise<void> | null = null

  /**
   * Pull remote changes for all cached collections (full reconcile).
   * Concurrent calls coalesce: a call made while a sync is running waits for
   * it and then runs one more full pass, so `await syncAll()` always means
   * "the local db reflects the server as of now".
   */
  syncAll(): Promise<void> {
    if (!this.currentSync) {
      this.currentSync = this.doSync().finally(() => {
        this.currentSync = null
      })
      return this.currentSync
    }
    if (!this.queuedSync) {
      this.queuedSync = this.currentSync
        .catch(() => {})
        .then(() => {
          this.queuedSync = null
          return this.syncAll()
        })
    }
    return this.queuedSync
  }

  private async doSync(): Promise<void> {
    if (this.stopped) return
    this.syncing = true
    this.statusChanged()
    try {
      for (const engine of this.engines.values()) {
        await engine.reconcile()
        // realtime may have been missed while offline; make sure it's running
        try {
          await engine.startRealtime()
        } catch {
          /* best effort */
        }
      }
      this.lastSyncedAt = Date.now()
      this.monitor.reportSuccess()
    } catch (err) {
      if (isNetworkError(err)) this.monitor.reportFailure()
      else throw err
    } finally {
      this.syncing = false
      this.statusChanged()
    }
  }

  // -------------------------------------------------------------------------
  // Local writes
  // -------------------------------------------------------------------------

  /**
   * Enqueue a local op (already applied optimistically to the store by the
   * caller) and trigger a background flush.
   *
   * Optimistic local-first: the call resolves immediately with the local
   * record and never blocks on the network. The server round trip happens in
   * the background — right away when online, or as soon as connectivity
   * returns when offline. The authoritative server record is applied to the
   * store by the flush loop when it lands, so live reads/subscriptions update
   * again on confirmation. Permanent server rejections (validation, auth) roll
   * back the optimistic change and surface via `onSyncError`.
   */
  async submit<T extends BaseRecord>(op: Omit<PendingOp<T>, 'seq'>, optimistic: T | null): Promise<T | null> {
    const queued = this.queue.enqueue(op as Omit<PendingOp, 'seq'>)
    this.statusChanged()
    if (!queued) return optimistic // compacted away (e.g. create+delete)
    void this.flush() // background sync; a cheap no-op while offline
    return optimistic
  }

  flush(): Promise<void> {
    if (!this.flushing) {
      this.flushing = this.flushLoop().finally(() => {
        this.flushing = null
        // an op enqueued while the loop was exiting must not be stranded
        if (!this.stopped && this.monitor.online && this.queue.length > 0) void this.flush()
      })
    }
    return this.flushing
  }

  private async flushLoop(): Promise<void> {
    while (!this.stopped && this.monitor.online && this.queue.length > 0) {
      const op = this.queue.peek()!
      const engine = this.engines.get(op.collection)
      if (!engine) {
        this.queue.removeSeq(op.seq)
        continue
      }
      this.inFlightSeq = op.seq
      try {
        await engine.push(op)
        this.queue.removeSeq(op.seq)
        this.monitor.reportSuccess()
      } catch (err) {
        if (isNetworkError(err)) {
          this.monitor.reportFailure()
          break // ops stay queued; they replay when connectivity returns
        }
        // permanent failure (validation, auth, ...) -> rollback and report
        engine.rollback(op)
        this.queue.removeSeq(op.seq)
        this.cfg.onSyncError?.({ collection: op.collection, op: { type: op.type, id: op.id, data: op.data }, error: err })
      } finally {
        this.inFlightSeq = null
        this.statusChanged()
      }
    }
  }

  // -------------------------------------------------------------------------
  // Auth changes
  // -------------------------------------------------------------------------

  private authRecordId(): string | null {
    const record = this.pb.authStore.record as BaseRecord | null | undefined
    return record?.id ?? null
  }

  private async handleAuthChange(): Promise<void> {
    const authId = this.authRecordId()
    if (authId === this.lastAuthId) return // token refresh only
    this.lastAuthId = authId

    // different user (or logout): local cache and unpushed changes belong to
    // the previous identity — drop them and resync under the new identity.
    this.queue.clear()
    for (const engine of this.engines.values()) {
      await engine.stopRealtime()
      await engine.clearLocal()
    }
    this.statusChanged()
    // an auth change usually follows a successful network request, so attempt
    // a resync even if the monitor currently believes we are offline
    if (!this.stopped) {
      void this.initialSync()
    }
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  getStatus(): SyncStatus {
    this.statusDep.depend()
    return {
      online: this.monitor.online,
      syncing: this.syncing,
      pending: this.queue.length,
      lastSyncedAt: this.lastSyncedAt,
    }
  }

  onStatusChange(listener: (status: SyncStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  private statusChanged(): void {
    this.statusDep.notify()
    if (this.statusListeners.size > 0) {
      const status: SyncStatus = {
        online: this.monitor.online,
        syncing: this.syncing,
        pending: this.queue.length,
        lastSyncedAt: this.lastSyncedAt,
      }
      for (const listener of [...this.statusListeners]) listener(status)
    }
  }
}
