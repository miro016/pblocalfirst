import type PocketBase from 'pocketbase'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLocalFirst } from '../src'
import type { ConflictContext } from '../src/types'
import { FakePb } from './helpers/fakePb'
import { cleanupClients, countRequests, goOffline, makeClient, manager, settled, synced } from './helpers/testClient'

/**
 * Systematic conflict matrix: pending local op type x remote state, on both
 * discovery paths. The pull path resolves conflicts while applying remote
 * state (reconcile/realtime against a queued op); the push path resolves them
 * when a push discovers the record changed (base mismatch) or disappeared
 * (404) on the server. With a replicating backend both paths fire routinely:
 * another node's write can land at any moment between our base read and push.
 */

afterEach(() => {
  cleanupClients()
  vi.useRealTimers()
})

describe('default resolver: update vs remote update', () => {
  it('push path, remote newer: the op is dropped and the caller gets the remote record', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'orig', views: 1 })
    const lf = makeClient(fake)
    await synced(lf, 'posts', 1)

    // another node updated the record; the event never reached this client
    fake.clockMs = Date.now() + 60_000
    fake.serverWrite('posts', { id: 'p1', title: 'remote (newer)', views: 2 }, { emit: false })

    const result = await lf.collection('posts').update('p1', { title: 'local (older)' })
    await settled(lf)

    expect(result.title).toBe('remote (newer)')
    expect(fake.table('posts').get('p1')!.title).toBe('remote (newer)')
    expect((await lf.collection('posts').getOne('p1')).title).toBe('remote (newer)')
    // the conflict was resolved without writing to the server
    expect(countRequests(fake, 'update:posts')).toBe(0)
  })

  it('push path, local newer: the local record wins wholesale and is pushed', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'orig', views: 1 })
    const lf = makeClient(fake)
    await synced(lf, 'posts', 1)

    fake.serverWrite('posts', { id: 'p1', title: 'remote (older)', views: 99 }, { emit: false })

    const result = await lf.collection('posts').update('p1', { title: 'local (newer)' })
    await settled(lf)

    expect(result.title).toBe('local (newer)')
    const server = fake.table('posts').get('p1')!
    expect(server.title).toBe('local (newer)')
    // last-update-wins replaces the whole record: the remote views bump is lost
    expect(server.views).toBe(1)
  })

  it('pull path, exact timestamp tie: remote wins (strict comparison)', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'orig' })
    const lf = makeClient(fake)
    await synced(lf, 'posts', 1)

    await goOffline(fake, lf)
    await lf.collection('posts').update('p1', { title: 'local at tie' })
    // stamp the concurrent remote write with exactly the local op's timestamp
    const opTime = manager(lf).queue.all()[0].opTime
    fake.serverWrite('posts', { id: 'p1', title: 'remote at tie' }, { updated: opTime })

    fake.online = true
    await lf.sync()
    await settled(lf)

    expect((await lf.collection('posts').getOne('p1')).title).toBe('remote at tie')
    expect(fake.table('posts').get('p1')!.title).toBe('remote at tie')
  })
})

describe('default resolver: update vs remote delete', () => {
  it('push path: the 404 during push drops the record locally without recreating it', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'orig' })
    const lf = makeClient(fake)
    await synced(lf, 'posts', 1)

    fake.serverVanish('posts', 'p1')

    // SDK-shape: the awaited call still resolves (with the optimistic record)
    const result = await lf.collection('posts').update('p1', { title: 'doomed' })
    expect(result.id).toBe('p1')
    await settled(lf)

    expect(await lf.collection('posts').getFullList()).toHaveLength(0)
    expect(fake.table('posts').has('p1')).toBe(false)
    expect(countRequests(fake, 'create:posts')).toBe(0)
    expect(countRequests(fake, 'update:posts')).toBe(0)
  })
})

