import type { PersistenceAdapter } from '../persistence/types'
import type { BaseRecord } from '../types'

export interface PendingOp<T extends BaseRecord = BaseRecord> {
  seq: number
  collection: string
  type: 'create' | 'update' | 'delete'
  id: string
  /** Payload to send to the server (merged across compacted updates). */
  data?: Record<string, unknown>
  /** Last version confirmed by the server, for conflict detection and rollback. */
  base?: T | null
  /** Client timestamp of the local change (PocketBase date format) — used by last-update-wins. */
  opTime: string
}

/**
 * Ordered, persisted queue of local writes awaiting confirmation by the
 * server. Global across collections so relation ordering is preserved
 * (a parent created offline is pushed before children referencing it).
 *
 * Consecutive ops on the same record are compacted:
 *   create+update -> create, create+delete -> (dropped),
 *   update+update -> merged update, update+delete -> delete.
 */
export class WriteQueue {
  private ops: PendingOp[] = []
  private nextSeq = 1
  private saveChain: Promise<void> = Promise.resolve()
  private changeListeners = new Set<() => void>()
  /** Set by the SyncManager: ops currently being pushed must not be compacted into. */
  isLocked: (seq: number) => boolean = () => false

  constructor(
    private persistKey: string,
    private persistence: PersistenceAdapter,
  ) {}

  async load(): Promise<void> {
    const saved = (await this.persistence.load(this.persistKey)) as { ops?: PendingOp[]; nextSeq?: number } | undefined
    if (saved?.ops) {
      this.ops = saved.ops
      this.nextSeq = saved.nextSeq ?? (this.ops.length > 0 ? Math.max(...this.ops.map((o) => o.seq)) + 1 : 1)
    }
  }

  get length(): number {
    return this.ops.length
  }

  all(): readonly PendingOp[] {
    return this.ops
  }

  peek(): PendingOp | undefined {
    return this.ops[0]
  }

  /** Latest pending op for a record (the one carrying the current local intent). */
  getForId(collection: string, id: string): PendingOp | undefined {
    for (let i = this.ops.length - 1; i >= 0; i--) {
      const op = this.ops[i]
      if (op.collection === collection && op.id === id) return op
    }
    return undefined
  }

  /**
   * Add an op, compacting against an existing op for the same record.
   * Returns the op that ended up in the queue, or null when the ops
   * cancelled out (create followed by delete).
   */
  enqueue(op: Omit<PendingOp, 'seq'>): PendingOp | null {
    let existingIdx = -1
    for (let i = this.ops.length - 1; i >= 0; i--) {
      const o = this.ops[i]
      if (o.collection === op.collection && o.id === op.id) {
        existingIdx = i
        break
      }
    }
    // never compact into an op that is mid-push; append a follow-up op instead
    if (existingIdx !== -1 && this.isLocked(this.ops[existingIdx].seq)) existingIdx = -1
    if (existingIdx === -1) {
      const full: PendingOp = { ...op, seq: this.nextSeq++ }
      this.ops.push(full)
      this.persist()
      return full
    }

    const existing = this.ops[existingIdx]
    let result: PendingOp | null
    if (existing.type === 'create' && op.type === 'update') {
      result = { ...existing, data: { ...existing.data, ...op.data }, opTime: op.opTime }
    } else if (existing.type === 'create' && op.type === 'delete') {
      result = null // never reached the server; drop both
    } else if (existing.type === 'update' && op.type === 'update') {
      result = { ...existing, data: { ...existing.data, ...op.data }, opTime: op.opTime }
    } else if (existing.type === 'update' && op.type === 'delete') {
      result = { ...existing, type: 'delete', data: undefined, opTime: op.opTime }
    } else if (existing.type === 'delete' && op.type === 'create') {
      // delete not pushed yet + re-create with same id -> becomes an update with full data
      result = { ...existing, type: 'update', data: op.data, opTime: op.opTime }
    } else {
      // shouldn't happen (update/create after delete of same id); append separately
      const full: PendingOp = { ...op, seq: this.nextSeq++ }
      this.ops.push(full)
      this.persist()
      return full
    }

    if (result === null) this.ops.splice(existingIdx, 1)
    else this.ops[existingIdx] = result
    this.persist()
    return result
  }

  /** Replace an op in place (e.g. after conflict resolution rewrote data/base). */
  replace(op: PendingOp): void {
    const idx = this.ops.findIndex((o) => o.seq === op.seq)
    if (idx !== -1) {
      this.ops[idx] = op
      this.persist()
    }
  }

  removeSeq(seq: number): void {
    const idx = this.ops.findIndex((o) => o.seq === seq)
    if (idx !== -1) {
      this.ops.splice(idx, 1)
      this.persist()
    }
  }

  clear(): void {
    this.ops = []
    this.persist()
  }

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  /** Resolves after all pending persistence writes finished (mainly for tests). */
  flushPersistence(): Promise<void> {
    return this.saveChain
  }

  private persist(): void {
    const snapshot = { ops: this.ops.map((o) => ({ ...o })), nextSeq: this.nextSeq }
    this.saveChain = this.saveChain.then(() => this.persistence.save(this.persistKey, snapshot)).catch(() => {})
    for (const listener of [...this.changeListeners]) listener()
  }
}
