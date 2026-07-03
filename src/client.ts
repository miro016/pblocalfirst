import type PocketBase from 'pocketbase'
import { LocalFirstCollection } from './collection'
import { defaultPersistence, indexedDBPersistence } from './persistence/indexeddb'
import { localStoragePersistence } from './persistence/localstorage'
import { memoryPersistence } from './persistence/memory'
import type { PersistenceAdapter } from './persistence/types'
import { interpolateFilter, type EvalContext } from './query/filter'
import { noopReactivity, type ReactivityAdapter } from './reactivity'
import { CollectionStore } from './store'
import { SyncManager } from './sync/engine'
import { WriteQueue } from './sync/queue'
import type { BaseRecord, LocalFirstConfig, SchemaDef, SyncStatus } from './types'

function resolvePersistence(option: LocalFirstConfig['persistence']): PersistenceAdapter {
  if (!option) return defaultPersistence()
  if (option === 'indexeddb') return indexedDBPersistence()
  if (option === 'localstorage') return localStoragePersistence()
  if (option === 'memory') return memoryPersistence()
  return option
}

/**
 * The local-first PocketBase client. Usage mirrors the PocketBase JS SDK:
 *
 * ```ts
 * const lf = createLocalFirst<CollectionResponses>({
 *   pb,
 *   collections: {
 *     posts: { cache: true, relations: { author: 'users' } },
 *     users: { cache: true },
 *     audit_logs: {}, // not cached -> passthrough to the server
 *   },
 * })
 * const posts = await lf.collection('posts').getList(1, 20, { filter: 'published = true', sort: '-created', expand: 'author' })
 * ```
 */
export class LocalFirstClient<S extends SchemaDef = SchemaDef> {
  readonly pb: PocketBase
  private stores = new Map<string, CollectionStore<any>>()
  private collections = new Map<string, LocalFirstCollection<any>>()
  private manager: SyncManager
  private collectionDeps: {
    pb: PocketBase
    evalCtx: EvalContext
    reactivity: ReactivityAdapter
    subscribeAllStores(listener: () => void): () => void
    allReadable(): Promise<void>
  }

  constructor(private config: LocalFirstConfig<S>) {
    this.pb = config.pb
    const reactivity = config.reactivity ?? noopReactivity
    const namespace = config.namespace ?? 'pblf'
    const persistence = resolvePersistence(config.persistence)
    const queue = new WriteQueue(`${namespace}:queue`, persistence)

    this.manager = new SyncManager(config.pb, queue, persistence, reactivity, {
      namespace,
      reconcileIntervalMs: config.reconcileIntervalMs ?? 300_000,
      healthCheckIntervalMs: config.healthCheckIntervalMs ?? 10_000,
      conflictResolver: config.conflictResolver,
      onSyncError: config.onSyncError,
    })

    const evalCtx: EvalContext = {
      getRelations: (collection) => (this.config.collections as Record<string, any>)[collection]?.relations,
      getAll: (collection) => this.stores.get(collection)?.getAll(),
      getById: (collection, id) => this.stores.get(collection)?.get(id),
    }

    this.collectionDeps = {
      pb: config.pb,
      evalCtx,
      reactivity,
      subscribeAllStores: (listener) => {
        const unsubs = [...this.stores.values()].map((store) => store.onChange(listener))
        return () => unsubs.forEach((unsub) => unsub())
      },
      allReadable: async () => {
        await Promise.all([...this.manager.engines.values()].map((engine) => engine.readable))
      },
    }

    for (const [name, collectionConfig] of Object.entries(config.collections as Record<string, any>)) {
      if (collectionConfig?.cache) {
        const store = new CollectionStore<BaseRecord>(name, reactivity)
        this.stores.set(name, store)
        const engine = this.manager.registerCollection(name, collectionConfig, store)
        this.collections.set(name, new LocalFirstCollection(name, this.collectionDeps, store, engine, this.manager))
      } else {
        this.collections.set(name, new LocalFirstCollection(name, this.collectionDeps))
      }
    }

    if (config.autoStart !== false) void this.start()
  }

  /** Typed accessor, mirroring `pb.collection(name)`. */
  collection<K extends keyof S & string>(name: K): LocalFirstCollection<S[K]>
  collection(name: string): LocalFirstCollection<BaseRecord>
  collection(name: string): LocalFirstCollection<any> {
    let collection = this.collections.get(name)
    if (!collection) {
      // unknown collections behave like the plain SDK (remote passthrough)
      collection = new LocalFirstCollection(name, this.collectionDeps)
      this.collections.set(name, collection)
    }
    return collection
  }

  /** Begin syncing (called automatically unless `autoStart: false`). */
  start(): Promise<void> {
    return this.manager.start()
  }

  /** Resolves once persisted local data has been loaded (before the first network sync). */
  ready(): Promise<void> {
    return this.manager.ready
  }

  /** Force a full sync now: pull remote changes and push pending local writes. */
  async sync(): Promise<void> {
    await this.manager.syncAll()
    await this.manager.flush()
  }

  /** Reactive sync status (registers a dependency in reactive scopes). */
  get status(): SyncStatus {
    return this.manager.getStatus()
  }

  onStatusChange(listener: (status: SyncStatus) => void): () => void {
    return this.manager.onStatusChange(listener)
  }

  /** Safe filter interpolation, compatible with `pb.filter("a = {:v}", { v })`. */
  filter(raw: string, params?: Record<string, unknown>): string {
    return interpolateFilter(raw, params)
  }

  /** Stop syncing and release timers/subscriptions. Local data stays persisted. */
  destroy(): void {
    this.manager.stop()
  }
}

export function createLocalFirst<S extends SchemaDef = SchemaDef>(config: LocalFirstConfig<S>): LocalFirstClient<S> {
  return new LocalFirstClient<S>(config)
}
