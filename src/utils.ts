/** Shared small utilities. */

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/**
 * Generate a PocketBase-compatible record id (15 chars, lowercase alphanumeric).
 * Used for optimistic/offline record creation so relations can reference the
 * record before it reaches the server.
 */
export function generateId(length = 15): string {
  let out = ''
  const cryptoObj = typeof globalThis.crypto !== 'undefined' ? globalThis.crypto : undefined
  if (cryptoObj?.getRandomValues) {
    const bytes = new Uint8Array(length)
    cryptoObj.getRandomValues(bytes)
    for (let i = 0; i < length; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length]
  } else {
    for (let i = 0; i < length; i++) out += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)]
  }
  return out
}

/** Format a Date the way PocketBase serializes datetimes: "2006-01-02 15:04:05.000Z". */
export function toPocketBaseDate(date: Date): string {
  return date.toISOString().replace('T', ' ')
}

export function nowPocketBaseDate(): string {
  return toPocketBaseDate(new Date())
}

export function clone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value)
    } catch {
      /* fall through for non-cloneable values */
    }
  }
  return JSON.parse(JSON.stringify(value)) as T
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keysA = Object.keys(a as object)
  const keysB = Object.keys(b as object)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false
  }
  return true
}

/** Debounce that always flushes with the latest call arguments. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): ((...args: A) => void) & { flush(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: A | undefined
  const run = () => {
    timer = undefined
    if (pending) {
      const args = pending
      pending = undefined
      fn(...args)
    }
  }
  const wrapped = (...args: A) => {
    pending = args
    if (timer) clearTimeout(timer)
    timer = setTimeout(run, ms)
  }
  wrapped.flush = () => {
    if (timer) clearTimeout(timer)
    run()
  }
  return wrapped
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
