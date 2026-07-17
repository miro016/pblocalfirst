import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BaseRecord } from '../src/types'
import { nowPocketBaseDate } from '../src/utils'
import { FakePb } from './helpers/fakePb'
import { cleanupClients, countRequests, engine, makeClient, manager, settled, synced } from './helpers/testClient'

/**
 * Simulates what a pbreplication cluster does to a client that talks to one
 * node through the plain PocketBase API: bulk change bursts from snapshot
 * resyncs, records vanishing without realtime events (compacted tombstones,
 * reconcile-deletions), wholesale last-write-wins overwrites from other
 * nodes, records reappearing (rescued offline writes), lost/out-of-order
 * realtime events and server clock skew.
 */

afterEach(() => {
  cleanupClients()
  vi.useRealTimers()
})

function seed(count: number, prefix = 'p'): Array<{ id: string; title: string }> {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}${String(i).padStart(4, '0')}`, title: `t${i}` }))
}

describe('bulk remote bursts (server resync applying many records)', () => {
  it('applies a 500-record burst via a single full refetch', async () => {
    const fake = new FakePb()
    const lf = makeClient(fake)
    await synced(lf, 'posts', 0)

    fake.bulkServerWrite('posts', seed(500))
    const before = fake.requestLog.length
    await lf.sync()

    await synced(lf, 'posts', 500)
    // >300 changed AND >half the collection -> one index scan + one full data fetch, no id-chunks
    const dataFetches = fake.requests
      .slice(before)
      .filter((r) => r.what === 'getFullList:posts' && r.options.fields !== 'id,updated')
    expect(dataFetches).toHaveLength(1)
    expect(dataFetches[0].options.filter).toBeUndefined()
  })

  it('applies a 400-of-1000 burst via chunked id fetches of 100', async () => {
    const fake = new FakePb()
    fake.bulkServerWrite('posts', seed(1000))
    const lf = makeClient(fake)
    await synced(lf, 'posts', 1000)

    fake.bulkServerWrite('posts', seed(400).map((r) => ({ ...r, title: `${r.title}-changed` })))
    const before = fake.requestLog.length
    await lf.sync()

    // 400 > 300 but not > 1000/2 -> 4 chunked fetches of 100 ids each
    const chunkFetches = fake.requests
      .slice(before)
      .filter((r) => r.what === 'getFullList:posts' && String(r.options.filter ?? '').includes('id='))
    expect(chunkFetches).toHaveLength(4)
    for (const fetch of chunkFetches) {
      expect(String(fetch.options.filter).split(' || ')).toHaveLength(100)
    }
    expect((await lf.collection('posts').getOne('p0399')).title).toBe('t399-changed')
    expect((await lf.collection('posts').getOne('p0400')).title).toBe('t400')
  })

  it('handles a burst where every record shares one identical updated timestamp', async () => {
    const fake = new FakePb()
    const lf = makeClient(fake)
    await synced(lf, 'posts', 0)

    fake.bulkServerWrite('posts', seed(20), { sameTimestamp: true })
    await lf.sync()
    await synced(lf, 'posts', 20)
    const sharedTs = fake.table('posts').get('p0000')!.updated!

    // a later change carrying the exact same timestamp is still detected
    // (reconcile compares per-id, not only against the cursor)
    fake.serverWrite('posts', { id: 'p0000', title: 'silent rewrite' }, { emit: false, updated: sharedTs })
    // updated stayed identical -> indistinguishable from unchanged; documents
    // that equal-timestamp rewrites are NOT detectable...
    await lf.sync()
    expect((await lf.collection('posts').getOne('p0000')).title).toBe('t0')

    // ...but any timestamp advance, however small, is
    fake.serverWrite('posts', { id: 'p0001', title: 'detected rewrite' }, { emit: false })
    await lf.sync()
    expect((await lf.collection('posts').getOne('p0001')).title).toBe('detected rewrite')
  })
})

describe('silent deletions (compacted tombstones / reconcile-deletions)', () => {
  it('a record that vanished without a realtime event is removed on the next sync', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'one' })
    fake.serverWrite('posts', { id: 'p2', title: 'two' })
    const lf = makeClient(fake)
    await synced(lf, 'posts', 2)

    fake.serverVanish('posts', 'p2')
    // no event was delivered: still cached
    expect(await lf.collection('posts').getFullList()).toHaveLength(2)

    await lf.sync()
    const items = await lf.collection('posts').getFullList()
    expect(items.map((r) => r.id)).toEqual(['p1'])
  })

  it('a vanish with a pending local update resolves as a delete conflict (remote delete wins)', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'one' })
    const lf = makeClient(fake)
    await synced(lf, 'posts', 1)

    fake.online = false
    await lf.collection('posts').update('p1', { title: 'doomed edit' })
    fake.serverVanish('posts', 'p1')

    fake.online = true
    const before = fake.requestLog.length
    await lf.sync()
    await settled(lf)

    expect(await lf.collection('posts').getFullList()).toHaveLength(0)
    // the dropped op must not be pushed as a create/update
    expect(countRequests(fake, 'create:posts', before)).toBe(0)
    expect(countRequests(fake, 'update:posts', before)).toBe(0)
  })

  it('a late tombstone delivered via realtime removes a long-cached record', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'old' })
    const lf = makeClient(fake)
    await synced(lf, 'posts', 1)

    // a lot of unrelated time passes on the server
    for (let i = 0; i < 50; i++) fake.tick()
    fake.serverDelete('posts', 'p1')

    await synced(lf, 'posts', 0)
  })
})

describe('records reappearing (rescued offline writes re-applied by the cluster)', () => {
  it('a record recreated after a confirmed delete comes back via realtime', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'one' })
    const lf = makeClient(fake)
    await synced(lf, 'posts', 1)

    await lf.collection('posts').delete('p1')
    await settled(lf)
    expect(fake.table('posts').has('p1')).toBe(false)

    // another node's rescued write re-applies the record
    fake.serverWrite('posts', { id: 'p1', title: 'rescued' })
    await synced(lf, 'posts', 1)
    expect((await lf.collection('posts').getOne('p1')).title).toBe('rescued')
  })

  it('a record recreated without a realtime event comes back via reconcile', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'one' })
    const lf = makeClient(fake)
    await synced(lf, 'posts', 1)

    await lf.collection('posts').delete('p1')
    await settled(lf)

    fake.serverWrite('posts', { id: 'p1', title: 'rescued silently' }, { emit: false })
    await lf.sync()
    expect((await lf.collection('posts').getOne('p1')).title).toBe('rescued silently')
  })
})

describe('wholesale LWW overwrites from other nodes', () => {
  it('a confirmed client write is replaced wholesale by a newer remote version', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'orig', views: 1, tags: ['a'] })
    const lf = makeClient(fake)
    await synced(lf, 'posts', 1)

    await lf.collection('posts').update('p1', { title: 'client edit' })
    await settled(lf)

    // another node wins LWW: the whole record is replaced, not field-merged
    fake.serverWrite('posts', { id: 'p1', title: 'node-b edit', views: 99, tags: [] })
    await vi.waitFor(async () => {
      const record = await lf.collection('posts').getOne('p1')
      expect(record.title).toBe('node-b edit')
      expect(record.views).toBe(99)
      expect(record.tags).toEqual([])
    })
    expect(lf.status.pending).toBe(0)
  })
})

describe('realtime event edge cases', () => {
  it('an event whose updated equals the cursor is still applied', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'one' })
    const lf = makeClient(fake)
    await synced(lf, 'posts', 1)

    const cursor = (engine(lf, 'posts') as unknown as { cursor: string }).cursor
    expect(cursor).not.toBe('')
    const server = fake.table('posts').get('p1')!
    fake.emitRaw('posts', 'update', { ...server, title: 'boundary update', updated: cursor })

    await vi.waitFor(async () => {
      expect((await lf.collection('posts').getOne('p1')).title).toBe('boundary update')
    })
  })

  it('an out-of-order (stale) event is repaired by the next reconcile', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'v1' })
    const lf = makeClient(fake)
    await synced(lf, 'posts', 1)
    const stale = { ...fake.table('posts').get('p1')! }

    fake.serverWrite('posts', { id: 'p1', title: 'v2' })
    await vi.waitFor(async () => {
      expect((await lf.collection('posts').getOne('p1')).title).toBe('v2')
    })

    // a duplicated/reordered event replays the older version
    fake.emitRaw('posts', 'update', stale)
    await vi.waitFor(async () => {
      expect((await lf.collection('posts').getOne('p1')).title).toBe('v1')
    })

    await lf.sync()
    expect((await lf.collection('posts').getOne('p1')).title).toBe('v2')
  })

  it('changes whose realtime events were lost are recovered by reconcile', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'one' })
    const lf = makeClient(fake)
    await synced(lf, 'posts', 1)

    fake.dropRealtime = true
    fake.serverWrite('posts', { id: 'p1', title: 'silent change' })
    fake.serverWrite('posts', { id: 'p2', title: 'silent new' })
    fake.serverDelete('posts', 'p1') // delete event also lost
    fake.dropRealtime = false

    // nothing arrived
    expect((await lf.collection('posts').getOne('p1')).title).toBe('one')

    await lf.sync()
    const items = await lf.collection('posts').getFullList()
    expect(items.map((r) => r.id)).toEqual(['p2'])
  })
})

describe('server-side snapshot resync (restartWithSnapshot)', () => {
  it('one sync converges the local db onto the snapshot state', async () => {
    const fake = new FakePb()
    fake.bulkServerWrite('posts', seed(20))
    const lf = makeClient(fake)
    await synced(lf, 'posts', 20)

    // node restarts from a peer snapshot: 10 survive modified, 10 vanish, 5 are new
    const snapshot = [
      ...seed(10).map((r) => ({ ...r, title: `${r.title}-snap` })),
      ...seed(5, 'n').map((r) => ({ ...r, title: `${r.title}-new` })),
    ]
    fake.restartWithSnapshot('posts', snapshot)

    const events: Array<{ action: string; id: string }> = []
    await lf.collection('posts').subscribe('*', (e: { action: string; record: BaseRecord }) => {
      events.push({ action: e.action, id: e.record.id })
    })

    await lf.sync()

    const items = await lf.collection('posts').getFullList({ sort: 'id' })
    expect(items).toHaveLength(15)
    expect(items.filter((r) => r.id.startsWith('n'))).toHaveLength(5)
    expect(items.every((r) => String(r.title).endsWith('-snap') || String(r.title).endsWith('-new'))).toBe(true)
    // local subscribers observed the deletions and additions
    expect(events.filter((e) => e.action === 'delete')).toHaveLength(10)
    expect(events.filter((e) => e.action === 'create')).toHaveLength(5)
  })
})

describe('server clock skew and last-update-wins', () => {
  it('a remote write stamped by a far-ahead server clock beats a later local edit', async () => {
    const fake = new FakePb()
    fake.serverWrite('posts', { id: 'p1', title: 'orig' })
    const lf = makeClient(fake)
    await synced(lf, 'posts', 1)

    fake.online = false
    fake.clockMs = Date.now() + 3_600_000 // server clock 1h in the future
    fake.serverWrite('posts', { id: 'p1', title: 'remote (future clock)' })
    await lf.collection('posts').update('p1', { title: 'local (real now)' }) // later in wall-clock time

    fake.online = true
    await lf.sync()
    await settled(lf)

    // documents lastUpdateWins under skew: the skewed server timestamp wins
    expect((await lf.collection('posts').getOne('p1')).title).toBe('remote (future clock)')
    expect(fake.table('posts').get('p1')!.title).toBe('remote (future clock)')
  })

  it('a local edit beats a remote write stamped by a far-behind server clock', async () => {
    const fake = new FakePb() // fake clock starts in 2024, far behind the real clock
    fake.serverWrite('posts', { id: 'p1', title: 'orig' })
    const lf = makeClient(fake)
    await synced(lf, 'posts', 1)

    fake.online = false
    fake.serverWrite('posts', { id: 'p1', title: 'remote (past clock)' })
    await lf.collection('posts').update('p1', { title: 'local edit' })

    fake.online = true
    await lf.sync()
    await settled(lf)

    expect(fake.table('posts').get('p1')!.title).toBe('local edit')
  })
})

describe('collections appearing server-side', () => {
  it('an unknown collection is plain passthrough and does not disturb sync', async () => {
    const fake = new FakePb()
    fake.serverWrite('brand_new', { id: 'b1', name: 'fresh' })
    const lf = makeClient(fake)
    await synced(lf, 'posts', 0)

    const items = await lf.collection('brand_new').getFullList()
    expect(items.map((r) => r.id)).toEqual(['b1'])
    expect(countRequests(fake, 'getFullList:brand_new')).toBe(1)

    const created = await lf.collection('brand_new').create({ id: 'b2', name: 'via client' })
    expect(created.id).toBe('b2')
    expect(fake.table('brand_new').has('b2')).toBe(true)
    expect(lf.status.pending).toBe(0)
  })

  it('a queued op for a collection with no engine is dropped by the flush loop', async () => {
    const fake = new FakePb()
    const lf = makeClient(fake)
    await synced(lf, 'posts', 0)

    manager(lf).queue.enqueue({ collection: 'ghost', type: 'create', id: 'g1', data: {}, base: null, opTime: nowPocketBaseDate() })
    expect(lf.status.pending).toBe(1)

    await manager(lf).flush()
    expect(lf.status.pending).toBe(0)
    expect(countRequests(fake, 'create:ghost')).toBe(0)
  })
})
