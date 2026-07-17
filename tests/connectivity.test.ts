import type PocketBase from 'pocketbase'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OnlineMonitor } from '../src/sync/monitor'
import { FakePb, networkError, validationError } from './helpers/fakePb'
import { cleanupClients, countRequests, goOffline, makeClient, synced } from './helpers/testClient'

/**
 * Connectivity handling: the OnlineMonitor's failure/poll/browser-event
 * transitions, flapping connections during pushes, automatic resync on
 * reconnect and syncAll coalescing.
 */

const monitors: OnlineMonitor[] = []

function makeMonitor(fake: FakePb, pollIntervalMs: number): OnlineMonitor {
  const monitor = new OnlineMonitor(fake as unknown as PocketBase, pollIntervalMs)
  monitors.push(monitor)
  return monitor
}

afterEach(() => {
  while (monitors.length) monitors.pop()!.stop()
  cleanupClients()
  // clean up any window stub installed by a test
  delete (globalThis as Record<string, unknown>).window
})

describe('OnlineMonitor', () => {
  it('reportFailure flips offline; the health poll restores online once the server answers', async () => {
    const fake = new FakePb()
    fake.online = false
    const monitor = makeMonitor(fake, 20)
    monitor.start()

    const transitions: boolean[] = []
    monitor.onChange((online) => transitions.push(online))

    monitor.reportFailure()
    expect(monitor.online).toBe(false)

    // server still down: polling keeps it offline
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(monitor.online).toBe(false)

    fake.online = true
    await vi.waitFor(() => expect(monitor.online).toBe(true))
    expect(transitions).toEqual([false, true])
  })

  it('health polls never overlap even when they are slower than the poll interval', async () => {
    const fake = new FakePb()
    fake.latencyMs = 60
    fake.failNext('health', networkError(), 3) // stay offline through several slow polls
    const monitor = makeMonitor(fake, 15)
    monitor.start()

    let current = 0
    let maxConcurrent = 0
    const original = fake.health.check.bind(fake.health)
    fake.health.check = async (opts?: unknown) => {
      current++
      maxConcurrent = Math.max(maxConcurrent, current)
      try {
        return await original(opts)
      } finally {
        current--
      }
    }

    monitor.reportFailure()
    await vi.waitFor(() => expect(monitor.online).toBe(true), { timeout: 2000 })
    expect(maxConcurrent).toBe(1)
  })

  it('a browser online event triggers a health verification instead of blindly going online', async () => {
    const handlers = new Map<string, () => void>()
    ;(globalThis as Record<string, unknown>).window = {
      addEventListener: (event: string, handler: () => void) => handlers.set(event, handler),
      removeEventListener: (event: string) => handlers.delete(event),
    }

    const fake = new FakePb()
    const monitor = makeMonitor(fake, 3_600_000)
    monitor.start()

    handlers.get('offline')!()
    expect(monitor.online).toBe(false)

    // NIC says up but the server is unreachable: must stay offline
    fake.online = false
    handlers.get('online')!()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(monitor.online).toBe(false)

    fake.online = true
    handlers.get('online')!()
    await vi.waitFor(() => expect(monitor.online).toBe(true))
  })

  it('stop() removes browser listeners and halts polling', async () => {
    const handlers = new Map<string, () => void>()
    ;(globalThis as Record<string, unknown>).window = {
      addEventListener: (event: string, handler: () => void) => handlers.set(event, handler),
      removeEventListener: (event: string) => handlers.delete(event),
    }

    const fake = new FakePb()
    fake.online = false
    const monitor = makeMonitor(fake, 10)
    monitor.start()
    monitor.reportFailure() // polling active
    monitor.stop()

    expect(handlers.size).toBe(0)
    const polls = countRequests(fake, 'health')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(countRequests(fake, 'health')).toBe(polls)
  })
})

