import type { PersistenceAdapter } from './types'
import { localStoragePersistence } from './localstorage'
import { memoryPersistence } from './memory'

/** IndexedDB-backed adapter — the default in browsers. */
export function indexedDBPersistence(dbName = 'pocketbase-localfirst', storeName = 'kv'): PersistenceAdapter {
  let dbPromise: Promise<IDBDatabase> | null = null

  function open(): Promise<IDBDatabase> {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName, 1)
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(storeName)) req.result.createObjectStore(storeName)
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
    }
    return dbPromise
  }

  function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return open().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const transaction = db.transaction(storeName, mode)
          const req = run(transaction.objectStore(storeName))
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        }),
    )
  }

  return {
    async load(key) {
      const value = await tx('readonly', (store) => store.get(key))
      return value === undefined ? undefined : value
    },
    async save(key, value) {
      await tx('readwrite', (store) => store.put(value, key))
    },
    async remove(key) {
      await tx('readwrite', (store) => store.delete(key))
    },
    async clear(prefix) {
      const keys = (await tx('readonly', (store) => store.getAllKeys())) as IDBValidKey[]
      const matching = keys.filter((k) => typeof k === 'string' && k.startsWith(prefix)) as string[]
      await Promise.all(matching.map((key) => tx('readwrite', (store) => store.delete(key))))
    },
  }
}

export function defaultPersistence(): PersistenceAdapter {
  if (typeof indexedDB !== 'undefined') return indexedDBPersistence()
  if (typeof localStorage !== 'undefined') return localStoragePersistence()
  return memoryPersistence()
}
