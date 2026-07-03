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
 */

export function networkError(): ClientResponseError {
  return new ClientResponseError({ url: '', status: 0, response: {}, originalError: new Error('network down') })
}

export function validationError(message = 'Failed to create record.'): ClientResponseError {
  return new ClientResponseError({ url: '', status: 400, response: { code: 400, message, data: {} } })
}

function notFound(): ClientResponseError {
  return new ClientResponseError({ url: '', status: 404, response: { code: 404, message: 'Not found.', data: {} } })
}

type Subscriber = { topic: string; cb: (e: { action: string; record: BaseRecord }) => void; filter?: string }

export class FakePb {
  online = true
  /** When set, all writes throw this error (for rollback tests). */
  failWrites: Error | null = null
  /** Server clock; tests can move it into the future to control last-update-wins outcomes. */
  clockMs = Date.parse('2024-01-01T00:00:00.000Z')
  private data = new Map<string, Map<string, BaseRecord>>()
  private subscribers = new Map<string, Subscriber[]>()
  private authListeners: Array<() => void> = []
  requestLog: string[] = []

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
      if (!this.online) throw networkError()
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

  table(name: string): Map<string, BaseRecord> {
    let t = this.data.get(name)
    if (!t) {
      t = new Map()
      this.data.set(name, t)
    }
    return t
  }

  /** Seed a record directly ("another client wrote this"), emitting realtime events. */
  serverWrite(collection: string, record: Partial<BaseRecord> & { id: string }): BaseRecord {
    const table = this.table(collection)
    const existing = table.get(record.id)
    const now = this.tick()
    const full: BaseRecord = existing
      ? { ...existing, ...record, updated: now }
      : { created: now, updated: now, collectionName: collection, ...record }
    table.set(record.id, full)
    this.emit(collection, existing ? 'update' : 'create', full)
    return full
  }

  serverDelete(collection: string, id: string): void {
    const table = this.table(collection)
    const record = table.get(id)
    if (!record) return
    table.delete(id)
    this.emit(collection, 'delete', record)
  }

  private emit(collection: string, action: string, record: BaseRecord): void {
    if (!this.online) return // a disconnected client receives no realtime events
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

  private guard(what: string): void {
    this.requestLog.push(what)
    if (!this.online) throw networkError()
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
        this.guard(`getFullList:${name}`)
        return query(options)
      },
      getList: async (page = 1, perPage = 30, options: Record<string, unknown> = {}) => {
        this.guard(`getList:${name}`)
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
        this.guard(`getFirstListItem:${name}`)
        const all = query({ ...options, filter })
        if (all.length === 0) throw notFound()
        return all[0]
      },
      getOne: async (id: string, _options: Record<string, unknown> = {}) => {
        this.guard(`getOne:${name}`)
        const record = table().get(id)
        if (!record) throw notFound()
        return { ...record }
      },
      create: async (body: Record<string, unknown>, _options: Record<string, unknown> = {}) => {
        this.guard(`create:${name}`)
        if (this.failWrites) throw this.failWrites
        const id = (body.id as string) || Math.random().toString(36).slice(2, 17)
        if (table().has(id)) throw validationError('Record id already exists.')
        const now = this.tick()
        const record: BaseRecord = { ...body, id, created: now, updated: now, collectionName: name }
        table().set(id, record)
        this.emit(name, 'create', record)
        return { ...record }
      },
      update: async (id: string, body: Record<string, unknown>, _options: Record<string, unknown> = {}) => {
        this.guard(`update:${name}`)
        if (this.failWrites) throw this.failWrites
        const existing = table().get(id)
        if (!existing) throw notFound()
        const record: BaseRecord = { ...existing, ...body, id, updated: this.tick() }
        table().set(id, record)
        this.emit(name, 'update', record)
        return { ...record }
      },
      delete: async (id: string, _options: Record<string, unknown> = {}) => {
        this.guard(`delete:${name}`)
        if (this.failWrites) throw this.failWrites
        const existing = table().get(id)
        if (!existing) throw notFound()
        table().delete(id)
        this.emit(name, 'delete', existing)
        return true
      },
      subscribe: async (topic: string, cb: Subscriber['cb'], options: Record<string, unknown> = {}) => {
        this.guard(`subscribe:${name}`)
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
