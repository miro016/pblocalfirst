import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { memoryPersistence } from '../src/persistence/memory'
import type { PersistenceAdapter } from '../src/persistence/types'
import { FakePb } from './helpers/fakePb'
import { cleanupClients, countRequests, goOffline, makeClient, synced } from './helpers/testClient'

/**
 * Client lifecycle across restarts: cold starts from persisted data, corrupt
 * or failing persistence payloads, namespace isolation, and the gap between
 * the synchronously persisted queue and the debounced data snapshot.
 */

afterEach(() => {
  cleanupClients()
})

/** Wait out the 200ms debounce of the collection data snapshot. */
function dataPersisted(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 250))
}

describe('cold starts', () => {
  it('an offline cold start serves persisted data and cursor without the network', async () => {
    const persistence = memoryPersistence()
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'persisted post' })

    const session1 = makeClient(fake, { persistence })
    await synced(session1, 'posts', 1)
    await dataPersisted()
    session1.destroy()

    fake.online = false
    const session2 = makeClient(fake, { persistence })
    await session2.ready()

    expect((await session2.collection('posts').getOne('p1')).title).toBe('persisted post')
    expect(await session2.collection('posts').getFullList()).toHaveLength(1)
  })

  it('a full restart cycle keeps optimistic edits readable and converges on reconnect', async () => {
    const persistence = memoryPersistence()
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'orig' })

    const session1 = makeClient(fake, { persistence })
    await synced(session1, 'posts', 1)
    await goOffline(fake, session1)
    await session1.collection('posts').update('p1', { title: 'offline edit' })
    await session1.collection('posts').create({ id: 'ppnewaaaaaaaaaa', title: 'offline create' })
    await dataPersisted()
    session1.destroy()

    // still offline: the new session sees the optimistic state immediately
    const session2 = makeClient(fake, { persistence })
    await session2.ready()
    expect((await session2.collection('posts').getOne('p1')).title).toBe('offline edit')
    expect((await session2.collection('posts').getOne('ppnewaaaaaaaaaa')).title).toBe('offline create')
    await vi.waitFor(() => expect(session2.status.pending).toBe(2))

    fake.online = true
    await session2.sync()
    await vi.waitFor(() => expect(session2.status.pending).toBe(0))
    expect(fake.table('posts').get('p1')!.title).toBe('offline edit')
    expect(fake.table('posts').get('ppnewaaaaaaaaaa')!.title).toBe('offline create')
  })

  it('a pending update restored without its data snapshot is reconstructed, not turned into a delete', async () => {
    // The queue persists synchronously but the data snapshot is debounced; if
    // only the queue survives a crash, the update op must be reconstructed
    // from its base + payload instead of being mistaken for a local deletion.
    const source = memoryPersistence()
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'orig', views: 3 })

    const session1 = makeClient(fake, { persistence: source })
    await synced(session1, 'posts', 1)
    await goOffline(fake, session1)
    await session1.collection('posts').update('p1', { title: 'offline edit' })
    session1.destroy()

    // simulate a crash that persisted the queue but not the data snapshot
    const partial = memoryPersistence()
    await partial.save('pblf:queue', await source.load('pblf:queue'))

    fake.online = true
    const session2 = makeClient(fake, { persistence: partial })
    await session2.ready()
    expect(session2.status.pending).toBe(1) // the op survived the restart
    await vi.waitFor(() => expect(session2.status.pending).toBe(0))

    expect(fake.table('posts').get('p1')).toMatchObject({ title: 'offline edit', views: 3 })
    expect((await session2.collection('posts').getOne('p1')).title).toBe('offline edit')
  })

  it('destroy() flushes the debounced data snapshot immediately', async () => {
    const persistence = memoryPersistence()
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'orig' })

    const session1 = makeClient(fake, { persistence })
    await synced(session1, 'posts', 1)
    await goOffline(fake, session1)
    await session1.collection('posts').update('p1', { title: 'edit right before destroy' })
    session1.destroy() // no debounce wait: the snapshot must be flushed here

    const session2 = makeClient(fake, { persistence })
    await session2.ready()
    expect((await session2.collection('posts').getOne('p1')).title).toBe('edit right before destroy')
  })
})

