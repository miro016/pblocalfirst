import { afterEach, describe, expect, it, vi } from 'vitest'
import { memoryPersistence } from '../src/persistence/memory'
import { QueryError } from '../src/errors'
import { FakePb, networkError, validationError } from './helpers/fakePb'
import { cleanupClients, countRequests, goOffline, makeClient, manager, settled, synced } from './helpers/testClient'

/**
 * Edge cases of the offline write queue: compaction over long offline
 * sessions, replay ordering, partial flush failures, persistence across
 * client restarts and the FormData limitation.
 */

afterEach(() => {
  cleanupClients()
})

describe('compaction over long offline sessions', () => {
  it('100 offline updates to one record replay as a single update request', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'v0', views: 0 })
    const lf = makeClient(fake)
    await synced(lf, 'posts', 1)

    fake.online = false
    for (let i = 1; i <= 100; i++) {
      await lf.collection('posts').update('p1', { title: `v${i}`, views: i })
    }
    expect(lf.status.pending).toBe(1)

    fake.online = true
    const before = fake.requestLog.length
    await lf.sync()
    await settled(lf)

    expect(countRequests(fake, 'update:posts', before)).toBe(1)
    expect(fake.table('posts').get('p1')).toMatchObject({ title: 'v100', views: 100 })
  })

  it('offline delete then re-create of the same id compacts to an update', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'old', views: 7 })
    const lf = makeClient(fake)
    await synced(lf, 'posts', 1)

    fake.online = false
    await lf.collection('posts').delete('p1')
    await lf.collection('posts').create({ id: 'p1', title: 'reborn' })
    expect(lf.status.pending).toBe(1)

    fake.online = true
    const before = fake.requestLog.length
    await lf.sync()
    await settled(lf)

    expect(countRequests(fake, 'delete:posts', before)).toBe(0)
    expect(countRequests(fake, 'create:posts', before)).toBe(0)
    expect(countRequests(fake, 'update:posts', before)).toBe(1)
    expect(fake.table('posts').get('p1')!.title).toBe('reborn')
  })

  it('create -> update -> delete offline cancels out and never reaches the server', async () => {
    const fake = new FakePb()
    const lf = makeClient(fake)
    await synced(lf, 'posts', 0)

    fake.online = false
    const created = await lf.collection('posts').create({ title: 'ephemeral' })
    await lf.collection('posts').update(created.id, { title: 'still ephemeral' })
    await lf.collection('posts').delete(created.id)
    expect(lf.status.pending).toBe(0)

    fake.online = true
    const before = fake.requestLog.length
    await lf.sync()

    expect(countRequests(fake, 'create:posts', before)).toBe(0)
    expect(countRequests(fake, 'update:posts', before)).toBe(0)
    expect(countRequests(fake, 'delete:posts', before)).toBe(0)
    expect(fake.table('posts').size).toBe(0)
  })

  it('delete -> create -> update chain carries the fully merged data', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'old', views: 3 })
    const lf = makeClient(fake)
    await synced(lf, 'posts', 1)

    fake.online = false
    await lf.collection('posts').delete('p1')
    await lf.collection('posts').create({ id: 'p1', title: 'reborn', views: 0 })
    await lf.collection('posts').update('p1', { views: 42 })
    expect(lf.status.pending).toBe(1)

    fake.online = true
    await lf.sync()
    await settled(lf)

    expect(fake.table('posts').get('p1')).toMatchObject({ title: 'reborn', views: 42 })
  })
})

describe('in-flight ops', () => {
  it('an op being pushed is not compacted into; the follow-up lands separately', async () => {
    const fake = new FakePb()
    const lf = makeClient(fake)
    await synced(lf, 'posts', 0)

    fake.latencyMs = 40
    const createPromise = lf.collection('posts').create({ id: 'p1aaaaaaaaaaaaa', title: 'first' })
    // wait until the create is actually in flight
    await vi.waitFor(() => expect(countRequests(fake, 'create:posts')).toBe(1))
    const updatePromise = lf.collection('posts').update('p1aaaaaaaaaaaaa', { title: 'second' })

    await Promise.all([createPromise, updatePromise])
    fake.latencyMs = 0
    await settled(lf)

    expect(fake.table('posts').get('p1aaaaaaaaaaaaa')!.title).toBe('second')
    expect(countRequests(fake, 'create:posts')).toBe(1)
    expect(countRequests(fake, 'update:posts')).toBe(1)
  })
})

