import { afterEach, describe, expect, it, vi } from 'vitest'
import { memoryPersistence } from '../src/persistence/memory'
import type { BaseRecord } from '../src/types'
import { FakePb } from './helpers/fakePb'
import { cleanupClients, engine, goOffline, makeClient, manager, settled, synced } from './helpers/testClient'

/**
 * Internals of the pull side: cursor semantics of pullDelta, the reconcile
 * index scan, its delete detection, the full-refetch-vs-chunked heuristic and
 * the interaction with a server-side sync filter.
 */

afterEach(() => {
  cleanupClients()
})

function seed(count: number, prefix = 'p'): Array<{ id: string; title: string }> {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}${String(i).padStart(4, '0')}`, title: `t${i}` }))
}

function indexScans(fake: FakePb, since = 0) {
  return fake.requests.slice(since).filter((r) => r.what === 'getFullList:posts' && r.options.fields === 'id,updated')
}

function dataFetches(fake: FakePb, since = 0) {
  return fake.requests.slice(since).filter((r) => r.what === 'getFullList:posts' && r.options.fields !== 'id,updated')
}

describe('pullDelta and the cursor', () => {
  it('falls back to a full reconcile when there is no cursor yet', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'one' })
    const lf = makeClient(fake, { autoStart: false })

    await engine(lf, 'posts').pullDelta()

    expect(indexScans(fake)).toHaveLength(1)
    expect((engine(lf, 'posts') as unknown as { cursor: string }).cursor).toBe(fake.table('posts').get('p1')!.updated)
  })

  it('re-fetches the >= cursor boundary record idempotently (no local churn)', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'one' })
    const lf = makeClient(fake)
    await synced(lf, 'posts', 1)
    const cursor = (engine(lf, 'posts') as unknown as { cursor: string }).cursor

    const events: unknown[] = []
    await lf.collection('posts').subscribe('*', (e) => events.push(e))

    const before = fake.requests.length
    await engine(lf, 'posts').pullDelta()

    const pulls = dataFetches(fake, before)
    expect(pulls).toHaveLength(1)
    expect(pulls[0].options.filter).toBe(`updated >= "${cursor}"`)
    // the boundary record came back unchanged: the store suppresses the no-op
    expect(events).toHaveLength(0)
    expect(await lf.collection('posts').getFullList()).toHaveLength(1)
  })

  it('keeps records that share the exact cursor timestamp', async () => {
    const fake = new FakePb()
    fake.bulkServerWrite('posts', seed(3), { sameTimestamp: true })
    const lf = makeClient(fake)
    await synced(lf, 'posts', 3)

    // a fourth record lands with the same timestamp as the cursor
    const cursor = (engine(lf, 'posts') as unknown as { cursor: string }).cursor
    fake.serverWrite('posts', { id: 'p9999', title: 'boundary sibling' }, { emit: false, updated: cursor })

    await engine(lf, 'posts').pullDelta()
    expect(await lf.collection('posts').getFullList()).toHaveLength(4)
  })

  it('a realtime event advances the cursor so pullDelta stays cheap', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'one' })
    const lf = makeClient(fake)
    await synced(lf, 'posts', 1)

    const updated = fake.serverWrite('posts', { id: 'p2', title: 'via realtime' }).updated!
    await synced(lf, 'posts', 2)
    expect((engine(lf, 'posts') as unknown as { cursor: string }).cursor).toBe(updated)
  })

  it('the cursor is persisted together with the records', async () => {
    const persistence = memoryPersistence()
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'one' })
    const lf = makeClient(fake, { persistence })
    await synced(lf, 'posts', 1)

    // data saves are debounced by 200ms
    await vi.waitFor(async () => {
      const saved = (await persistence.load('pblf:data:posts')) as { records: BaseRecord[]; cursor: string } | undefined
      expect(saved?.records).toHaveLength(1)
      expect(saved?.cursor).toBe(fake.table('posts').get('p1')!.updated)
    })
  })
})

describe('reconcile fetch strategy (>300 and >half heuristic)', () => {
  it('301 changed of 400 records: refetches everything in one query', async () => {
    const fake = new FakePb()
    fake.bulkServerWrite('posts', seed(400))
    const lf = makeClient(fake)
    await synced(lf, 'posts', 400)

    fake.bulkServerWrite('posts', seed(301).map((r) => ({ ...r, title: 'changed' })))
    const before = fake.requests.length
    await lf.sync()

    const fetches = dataFetches(fake, before)
    expect(fetches).toHaveLength(1)
    expect(fetches[0].options.filter).toBeUndefined()
  })

  it('300 changed of 400 records: fetches 3 id-chunks (not >300)', async () => {
    const fake = new FakePb()
    fake.bulkServerWrite('posts', seed(400))
    const lf = makeClient(fake)
    await synced(lf, 'posts', 400)

    fake.bulkServerWrite('posts', seed(300).map((r) => ({ ...r, title: 'changed' })))
    const before = fake.requests.length
    await lf.sync()

    const fetches = dataFetches(fake, before)
    expect(fetches).toHaveLength(3)
    for (const fetch of fetches) {
      expect(String(fetch.options.filter)).toMatch(/^id="/)
    }
  })

  it('301 changed of 700 records: fetches 4 id-chunks of 100/100/100/1 (not >half)', async () => {
    const fake = new FakePb()
    fake.bulkServerWrite('posts', seed(700))
    const lf = makeClient(fake)
    await synced(lf, 'posts', 700)

    fake.bulkServerWrite('posts', seed(301).map((r) => ({ ...r, title: 'changed' })))
    const before = fake.requests.length
    await lf.sync()

    const fetches = dataFetches(fake, before)
    const chunkSizes = fetches.map((f) => String(f.options.filter).split(' || ').length)
    expect(chunkSizes).toEqual([100, 100, 100, 1])
    expect((await lf.collection('posts').getOne('p0300')).title).toBe('changed')
    expect((await lf.collection('posts').getOne('p0301')).title).toBe('t301')
  })
})

describe('reconcile and pending local ops', () => {
  it('does not treat a pending local create as remotely deleted', async () => {
    const fake = new FakePb()
    const lf = makeClient(fake)
    await synced(lf, 'posts', 0)

    await goOffline(fake, lf)
    const created = await lf.collection('posts').create({ title: 'not on the server yet' })

    fake.online = true
    // reconcile alone (no flush): the optimistic record must survive
    await engine(lf, 'posts').reconcile()

    expect((await lf.collection('posts').getOne(created.id)).title).toBe('not on the server yet')
    expect(lf.status.pending).toBe(1)
  })

  it('skips refetching a record whose pending base still matches the remote version', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'orig' })
    const lf = makeClient(fake)
    await synced(lf, 'posts', 1)

    await goOffline(fake, lf)
    await lf.collection('posts').update('p1', { title: 'local edit' })

    fake.online = true
    const before = fake.requests.length
    await engine(lf, 'posts').reconcile()

    // no server change since our base -> only the index scan, no data fetch,
    // and the optimistic edit is untouched
    expect(indexScans(fake, before)).toHaveLength(1)
    expect(dataFetches(fake, before)).toHaveLength(0)
    expect((await lf.collection('posts').getOne('p1')).title).toBe('local edit')
  })

  it('is idempotent: a second reconcile right after performs only the index scan', async () => {
    const fake = new FakePb()
    fake.bulkServerWrite('posts', seed(10))
    const lf = makeClient(fake)
    await synced(lf, 'posts', 10)

    const before = fake.requests.length
    await engine(lf, 'posts').reconcile()

    expect(indexScans(fake, before)).toHaveLength(1)
    expect(dataFetches(fake, before)).toHaveLength(0)
  })
})

describe('sync.filter (server-side scoping)', () => {
  function makeFilteredClient(fake: FakePb) {
    return makeClient(fake, {
      collections: {
        posts: { cache: true, sync: { filter: 'published = true' } },
        users: { cache: true },
      },
    })
  }

  it('only records matching the filter are pulled', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'pub', published: true })
    fake.serverWrite('posts', { id: 'p2', title: 'draft', published: false })
    const lf = makeFilteredClient(fake)

    await synced(lf, 'posts', 1)
    expect((await lf.collection('posts').getFullList())[0].id).toBe('p1')
  })

  it('a record silently leaving the filter window is removed on the next reconcile', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'pub', published: true })
    const lf = makeFilteredClient(fake)
    await synced(lf, 'posts', 1)

    fake.serverWrite('posts', { id: 'p1', published: false }, { emit: false })
    await lf.sync()

    expect(await lf.collection('posts').getFullList()).toHaveLength(0)
    // the record still exists on the server; only the local mirror dropped it
    expect(fake.table('posts').has('p1')).toBe(true)
  })

  it('a record entering the filter window appears on the next reconcile', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'draft', published: false })
    const lf = makeFilteredClient(fake)
    await synced(lf, 'posts', 0)

    fake.serverWrite('posts', { id: 'p1', published: true }, { emit: false })
    await lf.sync()

    expect(await lf.collection('posts').getFullList()).toHaveLength(1)
  })

  it('pullDelta AND-combines the sync filter with the cursor filter', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'pub', published: true })
    const lf = makeFilteredClient(fake)
    await synced(lf, 'posts', 1)
    const cursor = (engine(lf, 'posts') as unknown as { cursor: string }).cursor

    const before = fake.requests.length
    await engine(lf, 'posts').pullDelta()

    const pulls = dataFetches(fake, before)
    expect(pulls).toHaveLength(1)
    expect(pulls[0].options.filter).toBe(`(published = true) && (updated >= "${cursor}")`)
  })

  it('realtime events are scoped by the sync filter', async () => {
    const fake = new FakePb()
    const lf = makeFilteredClient(fake)
    await synced(lf, 'posts', 0)
    await settled(lf)

    fake.serverWrite('posts', { id: 'p1', title: 'pub', published: true })
    fake.serverWrite('posts', { id: 'p2', title: 'draft', published: false })

    await synced(lf, 'posts', 1)
    expect((await lf.collection('posts').getFullList())[0].id).toBe('p1')
  })
})

describe('unknown-collection queue entries', () => {
  it('the reconcile pass leaves queued ops of other collections untouched', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'one' })
    const lf = makeClient(fake)
    await synced(lf, 'posts', 1)

    await goOffline(fake, lf)
    await lf.collection('users').create({ name: 'pending user' })

    fake.online = true
    await engine(lf, 'posts').reconcile()

    expect(manager(lf).queue.length).toBe(1)
    expect(manager(lf).queue.peek()!.collection).toBe('users')
  })
})
