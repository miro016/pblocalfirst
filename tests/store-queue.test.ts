import { describe, expect, it } from 'vitest'
import { memoryPersistence } from '../src/persistence/memory'
import { noopReactivity } from '../src/reactivity'
import { CollectionStore } from '../src/store'
import { WriteQueue } from '../src/sync/queue'
import type { RecordSubscription } from '../src/types'

describe('CollectionStore', () => {
  it('emits create/update/delete events', () => {
    const store = new CollectionStore('posts', noopReactivity)
    const events: RecordSubscription<any>[] = []
    store.onChange((batch) => events.push(...batch))

    store.upsert({ id: 'a', title: 'one' })
    store.upsert({ id: 'a', title: 'two' })
    store.remove('a')

    expect(events.map((e) => e.action)).toEqual(['create', 'update', 'delete'])
  })

  it('suppresses no-op upserts (server echoes)', () => {
    const store = new CollectionStore('posts', noopReactivity)
    const events: RecordSubscription<any>[] = []
    store.upsert({ id: 'a', title: 'one' })
    store.onChange((batch) => events.push(...batch))
    store.upsert({ id: 'a', title: 'one' })
    expect(events).toHaveLength(0)
  })

  it('batches notifications', () => {
    const store = new CollectionStore('posts', noopReactivity)
    let notifications = 0
    store.onChange(() => notifications++)
    store.batch(() => {
      store.upsert({ id: 'a' })
      store.upsert({ id: 'b' })
      store.remove('a')
    })
    expect(notifications).toBe(1)
    expect(store.peekAll().map((r) => r.id)).toEqual(['b'])
  })
})

describe('WriteQueue', () => {
  const makeQueue = () => new WriteQueue('test:queue', memoryPersistence())

  it('compacts create+update into create', () => {
    const queue = makeQueue()
    queue.enqueue({ collection: 'posts', type: 'create', id: 'a', data: { title: 'one' }, base: null, opTime: 't1' })
    queue.enqueue({ collection: 'posts', type: 'update', id: 'a', data: { views: 2 }, base: null, opTime: 't2' })
    expect(queue.length).toBe(1)
    expect(queue.peek()).toMatchObject({ type: 'create', data: { title: 'one', views: 2 }, opTime: 't2' })
  })

  it('drops create+delete entirely', () => {
    const queue = makeQueue()
    queue.enqueue({ collection: 'posts', type: 'create', id: 'a', data: {}, base: null, opTime: 't1' })
    queue.enqueue({ collection: 'posts', type: 'delete', id: 'a', base: null, opTime: 't2' })
    expect(queue.length).toBe(0)
  })

  it('merges update+update and keeps the original base', () => {
    const queue = makeQueue()
    const base = { id: 'a', title: 'orig', updated: 'u0' }
    queue.enqueue({ collection: 'posts', type: 'update', id: 'a', data: { title: 'x' }, base, opTime: 't1' })
    queue.enqueue({ collection: 'posts', type: 'update', id: 'a', data: { views: 3 }, base: { ...base, updated: 'u9' }, opTime: 't2' })
    expect(queue.length).toBe(1)
    expect(queue.peek()).toMatchObject({ type: 'update', data: { title: 'x', views: 3 }, base: { updated: 'u0' } })
  })

  it('turns update+delete into delete', () => {
    const queue = makeQueue()
    queue.enqueue({ collection: 'posts', type: 'update', id: 'a', data: { title: 'x' }, base: null, opTime: 't1' })
    queue.enqueue({ collection: 'posts', type: 'delete', id: 'a', base: null, opTime: 't2' })
    expect(queue.length).toBe(1)
    expect(queue.peek()!.type).toBe('delete')
  })

  it('does not compact into a locked (in-flight) op', () => {
    const queue = makeQueue()
    const first = queue.enqueue({ collection: 'posts', type: 'update', id: 'a', data: { title: 'x' }, base: null, opTime: 't1' })!
    queue.isLocked = (seq) => seq === first.seq
    queue.enqueue({ collection: 'posts', type: 'update', id: 'a', data: { views: 1 }, base: null, opTime: 't2' })
    expect(queue.length).toBe(2)
    expect(queue.getForId('posts', 'a')!.data).toEqual({ views: 1 }) // latest intent
  })

  it('keeps ops ordered across collections', () => {
    const queue = makeQueue()
    queue.enqueue({ collection: 'authors', type: 'create', id: 'u1', data: {}, base: null, opTime: 't1' })
    queue.enqueue({ collection: 'posts', type: 'create', id: 'p1', data: { author: 'u1' }, base: null, opTime: 't2' })
    expect(queue.all().map((op) => op.collection)).toEqual(['authors', 'posts'])
  })

  it('persists and restores', async () => {
    const persistence = memoryPersistence()
    const queue = new WriteQueue('k', persistence)
    queue.enqueue({ collection: 'posts', type: 'create', id: 'a', data: { title: 'x' }, base: null, opTime: 't1' })
    await queue.flushPersistence()

    const restored = new WriteQueue('k', persistence)
    await restored.load()
    expect(restored.length).toBe(1)
    expect(restored.peek()).toMatchObject({ collection: 'posts', id: 'a' })
  })
})
