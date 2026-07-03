import { QueryError } from '../errors'
import type { BaseRecord } from '../types'
import type { EvalContext } from './filter'

/**
 * Local implementation of PocketBase's `expand` query parameter
 * (https://pocketbase.io/docs/api-records/#expanding-relations).
 *
 * - direct relations: `expand=author` / nested `expand=author,comments.user`
 * - back-relations: `expand=comments_via_post`
 * - single-value relations expand to an object, multi-value to an array;
 *   back-relations always expand to an array (like PocketBase, unless a
 *   unique index makes them single — we cannot know that locally, so arrays
 *   are always used; documented divergence).
 *
 * Expansion depth is capped at 6 levels like PocketBase.
 */

const MAX_DEPTH = 6
const VIA_RE = /^(.+)_via_(.+)$/

interface ExpandTree {
  [field: string]: ExpandTree
}

export function parseExpand(expand: string | undefined | null): ExpandTree | null {
  if (!expand || !expand.trim()) return null
  const tree: ExpandTree = {}
  for (const rawPath of expand.split(',')) {
    const path = rawPath.trim()
    if (!path) continue
    const segments = path.split('.')
    if (segments.length > MAX_DEPTH) throw new QueryError(`Expand path "${path}" exceeds the maximum depth of ${MAX_DEPTH}`)
    let node = tree
    for (const seg of segments) {
      node[seg] = node[seg] ?? {}
      node = node[seg]
    }
  }
  return tree
}

function expandRecord<T extends BaseRecord>(record: T, collection: string, tree: ExpandTree, ctx: EvalContext, depth: number): T {
  const expandObj: Record<string, unknown> = {}

  for (const field of Object.keys(tree)) {
    const childTree = tree[field]
    const via = VIA_RE.exec(field)
    const relations = ctx.getRelations(collection)

    if (relations && field in relations) {
      const target = relations[field]
      const raw = record[field]
      const isMulti = Array.isArray(raw)
      const ids: string[] = isMulti ? (raw as string[]) : raw ? [raw as string] : []
      if (ids.length === 0) continue
      const all = ctx.getAll(target)
      if (all === undefined) {
        throw new QueryError(
          `Cannot expand "${field}" locally: target collection "${target}" is not cached. Enable \`cache: true\` for it.`,
        )
      }
      const resolved: BaseRecord[] = []
      for (const id of ids) {
        const rec = ctx.getById(target, id)
        if (rec) resolved.push(maybeNest(rec, target, childTree, ctx, depth))
      }
      if (resolved.length === 0) continue
      expandObj[field] = isMulti ? resolved : resolved[0]
      continue
    }

    if (via) {
      const targetCol = via[1]
      const viaField = via[2]
      const all = ctx.getAll(targetCol)
      if (all === undefined) {
        throw new QueryError(
          `Cannot expand back-relation "${field}" locally: collection "${targetCol}" is not cached. Enable \`cache: true\` for it.`,
        )
      }
      const matches: BaseRecord[] = []
      for (const rec of all) {
        const fv = rec[viaField]
        if (fv === record.id || (Array.isArray(fv) && fv.includes(record.id))) {
          matches.push(maybeNest(rec, targetCol, childTree, ctx, depth))
        }
      }
      if (matches.length > 0) expandObj[field] = matches
      continue
    }

    throw new QueryError(
      `Cannot expand "${field}" on collection "${collection}": it is not declared in the collection's \`relations\` config ` +
        `and is not a back-relation (\`<collection>_via_<field>\`).`,
    )
  }

  // PocketBase (v0.23+) always includes the `expand` key — possibly `{}` —
  // when expansion was requested, so do the same for parity.
  return { ...record, expand: { ...(record.expand as object | undefined), ...expandObj } }
}

function maybeNest(record: BaseRecord, collection: string, childTree: ExpandTree, ctx: EvalContext, depth: number): BaseRecord {
  if (Object.keys(childTree).length === 0 || depth + 1 >= MAX_DEPTH) return record
  return expandRecord(record, collection, childTree, ctx, depth + 1)
}

/** Apply an expand expression to records; returns new record objects with `expand` populated. */
export function applyExpand<T extends BaseRecord>(records: T[], collection: string, expand: string | undefined | null, ctx: EvalContext): T[] {
  const tree = parseExpand(expand)
  if (!tree) return records
  return records.map((r) => expandRecord(r, collection, tree, ctx, 0))
}
