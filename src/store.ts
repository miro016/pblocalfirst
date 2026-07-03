import type { ReactiveDependency, ReactivityAdapter } from './reactivity'
import type { BaseRecord, RecordSubscription } from './types'
import { deepEqual } from './utils'

export type ChangeListener<T extends BaseRecord> = (events: RecordSubscription<T>[]) => void

/**
 * In-memory, reactive record store for one cached collection. Change events
 * are batched (one notification per mutation batch, e.g. per sync pass) and
 * feed both the reactivity adapter (signals) and callback subscribers.
 */
export class CollectionStore<T extends BaseRecord = BaseRecord> {
  private map = new Map<string, T>()
  private listeners = new Set<ChangeListener<T>>()
  private dep: ReactiveDependency
  private batchDepth = 0
  private batchedEvents: RecordSubscription<T>[] = []

  constructor(
    public readonly name: string,
    reactivity: ReactivityAdapter,
  ) {
    this.dep = reactivity.create()
  }

  /** Reactive read of all records (registers a dependency in reactive scopes). */
  getAll(): T[] {
    this.dep.depend()
    return [...this.map.values()]
  }

  /** Reactive read of one record. */
  get(id: string): T | undefined {
    this.dep.depend()
    return this.map.get(id)
  }

  /** Non-reactive reads (used internally by the query engine to avoid double registration). */
  peekAll(): T[] {
    return [...this.map.values()]
  }

  peek(id: string): T | undefined {
    return this.map.get(id)
  }

  get size(): number {
    return this.map.size
  }

  upsert(record: T): void {
    const existing = this.map.get(record.id)
    if (existing && deepEqual(existing, record)) return // suppress no-op churn (e.g. server echoes)
    this.map.set(record.id, record)
    this.emit({ action: existing ? 'update' : 'create', record })
  }

  remove(id: string): void {
    const record = this.map.get(id)
    if (!record) return
    this.map.delete(id)
    this.emit({ action: 'delete', record })
  }

  replaceAll(records: T[]): void {
    this.batch(() => {
      const incoming = new Set(records.map((r) => r.id))
      for (const id of [...this.map.keys()]) {
        if (!incoming.has(id)) this.remove(id)
      }
      for (const record of records) this.upsert(record)
    })
  }

  /** Group multiple mutations into a single notification. */
  batch(fn: () => void): void {
    this.batchDepth++
    try {
      fn()
    } finally {
      this.batchDepth--
      if (this.batchDepth === 0 && this.batchedEvents.length > 0) {
        const events = this.batchedEvents
        this.batchedEvents = []
        this.notify(events)
      }
    }
  }

  onChange(listener: ChangeListener<T>): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: RecordSubscription<T>): void {
    if (this.batchDepth > 0) {
      this.batchedEvents.push(event)
      return
    }
    this.notify([event])
  }

  private notify(events: RecordSubscription<T>[]): void {
    this.dep.notify()
    for (const listener of [...this.listeners]) listener(events)
  }
}
