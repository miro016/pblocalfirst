import { QueryError } from '../errors'
import type { BaseRecord } from '../types'
import { compareValues } from './compare'

/**
 * PocketBase sort syntax: comma separated fields, `-` prefix for DESC
 * (e.g. `-created,title`). `@random` shuffles. Ties keep a deterministic
 * order (created, then id) so paginated local reads are stable — the remote
 * server's tie order (rowid) is unspecified anyway.
 */

interface SortField {
  path: string[]
  desc: boolean
}

function parseSort(sort: string): { fields: SortField[]; random: boolean } {
  const fields: SortField[] = []
  for (const rawPart of sort.split(',')) {
    const part = rawPart.trim()
    if (!part) continue
    if (part === '@random' || part === '-@random' || part === '+@random') return { fields: [], random: true }
    if (part === '@rowid' || part === '-@rowid' || part === '+@rowid') {
      // rowid ~ insertion order; approximate with created,id below
      fields.push({ path: ['created'], desc: part.startsWith('-') }, { path: ['id'], desc: part.startsWith('-') })
      continue
    }
    let desc = false
    let name = part
    if (part.startsWith('-')) {
      desc = true
      name = part.slice(1)
    } else if (part.startsWith('+')) {
      name = part.slice(1)
    }
    if (!name || name.startsWith('@')) throw new QueryError(`Unsupported sort expression "${part}"`)
    fields.push({ path: name.split('.'), desc })
  }
  return { fields, random: false }
}

function valueAt(record: BaseRecord, path: string[]): unknown {
  let v: unknown = record
  for (const seg of path) {
    if (v === null || v === undefined || typeof v !== 'object') return undefined
    v = (v as Record<string, unknown>)[seg]
  }
  return v
}

function toSortScalar(v: unknown): string | number | boolean | null | undefined {
  if (v === null || v === undefined) return v as null | undefined
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  return JSON.stringify(v)
}

export function sortRecords<T extends BaseRecord>(records: T[], sort: string | undefined | null): T[] {
  const out = [...records]
  if (!sort || !sort.trim()) {
    // no explicit sort: keep deterministic insertion-like order (created, id)
    out.sort((a, b) => compareValues(a.created, b.created) || compareValues(a.id, b.id))
    return out
  }
  const { fields, random } = parseSort(sort)
  if (random) {
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[out[i], out[j]] = [out[j], out[i]]
    }
    return out
  }
  out.sort((a, b) => {
    for (const field of fields) {
      const cmp = compareValues(toSortScalar(valueAt(a, field.path)), toSortScalar(valueAt(b, field.path)))
      if (cmp !== 0) return field.desc ? -cmp : cmp
    }
    // deterministic tiebreaker for stable pagination
    return compareValues(a.created, b.created) || compareValues(a.id, b.id)
  })
  return out
}
