import { ClientResponseError } from 'pocketbase'
import type PocketBase from 'pocketbase'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLocalFirst, memoryPersistence, signalReactivity, type LocalFirstClient } from '../src'
import type { RecordSubscription } from '../src/types'
import { FakePb } from './helpers/fakePb'

const clients: LocalFirstClient<any>[] = []

function makeClient(fake: FakePb, extra: Record<string, unknown> = {}) {
  const lf = createLocalFirst({
    pb: fake as unknown as PocketBase,
    collections: {
      posts: { cache: true, relations: { author: 'users' } },
      users: { cache: true },
      logs: {},
    },
    persistence: 'memory',
    reconcileIntervalMs: 0,
    healthCheckIntervalMs: 3_600_000,
    ...extra,
  })
  clients.push(lf)
  return lf
}

afterEach(() => {
  while (clients.length) clients.pop()!.destroy()
})

function seedBlog(fake: FakePb) {
  fake.serverWrite('users', { id: 'u1', name: 'Alice' })
  fake.serverWrite('users', { id: 'u2', name: 'Bob' })
  fake.serverWrite('posts', { id: 'p1', title: 'Alpha', views: 10, published: true, author: 'u1' })
  fake.serverWrite('posts', { id: 'p2', title: 'Beta', views: 5, published: false, author: 'u2' })
  fake.serverWrite('posts', { id: 'p3', title: 'Gamma', views: 30, published: true, author: 'u1' })
}

describe('PocketBase-compatible reads (served from the local db)', () => {
  it('getList returns the SDK result shape with pagination', async () => {
    const fake = new FakePb()
    seedBlog(fake)
    const lf = makeClient(fake)

    const result = await lf.collection('posts').getList(1, 2, { filter: 'published = true', sort: '-views' })
    expect(result).toMatchObject({ page: 1, perPage: 2, totalItems: 2, totalPages: 1 })
    expect(result.items.map((r) => r.title)).toEqual(['Gamma', 'Alpha'])
    expect(fake.requestLog.filter((r) => r === 'getList:posts')).toHaveLength(0) // never hit the server

    const skip = await lf.collection('posts').getList(1, 2, { skipTotal: true })
    expect(skip.totalItems).toBe(-1)
    expect(skip.totalPages).toBe(-1)
  })

  it('local queries return the same results as the same query on the server', async () => {
    const fake = new FakePb({ posts: { author: 'users' } })
    seedBlog(fake)
    const lf = makeClient(fake)
    await lf.collection('posts').getFullList() // wait until synced

    const query = { filter: 'views >= 10 && author.name = "Alice"', sort: '-views,title' }
    const local = await lf.collection('posts').getFullList(query)
    const remote = await fake.collection('posts').getFullList(query)
    expect(local.map((r) => r.id)).toEqual(remote.map((r: any) => r.id))
  })

  it('getFirstListItem returns the first match and throws SDK-shaped 404 otherwise', async () => {
    const fake = new FakePb()
    seedBlog(fake)
    const lf = makeClient(fake)

    const first = await lf.collection('posts').getFirstListItem('published = true', { sort: 'views' })
    expect(first.title).toBe('Alpha')

    const err = await lf.collection('posts').getFirstListItem('views > 999').catch((e) => e)
    expect(err).toBeInstanceOf(ClientResponseError)
    expect(err.status).toBe(404)
  })

  it('getOne supports expand and throws 404 for unknown ids', async () => {
    const fake = new FakePb()
    seedBlog(fake)
    const lf = makeClient(fake)

    const post = await lf.collection('posts').getOne('p1', { expand: 'author' })
    expect((post.expand as any).author.name).toBe('Alice')

    await expect(lf.collection('posts').getOne('missing')).rejects.toMatchObject({ status: 404 })
  })

  it('supports fields selection', async () => {
    const fake = new FakePb()
    seedBlog(fake)
    const lf = makeClient(fake)
    const items = await lf.collection('posts').getFullList({ sort: 'title', fields: 'id,title' })
    expect(items[0]).toEqual({ id: 'p1', title: 'Alpha' })
  })

  it('returned records are copies; mutating them does not corrupt the cache', async () => {
    const fake = new FakePb()
    seedBlog(fake)
    const lf = makeClient(fake)
    const post = await lf.collection('posts').getOne('p1')
    post.title = 'MUTATED'
    expect((await lf.collection('posts').getOne('p1')).title).toBe('Alpha')
  })
})

describe('writes', () => {
  it('create online returns the server record', async () => {
    const fake = new FakePb()
    const lf = makeClient(fake)
    await lf.collection('posts').getFullList()

    const record = await lf.collection('posts').create({ title: 'fresh' })
    expect(record.collectionName).toBe('posts')
    expect(fake.table('posts').get(record.id)?.title).toBe('fresh')
  })

  it('update applies +/- field modifiers optimistically', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'x', views: 10, tags: ['a'] })
    const lf = makeClient(fake)
    await lf.collection('posts').getFullList()

    fake.online = false
    await lf.collection('posts').update('p1', { 'views+': 5, 'tags+': 'b' })
    const local = await lf.collection('posts').getOne('p1')
    expect(local.views).toBe(15)
    expect(local.tags).toEqual(['a', 'b'])
  })

  it('update/delete of unknown records throw 404 like the SDK', async () => {
    const fake = new FakePb()
    const lf = makeClient(fake)
    await lf.collection('posts').getFullList()
    await expect(lf.collection('posts').update('nope', { title: 'x' })).rejects.toMatchObject({ status: 404 })
    await expect(lf.collection('posts').delete('nope')).rejects.toMatchObject({ status: 404 })
  })
})

