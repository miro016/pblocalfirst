import type PocketBase from 'pocketbase'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLocalFirst, type LocalFirstClient } from '../src'
import type { SyncErrorInfo } from '../src/types'
import { FakePb, validationError } from './helpers/fakePb'

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

async function synced(lf: LocalFirstClient<any>, collection: string, count: number) {
  await vi.waitFor(async () => {
    const items = await lf.collection(collection).getFullList()
    expect(items).toHaveLength(count)
  })
}

describe('initial sync + realtime', () => {
  it('pulls existing remote records into the local db', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'one' })
    fake.serverWrite('posts', { id: 'p2', title: 'two' })

    const lf = makeClient(fake)
    await synced(lf, 'posts', 2)
    expect((await lf.collection('posts').getOne('p1')).title).toBe('one')
  })

  it('applies remote realtime create/update/delete live', async () => {
    const fake = new FakePb()
    const lf = makeClient(fake)
    await synced(lf, 'posts', 0)

    fake.serverWrite('posts', { id: 'p1', title: 'live' })
    await synced(lf, 'posts', 1)

    fake.serverWrite('posts', { id: 'p1', title: 'edited' })
    await vi.waitFor(async () => {
      expect((await lf.collection('posts').getOne('p1')).title).toBe('edited')
    })

    fake.serverDelete('posts', 'p1')
    await synced(lf, 'posts', 0)
  })

  it('reconcile catches deletes and edits missed while offline', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'one' })
    fake.serverWrite('posts', { id: 'p2', title: 'two' })
    const lf = makeClient(fake)
    await synced(lf, 'posts', 2)

    fake.online = false
    fake.serverDelete('posts', 'p2')
    fake.serverWrite('posts', { id: 'p1', title: 'changed while away' })
    fake.serverWrite('posts', { id: 'p3', title: 'new while away' })

    fake.online = true
    await lf.sync()

    const items = await lf.collection('posts').getFullList({ sort: 'id' })
    expect(items.map((r) => r.id)).toEqual(['p1', 'p3'])
    expect(items[0].title).toBe('changed while away')
  })
})

describe('offline writes', () => {
  it('queues offline creates and pushes them on reconnect with the same id', async () => {
    const fake = new FakePb()
    const lf = makeClient(fake)
    await synced(lf, 'posts', 0)

    fake.online = false
    const created = await lf.collection('posts').create({ title: 'offline post' })
    expect(created.id).toMatch(/^[a-z0-9]{15}$/)
    expect(lf.status.pending).toBe(1)

    fake.online = true
    await lf.sync()

    expect(lf.status.pending).toBe(0)
    const serverRecord = fake.table('posts').get(created.id)
    expect(serverRecord?.title).toBe('offline post')
    // local copy now carries the server timestamps
    expect((await lf.collection('posts').getOne(created.id)).updated).toBe(serverRecord?.updated)
  })

  it('replays ordered ops so offline-created relations stay intact', async () => {
    const fake = new FakePb()
    const lf = makeClient(fake)
    await synced(lf, 'posts', 0)
    await synced(lf, 'users', 0)

    fake.online = false
    const author = await lf.collection('users').create({ name: 'Zoe' })
    await lf.collection('posts').create({ title: 'by zoe', author: author.id })

    fake.online = true
    await lf.sync()

    const posts = [...fake.table('posts').values()]
    expect(posts).toHaveLength(1)
    expect(fake.table('users').get(posts[0].author as string)?.name).toBe('Zoe')
  })

  it('rolls back and rejects when the server refuses an online write', async () => {
    const fake = new FakePb()
    const lf = makeClient(fake)
    await synced(lf, 'posts', 0)

    fake.failWrites = validationError('nope')
    await expect(lf.collection('posts').create({ title: 'bad' })).rejects.toMatchObject({ status: 400 })
    fake.failWrites = null
    expect(await lf.collection('posts').getFullList()).toHaveLength(0)
  })

  it('rolls back a queued offline write that fails on replay and reports it', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'orig' })
    const errors: SyncErrorInfo[] = []
    const lf = makeClient(fake, { onSyncError: (info: SyncErrorInfo) => errors.push(info) })
    await synced(lf, 'posts', 1)

    fake.online = false
    await lf.collection('posts').update('p1', { title: 'offline edit' })
    expect((await lf.collection('posts').getOne('p1')).title).toBe('offline edit')

    fake.failWrites = validationError('rejected on replay')
    fake.online = true
    await lf.sync()
    fake.failWrites = null

    expect(errors).toHaveLength(1)
    expect(errors[0].collection).toBe('posts')
    // rolled back to the last server-confirmed version
    expect((await lf.collection('posts').getOne('p1')).title).toBe('orig')
  })
})