describe('corrupt or failing persistence', () => {
  it('a corrupt data payload is ignored and the client resyncs cleanly', async () => {
    const persistence = memoryPersistence()
    await persistence.save('pblf:data:posts', 'not an object at all')
    await persistence.save('pblf:data:users', 42)

    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'server truth' })
    const lf = makeClient(fake, { persistence })

    await synced(lf, 'posts', 1)
    expect((await lf.collection('posts').getOne('p1')).title).toBe('server truth')
  })

  it('a corrupt queue payload is ignored and the client starts with an empty queue', async () => {
    const persistence = memoryPersistence()
    await persistence.save('pblf:queue', { bogus: true })

    const fake = new FakePb()
    const lf = makeClient(fake, { persistence })
    await synced(lf, 'posts', 0)

    expect(lf.status.pending).toBe(0)
    const record = await lf.collection('posts').create({ title: 'still works' })
    expect(fake.table('posts').has(record.id)).toBe(true)
  })

  it('data loads that reject do not break startup', async () => {
    const inner = memoryPersistence()
    const flaky: PersistenceAdapter = {
      ...inner,
      load: async (key: string) => {
        if (key.includes(':data:')) throw new Error('storage read failed')
        return inner.load(key)
      },
    }

    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'from server' })
    const lf = makeClient(fake, { persistence: flaky })

    await synced(lf, 'posts', 1)
    expect((await lf.collection('posts').getOne('p1')).title).toBe('from server')
  })

  it('saves that reject are swallowed and the client keeps working', async () => {
    const inner = memoryPersistence()
    const readOnly: PersistenceAdapter = {
      ...inner,
      save: async () => {
        throw new Error('quota exceeded')
      },
    }

    const fake = new FakePb()
    const lf = makeClient(fake, { persistence: readOnly })
    await synced(lf, 'posts', 0)

    const record = await lf.collection('posts').create({ title: 'unsaved but synced' })
    expect(fake.table('posts').has(record.id)).toBe(true)
    await dataPersisted() // give the debounced (failing) save a chance to run
    expect(await lf.collection('posts').getFullList()).toHaveLength(1)
  })
})

describe('namespace isolation', () => {
  it('clients with different namespaces on one adapter do not see each other', async () => {
    const persistence = memoryPersistence()
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'shared server' })

    const clientA = makeClient(fake, { persistence, namespace: 'appA' })
    await synced(clientA, 'posts', 1)
    await goOffline(fake, clientA)
    await clientA.collection('posts').update('p1', { title: 'A offline edit' })
    await dataPersisted()
    clientA.destroy()

    // B shares the adapter but not the namespace: no data, no queue
    const clientB = makeClient(fake, { persistence, namespace: 'appB' })
    await clientB.ready()
    expect(clientB.status.pending).toBe(0)
    expect(await clientB.collection('posts').getFullList()).toHaveLength(0)
    clientB.destroy()

    // A restarted under its namespace still has both
    const clientA2 = makeClient(fake, { persistence, namespace: 'appA' })
    await clientA2.ready()
    await vi.waitFor(() => expect(clientA2.status.pending).toBe(1))
    expect((await clientA2.collection('posts').getOne('p1')).title).toBe('A offline edit')
  })
})

describe('indexedDB end-to-end smoke', () => {
  it('create, restart and replay work on the real indexedDB adapter', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'idb orig' })

    const session1 = makeClient(fake, { persistence: 'indexeddb', namespace: 'idbtest' })
    await synced(session1, 'posts', 1)
    await goOffline(fake, session1)
    await session1.collection('posts').update('p1', { title: 'idb offline edit' })
    await dataPersisted()
    session1.destroy()

    const session2 = makeClient(fake, { persistence: 'indexeddb', namespace: 'idbtest' })
    await session2.ready()
    await vi.waitFor(async () => {
      expect((await session2.collection('posts').getOne('p1')).title).toBe('idb offline edit')
    })
    await vi.waitFor(() => expect(session2.status.pending).toBe(1))

    fake.online = true
    await session2.sync()
    await vi.waitFor(() => expect(session2.status.pending).toBe(0))
    expect(fake.table('posts').get('p1')!.title).toBe('idb offline edit')
    expect(countRequests(fake, 'update:posts')).toBe(1)
  })
})
