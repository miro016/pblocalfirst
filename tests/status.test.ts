import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactivityAdapter } from '../src/reactivity'
import type { SyncErrorInfo, SyncStatus } from '../src/types'
import { FakePb, validationError } from './helpers/fakePb'
import { cleanupClients, countRequests, goOffline, makeClient, synced } from './helpers/testClient'

/**
 * Observability: status transitions across the sync lifecycle, error
 * reporting semantics (awaited rejection vs onSyncError), ready()/readable
 * gating and reactive status dependencies.
 */

afterEach(() => {
  cleanupClients()
})

describe('status lifecycle', () => {
  it('walks through syncing/offline/pending/online transitions coherently', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'one' })
    const lf = makeClient(fake)
    const snapshots: SyncStatus[] = []
    lf.onStatusChange((status) => snapshots.push({ ...status }))

    await synced(lf, 'posts', 1)
    await vi.waitFor(() => expect(lf.status.lastSyncedAt).toBeGreaterThan(0))
    const firstSyncedAt = lf.status.lastSyncedAt

    await goOffline(fake, lf)
    await lf.collection('posts').update('p1', { title: 'offline edit' })
    expect(lf.status).toMatchObject({ online: false, pending: 1 })

    fake.online = true
    await lf.sync()
    await vi.waitFor(() => expect(lf.status).toMatchObject({ online: true, pending: 0, syncing: false }))
    expect(lf.status.lastSyncedAt).toBeGreaterThanOrEqual(firstSyncedAt)

    // the listener saw the full journey
    expect(snapshots.some((s) => s.syncing)).toBe(true)
    expect(snapshots.some((s) => !s.online)).toBe(true)
    expect(snapshots.some((s) => s.pending === 1)).toBe(true)
    const last = snapshots[snapshots.length - 1]
    expect(last).toMatchObject({ online: true, pending: 0, syncing: false })
  })

  it('reports syncing=true while a slow reconcile is running', async () => {
    const fake = new FakePb()
    const lf = makeClient(fake)
    await synced(lf, 'posts', 0)
    await vi.waitFor(() => expect(lf.status.syncing).toBe(false))

    fake.latencyMs = 50
    const syncPromise = lf.sync()
    await vi.waitFor(() => expect(lf.status.syncing).toBe(true))
    await syncPromise
    fake.latencyMs = 0
    expect(lf.status.syncing).toBe(false)
  })

  it('unsubscribing a status listener stops its notifications', async () => {
    const fake = new FakePb()
    const lf = makeClient(fake)
    await synced(lf, 'posts', 0)

    let calls = 0
    const unsub = lf.onStatusChange(() => calls++)
    await lf.collection('posts').create({ title: 'one' })
    await vi.waitFor(() => expect(calls).toBeGreaterThan(0))

    unsub()
    const frozen = calls
    await lf.collection('posts').create({ title: 'two' })
    await vi.waitFor(() => expect(lf.status.pending).toBe(0))
    expect(calls).toBe(frozen)
  })
})

describe('error reporting semantics', () => {
  it('awaited ops reject the caller and do NOT fire onSyncError', async () => {
    const fake = new FakePb()
    const errors: SyncErrorInfo[] = []
    const lf = makeClient(fake, { onSyncError: (info: SyncErrorInfo) => errors.push(info) })
    await synced(lf, 'posts', 0)

    fake.failWrites = validationError('rejected online')
    await expect(lf.collection('posts').create({ title: 'bad' })).rejects.toMatchObject({ status: 400 })
    fake.failWrites = null

    expect(errors).toHaveLength(0)
  })

  it('queued (offline) ops fire onSyncError with the full payload on replay failure', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'orig' })
    const errors: SyncErrorInfo[] = []
    const lf = makeClient(fake, { onSyncError: (info: SyncErrorInfo) => errors.push(info) })
    await synced(lf, 'posts', 1)

    await goOffline(fake, lf)
    await lf.collection('posts').update('p1', { title: 'doomed' })

    fake.failNext('update:posts', validationError('rejected on replay'))
    fake.online = true
    await lf.sync()
    await vi.waitFor(() => expect(errors).toHaveLength(1))

    expect(errors[0].collection).toBe('posts')
    expect(errors[0].op).toMatchObject({ type: 'update', id: 'p1', data: { title: 'doomed' } })
    expect(errors[0].error).toMatchObject({ status: 400 })
  })
})

describe('ready() and read gating', () => {
  it('ready() resolves after the persisted load, before the first network sync finishes', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'one' })
    fake.latencyMs = 80
    const lf = makeClient(fake)

    await lf.ready()
    // the initial sync is still in flight
    expect(lf.status.lastSyncedAt).toBe(0)
    fake.latencyMs = 0
    await synced(lf, 'posts', 1)
  })

  it('reads issued during a slow initial sync wait for it instead of answering empty', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'one' })
    fake.serverWrite('posts', { id: 'p2', title: 'two' })
    fake.latencyMs = 60
    const lf = makeClient(fake)

    // issued immediately after construction: must NOT return []
    const items = await lf.collection('posts').getFullList()
    fake.latencyMs = 0
    expect(items).toHaveLength(2)
  })
})

describe('reactive status', () => {
  it('getStatus registers a dependency and notifies on queue and sync changes', async () => {
    const depend = vi.fn()
    const notify = vi.fn()
    const reactivity: ReactivityAdapter = {
      create: () => ({ depend, notify }),
      isInScope: () => true,
    }

    const fake = new FakePb()
    const lf = makeClient(fake, { reactivity })
    await synced(lf, 'posts', 0)

    void lf.status
    expect(depend).toHaveBeenCalled()

    const before = notify.mock.calls.length
    await lf.collection('posts').create({ title: 'trigger' })
    await vi.waitFor(() => expect(lf.status.pending).toBe(0))
    expect(notify.mock.calls.length).toBeGreaterThan(before)
  })
})

describe('destroy()', () => {
  it('stops all network activity and realtime application', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'one' })
    const lf = makeClient(fake, { healthCheckIntervalMs: 20, reconcileIntervalMs: 30 })
    await synced(lf, 'posts', 1)

    lf.destroy()
    const frozen = fake.requestLog.length

    fake.serverWrite('posts', { id: 'p1', title: 'after destroy' })
    await new Promise((resolve) => setTimeout(resolve, 120))

    expect(fake.requestLog.length).toBe(frozen)
    // the realtime subscription was torn down: the local copy did not change
    expect((await lf.collection('posts').getOne('p1')).title).toBe('one')
  })

  it('local data stays readable after destroy', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'kept' })
    const lf = makeClient(fake)
    await synced(lf, 'posts', 1)

    lf.destroy()
    expect((await lf.collection('posts').getOne('p1')).title).toBe('kept')
    expect(countRequests(fake, 'getOne:posts')).toBe(0)
  })
})