describe('conflict resolution', () => {
  async function conflictSetup() {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'orig', views: 1 })
    const lf = makeClient(fake)
    await synced(lf, 'posts', 1)
    fake.online = false
    return { fake, lf }
  }

  it('last-update-wins: newer remote update beats the offline edit', async () => {
    const { fake, lf } = await conflictSetup()
    await lf.collection('posts').update('p1', { title: 'local edit' })
    // remote edit happens "later" (server clock in the future)
    fake.clockMs = Date.now() + 60_000
    fake.serverWrite('posts', { id: 'p1', title: 'remote edit' })

    fake.online = true
    await lf.sync()

    expect(lf.status.pending).toBe(0)
    expect((await lf.collection('posts').getOne('p1')).title).toBe('remote edit')
    expect(fake.table('posts').get('p1')?.title).toBe('remote edit')
  })

  it('last-update-wins: newer offline edit beats the older remote update', async () => {
    const { fake, lf } = await conflictSetup()
    // remote edit first (fake clock is far in the past), then our local edit
    fake.serverWrite('posts', { id: 'p1', title: 'remote edit', views: 9 })
    await lf.collection('posts').update('p1', { title: 'local edit' })

    fake.online = true
    await lf.sync()

    await vi.waitFor(() => expect(lf.status.pending).toBe(0))
    expect(fake.table('posts').get('p1')?.title).toBe('local edit')
    expect((await lf.collection('posts').getOne('p1')).title).toBe('local edit')
  })

  it('remote delete wins over an offline edit by default', async () => {
    const { fake, lf } = await conflictSetup()
    await lf.collection('posts').update('p1', { title: 'local edit' })
    fake.serverDelete('posts', 'p1')

    fake.online = true
    await lf.sync()

    expect(lf.status.pending).toBe(0)
    expect(await lf.collection('posts').getFullList()).toHaveLength(0)
  })

  it('supports custom conflict resolvers (field-level merge)', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'orig', views: 1 })
    const lf = makeClient(fake, {
      conflictResolver: ({ local, remote }: any) => ({ ...remote, title: local.title }),
    })
    await synced(lf, 'posts', 1)

    fake.online = false
    await lf.collection('posts').update('p1', { title: 'local title' })
    fake.clockMs = Date.now() + 60_000
    fake.serverWrite('posts', { id: 'p1', views: 42 })

    fake.online = true
    await lf.sync()
    await vi.waitFor(() => expect(lf.status.pending).toBe(0))

    const merged = fake.table('posts').get('p1')
    expect(merged?.title).toBe('local title')
    expect(merged?.views).toBe(42)
    expect((await lf.collection('posts').getOne('p1')).title).toBe('local title')
  })

  it('a resolver can rescue data when the record was deleted remotely', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'orig' })
    const lf = makeClient(fake, {
      conflictResolver: ({ local }: any) => local, // keep local data even when remote deleted
    })
    await synced(lf, 'posts', 1)

    fake.online = false
    await lf.collection('posts').update('p1', { title: 'precious local edit' })
    fake.serverDelete('posts', 'p1')

    fake.online = true
    await lf.sync()
    await vi.waitFor(() => expect(lf.status.pending).toBe(0))

    expect(fake.table('posts').get('p1')?.title).toBe('precious local edit')
  })
})

describe('auth changes', () => {
  it('clears local data and pending writes when the auth user changes', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'one' })
    const lf = makeClient(fake)
    await synced(lf, 'posts', 1)

    fake.online = false
    await lf.collection('posts').create({ title: 'pending' })
    expect(lf.status.pending).toBe(1)

    fake.online = true
    fake.setAuth({ id: 'user-b' })

    await vi.waitFor(() => expect(lf.status.pending).toBe(0))
    // resynced under the new identity
    await synced(lf, 'posts', 1)
    expect(fake.table('posts').size).toBe(1) // the pending write was discarded
  })
})

describe('status', () => {
  it('reports online/pending transitions', async () => {
    const fake = new FakePb()
    const lf = makeClient(fake)
    await synced(lf, 'posts', 0)
    expect(lf.status.online).toBe(true)
    await vi.waitFor(() => expect(lf.status.lastSyncedAt).toBeGreaterThan(0))

    fake.online = false
    await lf.collection('posts').create({ title: 'x' })
    await vi.waitFor(() => {
      expect(lf.status.pending).toBe(1)
      expect(lf.status.online).toBe(false)
    })

    fake.online = true
    await lf.sync()
    expect(lf.status.online).toBe(true)
    expect(lf.status.pending).toBe(0)
  })
})
