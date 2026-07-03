import type { ReactiveDependency, ReactivityAdapter } from './reactivity'

/**
 * A continuously updated query result. Framework-agnostic: read `.value`
 * inside a reactive computation (Angular `computed`, ...) or attach a plain
 * callback with `subscribe`. Call `dispose()` when done.
 */
export interface LiveQuery<V> {
  readonly value: V
  subscribe(listener: (value: V) => void): () => void
  /** Force a recompute/refetch (mainly useful for remote-backed live queries). */
  refresh(): Promise<void>
  dispose(): void
}

interface LiveQuerySource<V> {
  compute(): V | Promise<V>
  /** Wire invalidation; call the passed callback whenever compute() would return something new. */
  connect(invalidate: () => void): () => void
}

export function createLiveQuery<V>(initial: V, source: LiveQuerySource<V>, reactivity: ReactivityAdapter): LiveQuery<V> {
  let current = initial
  let disposed = false
  const listeners = new Set<(value: V) => void>()
  const dep: ReactiveDependency = reactivity.create()

  const apply = (value: V) => {
    current = value
    dep.notify()
    for (const listener of [...listeners]) listener(value)
  }

  const recompute = async (): Promise<void> => {
    if (disposed) return
    const result = await source.compute()
    if (!disposed) apply(result)
  }

  const disconnect = source.connect(() => void recompute())
  void recompute()

  return {
    get value() {
      dep.depend()
      return current
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refresh: recompute,
    dispose() {
      disposed = true
      listeners.clear()
      disconnect()
    },
  }
}
