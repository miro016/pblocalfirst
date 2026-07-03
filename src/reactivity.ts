/**
 * SignalDB-style reactivity adapter contract.
 *
 * The core library is framework agnostic: every reactive read (e.g.
 * `collection.list()`) calls `depend()` on a dependency created through the
 * configured adapter, and every relevant change calls `notify()`. Plugging a
 * framework in is a matter of mapping those two calls onto its reactive
 * primitive (Angular signals, Vue refs, MobX atoms, solid signals, ...).
 */
export interface ReactiveDependency {
  /** Called during a reactive read; must register the dependency in the current reactive scope. */
  depend(): void
  /** Called when the underlying data changed; must invalidate readers. */
  notify(): void
}

export interface ReactivityAdapter {
  create(): ReactiveDependency
  /** Optional: return false to skip dependency registration outside reactive scopes. */
  isInScope?(): boolean
}

/** No-op adapter used when no framework integration is configured. */
export const noopReactivity: ReactivityAdapter = {
  create(): ReactiveDependency {
    return { depend() {}, notify() {} }
  },
}

/**
 * Build an adapter from any signal-like primitive, e.g.:
 * `signalReactivity(() => { const s = signal(0); return [() => s(), () => s.update(v => v + 1)] })`
 */
export function signalReactivity(factory: () => [read: () => void, invalidate: () => void]): ReactivityAdapter {
  return {
    create() {
      const [read, invalidate] = factory()
      return { depend: read, notify: invalidate }
    },
  }
}