describe('flapping connections during pushes', () => {
  it('going offline mid-push resolves the awaited write optimistically and keeps it queued', async () => {
    const fake = new FakePb()
    const lf = makeClient(fake)
    await synced(lf, 'posts', 0)

    fake.latencyMs = 40
    const createPromise = lf.collection('posts').create({ title: 'flappy' })
    await vi.waitFor(() => expect(countRequests(fake, 'create:posts')).toBe(1))
    fake.online = false // connection drops while the create is in flight

    const record = await createPromise
    expect(record.title).toBe('flappy')
    expect(record.id).toMatch(/^[a-z0-9]{15}$/)
    expect(lf.status.pending).toBe(1)
    expect(fake.table('posts').size).toBe(0)
    fake.latencyMs = 0

    // reconnect: the op replays exactly once
    fake.online = true
    await lf.sync()
    await vi.waitFor(() => expect(lf.status.pending).toBe(0))
    expect(fake.table('posts').size).toBe(1)
    expect([...fake.table('posts').values()][0].title).toBe('flappy')
  })

  it('rapid offline/online cycles neither lose nor duplicate queued ops', async () => {
    const fake = new FakePb()
    const lf = makeClient(fake)
    await synced(lf, 'posts', 0)

    await goOffline(fake, lf)
    for (let i = 0; i < 5; i++) {
      await lf.collection('posts').create({ id: `flap${i}aaaaaaaaaa`, title: `post ${i}` })
    }
    expect(lf.status.pending).toBe(5)

    // flap: two failed resyncs interleaved with the real reconnect
    fake.online = true
    await lf.sync()
    fake.online = false
    await lf.sync()
    fake.online = true
    await lf.sync()
    await vi.waitFor(() => expect(lf.status.pending).toBe(0))

    expect(fake.table('posts').size).toBe(5)
    expect(countRequests(fake, 'create:posts')).toBe(5) // each op pushed exactly once
  })
})

describe('automatic resync on reconnect', () => {
  it('the health poll reconnect pushes pending ops without a manual sync()', async () => {
    const fake = new FakePb()
    const lf = makeClient(fake, { healthCheckIntervalMs: 20 })
    await synced(lf, 'posts', 0)

    await goOffline(fake, lf)
    await lf.collection('posts').create({ title: 'queued while offline' })
    expect(lf.status.pending).toBe(1)

    fake.online = true // no manual sync: the poll must pick it up
    await vi.waitFor(() => expect(lf.status.pending).toBe(0), { timeout: 2000 })
    expect(fake.table('posts').size).toBe(1)
  })

  it('missed remote changes are pulled automatically on reconnect', async () => {
    const fake = new FakePb()
    const lf = makeClient(fake, { healthCheckIntervalMs: 20 })
    await synced(lf, 'posts', 0)

    await goOffline(fake, lf)
    fake.serverWrite('posts', { id: 'p1', title: 'written while client offline' })

    fake.online = true
    await synced(lf, 'posts', 1)
  })
})

describe('syncAll coalescing', () => {
  it('concurrent sync() calls coalesce into the running pass plus one queued pass', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'one' })
    const lf = makeClient(fake)
    await synced(lf, 'posts', 1)
    await vi.waitFor(() => expect(lf.status.syncing).toBe(false))

    fake.latencyMs = 30
    const before = fake.requestLog.length
    await Promise.all([lf.sync(), lf.sync(), lf.sync(), lf.sync()])
    fake.latencyMs = 0

    // 4 calls -> exactly 2 reconcile passes (current + one queued)
    const postsScans = fake.requests
      .slice(before)
      .filter((r) => r.what === 'getFullList:posts' && r.options.fields === 'id,updated')
    expect(postsScans).toHaveLength(2)
  })

  it('a queued sync still runs and resolves when the current pass fails hard', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'one' })
    const lf = makeClient(fake)
    await synced(lf, 'posts', 1)
    await vi.waitFor(() => expect(lf.status.syncing).toBe(false))

    fake.latencyMs = 20
    fake.failNext('getFullList:posts', validationError('index scan exploded'))
    const first = lf.sync()
    const second = lf.sync()
    fake.latencyMs = 0

    await expect(first).rejects.toMatchObject({ status: 400 })
    await expect(second).resolves.toBeUndefined()

    // the failure did not poison later syncs
    fake.serverWrite('posts', { id: 'p2', title: 'two' }, { emit: false })
    await lf.sync()
    expect(await lf.collection('posts').getFullList()).toHaveLength(2)
  })
})

describe('offline cold start', () => {
  it('a client constructed while the server is down is readable, queues writes and recovers', async () => {
    const fake = new FakePb()
    fake.online = false
    const lf = makeClient(fake)

    // reads resolve (empty) instead of hanging
    expect(await lf.collection('posts').getFullList()).toEqual([])
    await vi.waitFor(() => expect(lf.status.online).toBe(false))

    const record = await lf.collection('posts').create({ title: 'born offline' })
    expect(lf.status.pending).toBe(1)

    fake.online = true
    await lf.sync()
    await vi.waitFor(() => expect(lf.status.pending).toBe(0))
    expect(fake.table('posts').get(record.id)?.title).toBe('born offline')
  })
})
