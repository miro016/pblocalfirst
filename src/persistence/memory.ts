import type { PersistenceAdapter } from './types'

/** Non-persistent adapter; useful for tests, SSR and node scripts. */
export function memoryPersistence(): PersistenceAdapter {
  const map = new Map<string, unknown>()
  return {
    async load(key) {
      return map.get(key)
    },
    async save(key, value) {
      map.set(key, value)
    },
    async remove(key) {
      map.delete(key)
    },
    async clear(prefix) {
      for (const key of [...map.keys()]) {
        if (key.startsWith(prefix)) map.delete(key)
      }
    },
  }
}