describe('default resolver: delete vs remote update', () => {
  it('local delete is newer: the delete is kept and pushed through', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'orig' })
    const lf = makeClient(fake)
    await synced(lf, 'posts', 1)

    await goOffline(fake, lf)
    fake.serverWrite('posts', { id: 'p1', title: 'remote edit (older clock)' }, { emit: false })
    await lf.collection('posts').delete('p1')

    fake.online = true
    await lf.sync()
    await settled(lf)

    expect(fake.table('posts').has('p1')).toBe(false)
    expect(await lf.collection('posts').getFullList()).toHaveLength(0)
  })

  it('remote update is newer: the delete is dropped and the record restored locally', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'orig' })
    const lf = makeClient(fake)
    await synced(lf, 'posts', 1)

    await goOffline(fake, lf)
    await lf.collection('posts').delete('p1')
    fake.clockMs = Date.now() + 60_000
    fake.serverWrite('posts', { id: 'p1', title: 'remote edit (newer)' }, { emit: false })

    fake.online = true
    await lf.sync()
    await settled(lf)

    expect(fake.table('posts').get('p1')!.title).toBe('remote edit (newer)')
    expect((await lf.collection('posts').getOne('p1')).title).toBe('remote edit (newer)')
    expect(countRequests(fake, 'delete:posts')).toBe(0)
  })

  it('delete vs remote delete: both sides deleted; the op settles without error', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'orig' })
    const errors: unknown[] = []
    const lf = makeClient(fake, { onSyncError: (info: unknown) => errors.push(info) })
    await synced(lf, 'posts', 1)

    await goOffline(fake, lf)
    await lf.collection('posts').delete('p1')
    fake.serverVanish('posts', 'p1')

    fake.online = true
    await lf.sync()
    await settled(lf)

    expect(errors).toHaveLength(0)
    expect(await lf.collection('posts').getFullList()).toHaveLength(0)
    expect(fake.table('posts').size).toBe(0)
  })
})

describe('default resolver: create vs remote create with the same id', () => {
  it('the losing create fails permanently and reconcile restores the server version', async () => {
    // NOTE: documents current behavior. The pending create wins last-update-wins
    // locally but is pushed as a create, which the server rejects with 400
    // ("id already exists"); the op is rolled back and reported instead of
    // degrading to an update. A future fix could flip the op to an update.
    const fake = new FakePb()
    const errors: unknown[] = []
    const lf = makeClient(fake, { onSyncError: (info: unknown) => errors.push(info) })
    await synced(lf, 'posts', 0)

    await goOffline(fake, lf)
    await lf.collection('posts').create({ id: 'ppaaaaaaaaaaaaa', title: 'local create' })
    fake.serverWrite('posts', { id: 'ppaaaaaaaaaaaaa', title: 'other node create' }, { emit: false })

    fake.online = true
    await lf.sync()
    await settled(lf)

    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ collection: 'posts', op: { type: 'create', id: 'ppaaaaaaaaaaaaa' } })
    // the server keeps the winning node's version
    expect(fake.table('posts').get('ppaaaaaaaaaaaaa')!.title).toBe('other node create')
    // after the rollback a further sync converges the local db onto the server
    await lf.sync()
    expect((await lf.collection('posts').getOne('ppaaaaaaaaaaaaa')).title).toBe('other node create')
  })
})