describe('queue persistence across restarts', () => {
  it('pending offline writes survive a client restart and replay with the same ids in order', async () => {
    const persistence = memoryPersistence()
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'orig' })

    const session1 = makeClient(fake, { persistence })
    await synced(session1, 'posts', 1)

    fake.online = false
    const created = await session1.collection('users').create({ name: 'Zoe' })
    await session1.collection('posts').update('p1', { title: 'offline edit', author: created.id })
    expect(session1.status.pending).toBe(2)
    await manager(session1).queue.flushPersistence()
    session1.destroy() // flushes the debounced data snapshot as well

    // still offline: the new session restores the queue from persistence
    const session2 = makeClient(fake, { persistence })
    await session2.ready()
    await vi.waitFor(() => expect(session2.status.pending).toBe(2))
    // new ops continue the seq counter instead of colliding with restored ops
    const restoredSeqs = manager(session2).queue.all().map((op) => op.seq)
    await session2.collection('users').create({ name: 'Max' })
    const allSeqs = manager(session2).queue.all().map((op) => op.seq)
    expect(Math.min(...allSeqs.filter((s) => !restoredSeqs.includes(s)))).toBeGreaterThan(Math.max(...restoredSeqs))

    fake.online = true
    await session2.sync()
    await settled(session2)

    expect(fake.table('users').get(created.id)?.name).toBe('Zoe')
    expect(fake.table('posts').get('p1')).toMatchObject({ title: 'offline edit', author: created.id })
    // replay preserved submit order: the user create precedes the post update
    const userIdx = fake.requestLog.indexOf('create:users')
    const postIdx = fake.requestLog.indexOf('update:posts')
    expect(userIdx).toBeGreaterThan(-1)
    expect(userIdx).toBeLessThan(postIdx)
  })

  it('cross-collection ops replay in exact submit order', async () => {
    const fake = new FakePb()
    fake.serverWrite('users', { id: 'u1zzzzzzzzzzzzz', name: 'existing' })
    const lf = makeClient(fake)
    await synced(lf, 'users', 1)

    fake.online = false
    const author = await lf.collection('users').create({ name: 'author' })
    await lf.collection('posts').create({ id: 'ppzzzzzzzzzzzzz', title: 'post', author: author.id })
    await lf.collection('users').update('u1zzzzzzzzzzzzz', { name: 'renamed' })
    await lf.collection('posts').update('ppzzzzzzzzzzzzz', { title: 'post v2' })
    // post create+update compacted; expect 3 ops
    expect(lf.status.pending).toBe(3)

    fake.online = true
    const before = fake.requestLog.length
    await lf.sync()
    await settled(lf)

    const writes = fake.requestLog.slice(before).filter((r) => /^(create|update|delete):/.test(r))
    expect(writes).toEqual(['create:users', 'create:posts', 'update:users'])
    expect(fake.table('posts').get('ppzzzzzzzzzzzzz')!.title).toBe('post v2')
  })
})

