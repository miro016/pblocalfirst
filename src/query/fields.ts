import type { BaseRecord } from '../types'

/**
 * Local implementation of PocketBase's `fields` query parameter: a comma
 * separated list of paths to keep in the response, `*` as wildcard segment,
 * and the `:excerpt(max, withEllipsis?)` modifier for string values.
 */

interface FieldPath {
  segments: string[]
  excerpt?: { max: number; ellipsis: boolean }
}

const EXCERPT_RE = /^(.*?):excerpt\(\s*(\d+)\s*(?:,\s*(true|false)\s*)?\)$/

/** Split on commas that are not inside parentheses (`:excerpt(200,true)`). */
function splitFields(fields: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of fields) {
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  parts.push(current)
  return parts
}

export function parseFields(fields: string | undefined | null): FieldPath[] | null {
  if (!fields || !fields.trim()) return null
  const out: FieldPath[] = []
  for (const rawPart of splitFields(fields)) {
    const part = rawPart.trim()
    if (!part) continue
    const excerptMatch = EXCERPT_RE.exec(part)
    if (excerptMatch) {
      out.push({
        segments: excerptMatch[1].split('.'),
        excerpt: { max: parseInt(excerptMatch[2], 10), ellipsis: excerptMatch[3] === 'true' },
      })
    } else {
      out.push({ segments: part.split('.') })
    }
  }
  return out.length > 0 ? out : null
}

function excerptValue(value: unknown, max: number, ellipsis: boolean): unknown {
  if (typeof value !== 'string') return value
  // strip html tags like PocketBase's excerpt modifier, then truncate
  const text = value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= max) return text
  return text.slice(0, max).trimEnd() + (ellipsis ? '...' : '')
}

function pickInto(target: Record<string, unknown>, source: unknown, segments: string[], excerpt?: FieldPath['excerpt']): void {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return
  const src = source as Record<string, unknown>
  const [seg, ...rest] = segments
  const keys = seg === '*' ? Object.keys(src) : seg in src ? [seg] : []
  for (const key of keys) {
    const value = src[key]
    if (rest.length === 0) {
      target[key] = excerpt ? excerptValue(value, excerpt.max, excerpt.ellipsis) : value
      continue
    }
    if (Array.isArray(value)) {
      const existing = target[key]
      const arr: Record<string, unknown>[] = Array.isArray(existing) ? (existing as Record<string, unknown>[]) : value.map(() => ({}))
      value.forEach((item, i) => pickInto(arr[i], item, rest, excerpt))
      target[key] = arr
    } else if (value !== null && typeof value === 'object') {
      const nested = (target[key] as Record<string, unknown>) ?? {}
      pickInto(nested, value, rest, excerpt)
      target[key] = nested
    }
  }
}

/** Apply a `fields` expression to records. Returns new objects; no-op when fields is empty. */
export function applyFields<T extends BaseRecord>(records: T[], fields: string | undefined | null): T[] {
  const paths = parseFields(fields)
  if (!paths) return records
  return records.map((record) => {
    const out: Record<string, unknown> = {}
    for (const path of paths) pickInto(out, record, path.segments, path.excerpt)
    return out as T
  })
}
