import type { PersistenceAdapter } from './types'

/** localStorage-backed adapter (small datasets; ~5MB origin limit). */
export function localStoragePersistence(storage: Storage = globalThis.localStorage): PersistenceAdapter {
  return {
    async load(key) {
      const raw = storage.getItem(key)
      if (raw === null) return undefined
      try {
        return JSON.parse(raw)
      } catch {
        return undefined
      }
    },
    async save(key, value) {
      storage.setItem(key, JSON.stringify(value))
    },
    async remove(key) {
      storage.removeItem(key)
    },
    async clear(prefix) {
      const toRemove: string[] = []
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i)
        if (key && key.startsWith(prefix)) toRemove.push(key)
      }
      toRemove.forEach((key) => storage.removeItem(key))
    },
  }
}
