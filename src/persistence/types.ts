/**
 * Key/value persistence used for cached collections, sync cursors and the
 * offline write queue. Implement this to plug in a custom storage
 * (SQLite, capacitor storage, ...).
 */
export interface PersistenceAdapter {
  load(key: string): Promise<unknown | undefined>
  save(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  /** Remove every key starting with `prefix` (used when the auth user changes). */
  clear(prefix: string): Promise<void>
}
