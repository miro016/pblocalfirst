/**
 * Value comparison that mirrors how PocketBase (SQLite) compares values, so
 * local query results match remote ones:
 *
 * - `null`/`undefined` are treated as `""` (PocketBase normalizes empty
 *   values with COALESCE(x, '') in generated queries).
 * - booleans behave like 0/1 (SQLite TRUE/FALSE).
 * - a number compared with a numeric string is compared numerically
 *   (numeric column affinity).
 * - otherwise SQLite's type ordering applies: numbers < text.
 * - text compares bytewise (JS string comparison matches for ASCII).
 */

export type Scalar = string | number | boolean | null | undefined

function normalize(v: Scalar): string | number {
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean') return v ? 1 : 0
  return v
}

function asNumber(v: string | number): number | null {
  if (typeof v === 'number') return v
  if (v.trim() === '') return null
  const n = Number(v)
  return Number.isNaN(n) ? null : n
}

/** Returns negative/zero/positive like a comparator. Total order (never null). */
export function compareValues(a: Scalar, b: Scalar): number {
  const l = normalize(a)
  const r = normalize(b)
  if (typeof l === 'number' || typeof r === 'number') {
    const ln = typeof l === 'number' ? l : asNumber(l)
    const rn = typeof r === 'number' ? r : asNumber(r)
    if (ln !== null && rn !== null) return ln < rn ? -1 : ln > rn ? 1 : 0
    // SQLite type ordering: numbers sort before text
    if (typeof l === 'number' && typeof r !== 'number') return -1
    if (typeof r === 'number' && typeof l !== 'number') return 1
  }
  const ls = String(l)
  const rs = String(r)
  return ls < rs ? -1 : ls > rs ? 1 : 0
}

export function equalValues(a: Scalar, b: Scalar): boolean {
  return compareValues(a, b) === 0
}

/**
 * SQLite LIKE semantics: `%` = any sequence, `_` = any single char,
 * case-insensitive. PocketBase auto-wraps the operand in `%...%` when it
 * contains no explicit `%`.
 */
export function likeValues(value: Scalar, pattern: Scalar): boolean {
  const v = value === null || value === undefined ? '' : String(typeof value === 'boolean' ? (value ? 1 : 0) : value)
  let p = pattern === null || pattern === undefined ? '' : String(typeof pattern === 'boolean' ? (pattern ? 1 : 0) : pattern)
  if (!p.includes('%')) p = `%${p}%`
  const regex = likePatternToRegex(p)
  return regex.test(v)
}

const likeRegexCache = new Map<string, RegExp>()

function likePatternToRegex(pattern: string): RegExp {
  let cached = likeRegexCache.get(pattern)
  if (cached) return cached
  let out = '^'
  for (const ch of pattern) {
    if (ch === '%') out += '[\\s\\S]*'
    else if (ch === '_') out += '[\\s\\S]'
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  out += '$'
  cached = new RegExp(out, 'i')
  if (likeRegexCache.size > 500) likeRegexCache.clear()
  likeRegexCache.set(pattern, cached)
  return cached
}