describe('subscribe (realtime-compatible, driven by the local db)', () => {
  it('emits create/update/delete for local and remote changes', async () => {
    const fake = new FakePb()
    const lf = makeClient(fake)
    await lf.collection('posts').getFullList()

    const events: RecordSubscription<any>[] = []
    await lf.collection('posts').subscribe('*', (e) => events.push(e))

    const created = await lf.collection('posts').create({ title: 'mine' }) // local write
    fake.serverWrite('posts', { id: 'remote1', title: 'theirs' }) // remote realtime
    await vi.waitFor(() => expect(events.filter((e) => e.action === 'create')).toHaveLength(2))

    await lf.collection('posts').delete(created.id)
    await vi.waitFor(() => expect(events.some((e) => e.action === 'delete' && e.record.id === created.id)).toBe(true))
  })

  it('supports topic + filter + expand options', async () => {
    const fake = new FakePb()
    seedBlog(fake)
    const lf = makeClient(fake)
    await lf.collection('posts').getFullList()

    const events: RecordSubscription<any>[] = []
    const unsub = await lf
      .collection('posts')
      .subscribe('p1', (e) => events.push(e), { filter: 'views > 20', expand: 'author' })

    await lf.collection('posts').update('p1', { views: 15 }) // filtered out (<= 20)
    await lf.collection('posts').update('p2', { views: 99 }) // wrong topic
    await lf.collection('posts').update('p1', { views: 25 }) // matches
    await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(1))
    // only the matching change came through (possibly twice: optimistic + server confirm)
    expect(events.every((e) => e.record.id === 'p1' && e.record.views === 25)).toBe(true)
    expect(events[0].record.expand.author.name).toBe('Alice')

    await unsub()
    const countBefore = events.length
    await lf.collection('posts').update('p1', { views: 50 })
    expect(events).toHaveLength(countBefore)
  })
})

describe('reactive reads and live queries', () => {
  it('list()/one()/count() register dependencies through the reactivity adapter', async () => {
    const fake = new FakePb()
    seedBlog(fake)

    // minimal signal runtime: track reads, re-run on notify
    let activeComputation: (() => void) | null = null
    const reactivity = signalReactivity(() => {
      const subscribers = new Set<() => void>()
      return [
        () => {
          if (activeComputation) subscribers.add(activeComputation)
        },
        () => subscribers.forEach((run) => run()),
      ]
    })

    const lf = makeClient(fake, { reactivity })
    await lf.collection('posts').getFullList()

    const seen: number[] = []
    const computation = () => {
      activeComputation = computation
      seen.push(lf.collection('posts').list({ filter: 'published = true' }).length)
      activeComputation = null
    }
    computation()
    expect(seen).toEqual([2])

    await lf.collection('posts').create({ title: 'Delta', published: true })
    await vi.waitFor(() => expect(seen.at(-1)).toBe(3))
  })

  it('liveList recomputes on changes (cached collection)', async () => {
    const fake = new FakePb()
    seedBlog(fake)
    const lf = makeClient(fake)
    await lf.collection('posts').getFullList()

    const live = lf.collection('posts').liveList({ filter: 'published = true', sort: '-views' })
    await vi.waitFor(() => expect(live.value.map((r: any) => r.title)).toEqual(['Gamma', 'Alpha']))

    fake.serverWrite('posts', { id: 'p9', title: 'Zeta', views: 99, published: true })
    await vi.waitFor(() => expect(live.value.map((r: any) => r.title)).toEqual(['Zeta', 'Gamma', 'Alpha']))
    live.dispose()
  })

  it('liveList refetches on realtime events (non-cached collection)', async () => {
    const fake = new FakePb()
    fake.serverWrite('logs', { id: 'l1', msg: 'first' })
    const lf = makeClient(fake)

    const live = lf.collection('logs').liveList({ sort: 'id' })
    await vi.waitFor(() => expect(live.value).toHaveLength(1))

    fake.serverWrite('logs', { id: 'l2', msg: 'second' })
    await vi.waitFor(() => expect(live.value).toHaveLength(2))
    live.dispose()
  })

  it('reactive reads on non-cached collections fail with a helpful error', async () => {
    const fake = new FakePb()
    const lf = makeClient(fake)
    expect(() => lf.collection('logs').list()).toThrow(/cache: true/)
  })
})

describe('non-cached passthrough', () => {
  it('routes all calls to the server', async () => {
    const fake = new FakePb()
    fake.serverWrite('logs', { id: 'l1', msg: 'hi' })
    const lf = makeClient(fake)

    const list = await lf.collection('logs').getList(1, 10)
    expect(list.totalItems).toBe(1)
    expect(fake.requestLog).toContain('getList:logs')

    await lf.collection('logs').create({ msg: 'new' })
    expect(fake.table('logs').size).toBe(2)
  })

  it('unknown collections behave like the plain SDK', async () => {
    const fake = new FakePb()
    fake.serverWrite('anything', { id: 'a1' })
    const lf = makeClient(fake)
    expect(await lf.collection('anything').getFullList()).toHaveLength(1)
  })
})

describe('offline cold start', () => {
  it('serves persisted data instantly when starting offline', async () => {
    const fake = new FakePb()
    seedBlog(fake)
    const persistence = memoryPersistence()

    const first = makeClient(fake, { persistence })
    await first.collection('posts').getFullList()
    await vi.waitFor(async () => {
      // wait for debounced persistence flush
      expect(((await persistence.load('pblf:data:posts')) as any)?.records?.length).toBe(3)
    })
    first.destroy()
    clients.pop()

    fake.online = false
    const second = makeClient(fake, { persistence })
    const items = await second.collection('posts').getFullList({ sort: 'title' })
    expect(items.map((r) => r.title)).toEqual(['Alpha', 'Beta', 'Gamma'])
  })
})