describe('partial flush failures', () => {
  async function fiveOpSetup() {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'p1-orig' })
    fake.serverWrite('posts', { id: 'p3', title: 'p3-orig' })
    fake.serverWrite('users', { id: 'u2zzzzzzzzzzzzz', name: 'u2-orig' })
    const errors: unknown[] = []
    const lf = makeClient(fake, { onSyncError: (info: unknown) => errors.push(info) })
    await synced(lf, 'posts', 2)
    await synced(lf, 'users', 1)

    fake.online = false
    await lf.collection('users').create({ name: 'new user' }) // op 1
    await lf.collection('posts').update('p1', { title: 'p1-edited' }) // op 2 (the one we fail)
    await lf.collection('posts').create({ id: 'p2aaaaaaaaaaaaa', title: 'p2-new' }) // op 3
    await lf.collection('users').update('u2zzzzzzzzzzzzz', { name: 'u2-edited' }) // op 4
    await lf.collection('posts').delete('p3') // op 5
    expect(lf.status.pending).toBe(5)
    return { fake, lf, errors }
  }

  it('a permanent failure of op 2 of 5 rolls back only that op and the rest continue', async () => {
    const { fake, lf, errors } = await fiveOpSetup()
    fake.failNext('update:posts', validationError('rejected'))

    fake.online = true
    await lf.sync()
    await settled(lf)

    // op 2 rolled back to the last server-confirmed version, reported once
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ collection: 'posts', op: { type: 'update', id: 'p1' } })
    expect((await lf.collection('posts').getOne('p1')).title).toBe('p1-orig')
    expect(fake.table('posts').get('p1')!.title).toBe('p1-orig')
    // ops 1, 3, 4, 5 all landed
    expect(fake.table('posts').get('p2aaaaaaaaaaaaa')!.title).toBe('p2-new')
    expect(fake.table('users').get('u2zzzzzzzzzzzzz')!.name).toBe('u2-edited')
    expect(fake.table('posts').has('p3')).toBe(false)
    expect([...fake.table('users').values()].some((u) => u.name === 'new user')).toBe(true)
  })

  it('a network failure of op 2 of 5 halts the flush; ops 2-5 stay queued and replay once online', async () => {
    const { fake, lf, errors } = await fiveOpSetup()
    fake.failNext('update:posts', networkError())

    fake.online = true
    await lf.sync()

    // flush stopped at op 2; 4 ops remain queued, nothing was lost or reported
    await vi.waitFor(() => expect(lf.status.pending).toBe(4))
    expect(errors).toHaveLength(0)
    expect(lf.status.online).toBe(false)

    await lf.sync()
    await settled(lf)

    // every op landed exactly once
    expect(fake.table('posts').get('p1')!.title).toBe('p1-edited')
    expect(fake.table('posts').get('p2aaaaaaaaaaaaa')!.title).toBe('p2-new')
    expect(fake.table('users').get('u2zzzzzzzzzzzzz')!.name).toBe('u2-edited')
    expect(fake.table('posts').has('p3')).toBe(false)
    expect(countRequests(fake, 'create:posts')).toBe(1)
    expect(countRequests(fake, 'update:users')).toBe(1)
    expect(countRequests(fake, 'delete:posts')).toBe(1)
  })
})

describe('offline limitations and semantics', () => {
  it('FormData writes on a cached collection throw offline and work online', async () => {
    const fake = new FakePb()
    const lf = makeClient(fake)
    await synced(lf, 'posts', 0)

    await goOffline(fake, lf)
    const form = new FormData()
    form.set('title', 'file post')
    await expect(lf.collection('posts').create(form)).rejects.toThrow(QueryError)
    expect(lf.status.pending).toBe(0)

    fake.online = true
    await lf.sync()
    const record = await lf.collection('posts').create(form)
    expect(record.id).toBeTruthy()
    // passthrough writes are mirrored into the local store
    expect(await lf.collection('posts').getOne(record.id)).toBeTruthy()
  })

  it('an offline write resolves immediately with the optimistic record', async () => {
    const fake = new FakePb()
    const lf = makeClient(fake)
    await synced(lf, 'posts', 0)

    await goOffline(fake, lf)
    const started = Date.now()
    const record = await lf.collection('posts').create({ title: 'instant' })
    expect(Date.now() - started).toBeLessThan(100)
    expect(record.id).toMatch(/^[a-z0-9]{15}$/)
    expect(record.created).toBeTruthy()
    expect(record.updated).toBeTruthy()
    expect(lf.status.pending).toBe(1)
    expect(countRequests(fake, 'create:posts')).toBe(0)
  })

  it('a pending delete survives a reconcile that still sees the record remotely', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'to delete' })
    const lf = makeClient(fake)
    await synced(lf, 'posts', 1)

    fake.online = false
    await lf.collection('posts').delete('p1')
    expect(await lf.collection('posts').getFullList()).toHaveLength(0)

    fake.online = true
    // sync runs reconcile (which still sees p1 remotely) before the flush pushes the delete
    await lf.sync()
    await settled(lf)

    expect(fake.table('posts').has('p1')).toBe(false)
    expect(await lf.collection('posts').getFullList()).toHaveLength(0)
  })
})
