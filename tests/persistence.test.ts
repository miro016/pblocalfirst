import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { indexedDBPersistence } from '../src/persistence/indexeddb'
import { localStoragePersistence } from '../src/persistence/localstorage'
import { memoryPersistence } from '../src/persistence/memory'
import type { PersistenceAdapter } from '../src/persistence/types'

function localStorageMock(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
  }
}

const adapters: Array<[string, () => PersistenceAdapter]> = [
  ['memory', () => memoryPersistence()],
  ['localStorage', () => localStoragePersistence(localStorageMock())],
  ['indexedDB', () => indexedDBPersistence(`db-${Math.random().toString(36).slice(2)}`)],
]

describe.each(adapters)('%s persistence', (_name, make) => {
  it('saves, loads, removes and clears by prefix', async () => {
    const adapter = make()
    expect(await adapter.load('pblf:data:posts')).toBeUndefined()

    await adapter.save('pblf:data:posts', { records: [{ id: 'a' }], cursor: 'c1' })
    await adapter.save('pblf:queue', { ops: [] })
    await adapter.save('other:key', 1)

    expect(await adapter.load('pblf:data:posts')).toEqual({ records: [{ id: 'a' }], cursor: 'c1' })

    await adapter.remove('pblf:queue')
    expect(await adapter.load('pblf:queue')).toBeUndefined()

    await adapter.clear('pblf:')
    expect(await adapter.load('pblf:data:posts')).toBeUndefined()
    expect(await adapter.load('other:key')).toBe(1)
  })
})