describe('custom resolvers', () => {
  it('push path: a field-merge resolver sends the merged record to the server', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'orig', views: 1 })
    const lf = makeClient(fake, {
      conflictResolver: ({ local, remote }: ConflictContext) => ({ ...remote!, title: (local as { title: string }).title }),
    })
    await synced(lf, 'posts', 1)

    fake.clockMs = Date.now() + 60_000
    fake.serverWrite('posts', { id: 'p1', views: 42 }, { emit: false })

    await lf.collection('posts').update('p1', { title: 'local title' })
    await settled(lf)

    expect(fake.table('posts').get('p1')).toMatchObject({ title: 'local title', views: 42 })
    expect(await lf.collection('posts').getOne('p1')).toMatchObject({ title: 'local title', views: 42 })
  })

  it('pull path: a resolver returning null turns a pending update into a delete', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'orig' })
    const lf = makeClient(fake, { conflictResolver: () => null })
    await synced(lf, 'posts', 1)

    await goOffline(fake, lf)
    await lf.collection('posts').update('p1', { title: 'local edit' })
    fake.serverWrite('posts', { id: 'p1', title: 'remote edit' }, { emit: false })

    fake.online = true
    await lf.sync()
    await settled(lf)

    expect(fake.table('posts').has('p1')).toBe(false)
    expect(await lf.collection('posts').getFullList()).toHaveLength(0)
  })

  it('push path: a resolver can rescue a remotely deleted record by re-creating it', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'orig' })
    const lf = makeClient(fake, {
      conflictResolver: ({ local }: ConflictContext) => local,
    })
    await synced(lf, 'posts', 1)

    fake.serverVanish('posts', 'p1')
    await lf.collection('posts').update('p1', { title: 'precious edit' })
    await settled(lf)

    expect(fake.table('posts').get('p1')!.title).toBe('precious edit')
    expect(countRequests(fake, 'create:posts')).toBe(1)
  })

  it('pull path: a resolver can flip a pending delete into an update that restores the record', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'orig', views: 5 })
    const lf = makeClient(fake, {
      conflictResolver: ({ remote }: ConflictContext) => (remote ? { ...remote, title: 'kept after all' } : null),
    })
    await synced(lf, 'posts', 1)

    await goOffline(fake, lf)
    await lf.collection('posts').delete('p1')
    fake.serverWrite('posts', { id: 'p1', title: 'remote edit', views: 6 }, { emit: false })

    fake.online = true
    await lf.sync()
    await settled(lf)

    expect(fake.table('posts').get('p1')).toMatchObject({ title: 'kept after all', views: 6 })
    expect((await lf.collection('posts').getOne('p1')).title).toBe('kept after all')
    expect(countRequests(fake, 'delete:posts')).toBe(0)
  })

  it('receives a complete ConflictContext (collection, local, remote, base)', async () => {
    const fake = new FakePb()
    const orig = fake.serverWrite('posts', { id: 'p1', title: 'orig', views: 1 })
    const contexts: ConflictContext[] = []
    const lf = makeClient(fake, {
      conflictResolver: (ctx: ConflictContext) => {
        contexts.push(ctx)
        return ctx.remote
      },
    })
    await synced(lf, 'posts', 1)

    await goOffline(fake, lf)
    await lf.collection('posts').update('p1', { title: 'local edit' })
    const remote = fake.serverWrite('posts', { id: 'p1', title: 'remote edit' }, { emit: false })

    fake.online = true
    await lf.sync()
    await settled(lf)

    expect(contexts).toHaveLength(1)
    expect(contexts[0].collection).toBe('posts')
    expect(contexts[0].local).toMatchObject({ id: 'p1', title: 'local edit' })
    expect(contexts[0].remote).toMatchObject({ id: 'p1', title: 'remote edit', updated: remote.updated })
    expect(contexts[0].base).toMatchObject({ id: 'p1', title: 'orig', updated: orig.updated })
    // the context holds clones, not the engine's live objects
    expect(contexts[0].remote).not.toBe(remote)
    ;(contexts[0].remote as Record<string, unknown>).title = 'mutated afterwards'
    expect(fake.table('posts').get('p1')!.title).toBe('remote edit')
    expect((await lf.collection('posts').getOne('p1')).title).toBe('remote edit')
  })

  it('push path: a throwing resolver rejects the awaited write and rolls back', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'orig' })
    const lf = makeClient(fake, {
      conflictResolver: () => {
        throw new Error('resolver exploded')
      },
    })
    await synced(lf, 'posts', 1)

    fake.serverWrite('posts', { id: 'p1', title: 'remote edit' }, { emit: false })

    await expect(lf.collection('posts').update('p1', { title: 'local edit' })).rejects.toThrow('resolver exploded')
    await settled(lf)
    // rolled back to the last server-confirmed version this client knows
    expect((await lf.collection('posts').getOne('p1')).title).toBe('orig')
    expect(fake.table('posts').get('p1')!.title).toBe('remote edit')
  })

  it('pull path: a throwing resolver fails the sync but the client stays usable', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'orig' })
    let shouldThrow = true
    const lf = makeClient(fake, {
      conflictResolver: ({ remote }: ConflictContext) => {
        if (shouldThrow) throw new Error('resolver exploded')
        return remote
      },
    })
    await synced(lf, 'posts', 1)

    await goOffline(fake, lf)
    await lf.collection('posts').update('p1', { title: 'local edit' })
    fake.serverWrite('posts', { id: 'p1', title: 'remote edit' }, { emit: false })

    fake.online = true
    await expect(lf.sync()).rejects.toThrow('resolver exploded')

    // recover: the op is still queued; the next sync resolves it
    shouldThrow = false
    await lf.sync()
    await settled(lf)
    expect((await lf.collection('posts').getOne('p1')).title).toBe('remote edit')
  })

  it('a per-collection resolver takes precedence over the global one', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'orig' })
    const lf = createLocalFirst({
      pb: fake as unknown as PocketBase,
      collections: {
        posts: {
          cache: true,
          conflictResolver: ({ local }: ConflictContext) => ({ ...local!, title: 'per-collection' }),
        },
        users: { cache: true },
      },
      conflictResolver: () => {
        throw new Error('global resolver must not run')
      },
      persistence: 'memory',
      reconcileIntervalMs: 0,
      healthCheckIntervalMs: 3_600_000,
    })
    try {
      await synced(lf, 'posts', 1)

      await goOffline(fake, lf)
      await lf.collection('posts').update('p1', { title: 'local edit' })
      fake.serverWrite('posts', { id: 'p1', title: 'remote edit' }, { emit: false })

      fake.online = true
      await lf.sync()
      await settled(lf)

      expect(fake.table('posts').get('p1')!.title).toBe('per-collection')
    } finally {
      lf.destroy()
    }
  })
})
