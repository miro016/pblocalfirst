import { QueryError } from '../errors'
import type { BaseRecord } from '../types'
import { toPocketBaseDate, nowPocketBaseDate } from '../utils'
import { compareValues, equalValues, likeValues } from './compare'

/**
 * Parser + evaluator for PocketBase's filter syntax
 * (https://pocketbase.io/docs/api-records/#listsearch-records), so filters
 * produce identical results whether they run against the local cache or the
 * remote server.
 *
 * Supported: all comparison operators (= != > >= < <= ~ !~ and their `?`
 * "any-of" variants), && / || / parentheses, quoted strings with escapes,
 * numbers, booleans, null, datetime macros (@now, @todayStart, ...), field
 * paths incl. relation traversal (`author.name`), back-relations
 * (`comments_via_post.text`), json paths, and the :each/:length/:lower
 * field modifiers.
 *
 * Not supported (throws QueryError): @request.*, @collection.* (API-rule
 * only) and geoDistance().
 */

export type CmpOp = '=' | '!=' | '>' | '>=' | '<' | '<=' | '~' | '!~'

export type Operand =
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'ident'; path: string[]; modifier?: 'each' | 'length' | 'lower' }
  | { kind: 'macro'; name: string }

export type FilterNode =
  | { type: 'logic'; op: '&&' | '||'; left: FilterNode; right: FilterNode }
  | { type: 'cmp'; op: CmpOp; any: boolean; left: Operand; right: Operand }

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { type: 'lparen' | 'rparen' | 'and' | 'or' }
  | { type: 'op'; op: CmpOp; any: boolean }
  | { type: 'string'; value: string }
  | { type: 'number'; value: number }
  | { type: 'ident'; value: string }

const OPERATORS: Array<[string, CmpOp, boolean]> = [
  ['?!~', '!~', true],
  ['?!=', '!=', true],
  ['?>=', '>=', true],
  ['?<=', '<=', true],
  ['?=', '=', true],
  ['?~', '~', true],
  ['?>', '>', true],
  ['?<', '<', true],
  ['!~', '!~', false],
  ['!=', '!=', false],
  ['>=', '>=', false],
  ['<=', '<=', false],
  ['=', '=', false],
  ['~', '~', false],
  ['>', '>', false],
  ['<', '<', false],
]

const IDENT_START = /[A-Za-z_@]/
const IDENT_CHAR = /[A-Za-z0-9_.:@]/

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  outer: while (i < input.length) {
    const ch = input[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++
      continue
    }
    if (ch === '(') {
      tokens.push({ type: 'lparen' })
      i++
      continue
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen' })
      i++
      continue
    }
    if (input.startsWith('&&', i)) {
      tokens.push({ type: 'and' })
      i += 2
      continue
    }
    if (input.startsWith('||', i)) {
      tokens.push({ type: 'or' })
      i += 2
      continue
    }
    for (const [text, op, any] of OPERATORS) {
      if (input.startsWith(text, i)) {
        tokens.push({ type: 'op', op, any })
        i += text.length
        continue outer
      }
    }
    if (ch === "'" || ch === '"') {
      let value = ''
      i++
      let closed = false
      while (i < input.length) {
        const c = input[i]
        if (c === '\\' && i + 1 < input.length) {
          const next = input[i + 1]
          if (next === ch || next === '\\') {
            value += next
            i += 2
            continue
          }
          value += c
          i++
          continue
        }
        if (c === ch) {
          closed = true
          i++
          break
        }
        value += c
        i++
      }
      if (!closed) throw new QueryError(`Unterminated string in filter: ${input}`)
      tokens.push({ type: 'string', value })
      continue
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i + 1
      while (j < input.length && /[0-9.]/.test(input[j])) j++
      const raw = input.slice(i, j)
      const num = Number(raw)
      if (Number.isNaN(num)) throw new QueryError(`Invalid number "${raw}" in filter`)
      tokens.push({ type: 'number', value: num })
      i = j
      continue
    }
    if (IDENT_START.test(ch)) {
      let j = i + 1
      while (j < input.length && IDENT_CHAR.test(input[j])) j++
      tokens.push({ type: 'ident', value: input.slice(i, j) })
      i = j
      continue
    }
    throw new QueryError(`Unexpected character "${ch}" at position ${i} in filter: ${input}`)
  }
  return tokens
}

// ---------------------------------------------------------------------------
// Parser (recursive descent)
// ---------------------------------------------------------------------------

class Parser {
  private pos = 0
  constructor(
    private tokens: Token[],
    private source: string,
  ) {}

  parse(): FilterNode {
    const node = this.parseOr()
    if (this.pos < this.tokens.length) throw new QueryError(`Unexpected trailing tokens in filter: ${this.source}`)
    return node
  }

  private parseOr(): FilterNode {
    let left = this.parseAnd()
    while (this.peek()?.type === 'or') {
      this.pos++
      left = { type: 'logic', op: '||', left, right: this.parseAnd() }
    }
    return left
  }

  private parseAnd(): FilterNode {
    let left = this.parsePrimary()
    while (this.peek()?.type === 'and') {
      this.pos++
      left = { type: 'logic', op: '&&', left, right: this.parsePrimary() }
    }
    return left
  }

  private parsePrimary(): FilterNode {
    const tok = this.peek()
    if (!tok) throw new QueryError(`Unexpected end of filter: ${this.source}`)
    if (tok.type === 'lparen') {
      this.pos++
      const inner = this.parseOr()
      if (this.peek()?.type !== 'rparen') throw new QueryError(`Missing ")" in filter: ${this.source}`)
      this.pos++
      return inner
    }
    const left = this.parseOperand()
    const opTok = this.peek()
    if (!opTok || opTok.type !== 'op') throw new QueryError(`Expected comparison operator in filter: ${this.source}`)
    this.pos++
    const right = this.parseOperand()
    return { type: 'cmp', op: opTok.op, any: opTok.any, left, right }
  }

  private parseOperand(): Operand {
    const tok = this.peek()
    if (!tok) throw new QueryError(`Unexpected end of filter: ${this.source}`)
    this.pos++
    if (tok.type === 'string') return { kind: 'literal', value: tok.value }
    if (tok.type === 'number') return { kind: 'literal', value: tok.value }
    if (tok.type === 'ident') {
      const name = tok.value
      if (name === 'true') return { kind: 'literal', value: true }
      if (name === 'false') return { kind: 'literal', value: false }
      if (name === 'null') return { kind: 'literal', value: null }
      if (name === 'geoDistance') throw new QueryError('geoDistance() is not supported in locally evaluated filters')
      if (name.startsWith('@')) {
        if (name.startsWith('@request') || name.startsWith('@collection')) {
          throw new QueryError(`"${name}" is only available in server-side API rules and cannot be used in record filters`)
        }
        return { kind: 'macro', name }
      }
      return parseIdent(name)
    }
    throw new QueryError(`Unexpected token in filter: ${this.source}`)
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos]
  }
}

function parseIdent(name: string): Operand {
  let modifier: 'each' | 'length' | 'lower' | undefined
  let fieldPart = name
  const colon = name.indexOf(':')
  if (colon !== -1) {
    const mod = name.slice(colon + 1)
    fieldPart = name.slice(0, colon)
    if (mod === 'each' || mod === 'length' || mod === 'lower') modifier = mod
    else if (mod === 'isset') throw new QueryError(`":isset" is only available for @request.* fields in API rules`)
    else throw new QueryError(`Unsupported field modifier ":${mod}"`)
  }
  const path = fieldPart.split('.').filter((s) => s.length > 0)
  if (path.length === 0) throw new QueryError(`Invalid field name "${name}" in filter`)
  return { kind: 'ident', path, modifier }
}

// ---------------------------------------------------------------------------
// Datetime macros
// ---------------------------------------------------------------------------

function resolveMacro(name: string): string | number {
  const now = new Date()
  switch (name) {
    case '@now':
      return toPocketBaseDate(now)
    case '@yesterday':
      return toPocketBaseDate(new Date(now.getTime() - 24 * 3600_000))
    case '@tomorrow':
      return toPocketBaseDate(new Date(now.getTime() + 24 * 3600_000))
    case '@second':
      return now.getUTCSeconds()
    case '@minute':
      return now.getUTCMinutes()
    case '@hour':
      return now.getUTCHours()
    case '@weekday':
      return now.getUTCDay()
    case '@day':
      return now.getUTCDate()
    case '@month':
      return now.getUTCMonth() + 1
    case '@year':
      return now.getUTCFullYear()
    case '@todayStart':
      return toPocketBaseDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())))
    case '@todayEnd':
      return toPocketBaseDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999)))
    case '@monthStart':
      return toPocketBaseDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)))
    case '@monthEnd':
      return toPocketBaseDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999)))
    case '@yearStart':
      return toPocketBaseDate(new Date(Date.UTC(now.getUTCFullYear(), 0, 1)))
    case '@yearEnd':
      return toPocketBaseDate(new Date(Date.UTC(now.getUTCFullYear(), 11, 31, 23, 59, 59, 999)))
    default:
      throw new QueryError(`Unknown macro "${name}" in filter`)
  }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Data access the evaluator needs to traverse relations. Backed by the local
 * stores; collections that are not cached return `undefined` which turns
 * into a descriptive QueryError when a filter tries to traverse into them.
 */
export interface EvalContext {
  /** Relation map (field -> target collection) for a collection, if configured. */
  getRelations(collection: string): Record<string, string> | undefined
  /** All cached records of a collection, or undefined when the collection is not cached. */
  getAll(collection: string): BaseRecord[] | undefined
  getById(collection: string, id: string): BaseRecord | undefined
}

interface Resolved {
  values: unknown[]
  multi: boolean
}

const VIA_RE = /^(.+)_via_(.+)$/

function resolveIdent(record: BaseRecord, collection: string, operand: Extract<Operand, { kind: 'ident' }>, ctx: EvalContext): Resolved {
  const { path, modifier } = operand
  let current: Array<{ value: unknown; collection: string | null }> = [{ value: record, collection }]
  let multi = false

  for (let s = 0; s < path.length; s++) {
    const seg = path[s]
    const isLast = s === path.length - 1
    const next: Array<{ value: unknown; collection: string | null }> = []

    for (const entry of current) {
      const { value, collection: col } = entry
      if (value === null || value === undefined) {
        next.push({ value: undefined, collection: null })
        continue
      }

      // back-relation: `<targetCollection>_via_<field>`
      const via = VIA_RE.exec(seg)
      if (via && typeof value === 'object' && (value as BaseRecord).id) {
        const targetCol = via[1]
        const viaField = via[2]
        const all = ctx.getAll(targetCol)
        if (all === undefined) {
          throw new QueryError(
            `Cannot evaluate back-relation "${seg}" locally: collection "${targetCol}" is not cached. ` +
              `Enable \`cache: true\` for it or run this query against the remote server.`,
          )
        }
        multi = true
        const id = (value as BaseRecord).id
        for (const rec of all) {
          const fv = rec[viaField]
          if (fv === id || (Array.isArray(fv) && fv.includes(id))) {
            next.push({ value: isLast ? rec.id : rec, collection: targetCol })
          }
        }
        continue
      }

      if (typeof value !== 'object') {
        // trying to go deeper into a scalar — likely an unconfigured relation
        if (typeof value === 'string' && col === null) {
          throw new QueryError(
            `Cannot traverse "${path.join('.')}": "${seg}" is reached through a plain value. ` +
              `If this is a relation, declare it in the collection's \`relations\` config.`,
          )
        }
        next.push({ value: undefined, collection: null })
        continue
      }

      const child = (value as Record<string, unknown>)[seg]
      const relations = col ? ctx.getRelations(col) : undefined
      const relTarget = relations?.[seg]

      if (relTarget && !isLast) {
        // dereference relation id(s) into records
        const ids = Array.isArray(child) ? child : child ? [child] : []
        if (Array.isArray(child)) multi = true
        const cached = ctx.getAll(relTarget)
        if (cached === undefined) {
          throw new QueryError(
            `Cannot evaluate relation "${path.slice(0, s + 1).join('.')}" locally: target collection "${relTarget}" is not cached. ` +
              `Enable \`cache: true\` for it or run this query against the remote server.`,
          )
        }
        for (const id of ids) {
          const rec = typeof id === 'string' ? ctx.getById(relTarget, id) : undefined
          next.push({ value: rec, collection: relTarget })
        }
        if (ids.length === 0) next.push({ value: undefined, collection: relTarget })
        continue
      }

      if (relTarget && isLast && child !== undefined && child !== null && typeof child === 'object' && !Array.isArray(child)) {
        // shouldn't happen for relation values, but keep raw
        next.push({ value: child, collection: null })
        continue
      }

      if (Array.isArray(child) && !isLast) {
        multi = true
        for (const item of child) next.push({ value: item, collection: null })
        continue
      }

      next.push({ value: child, collection: relTarget ?? null })
    }
    current = next
  }

  // Terminal array values (multi-select/relation/file, json arrays) compare
  // as their raw JSON text — matching PocketBase/SQLite, where the column
  // holds the serialized array. Only the `:each` modifier unwraps items.
  // (Values produced by relation traversal were already unwrapped above —
  // that mirrors PocketBase's join semantics.)
  let values: unknown[] = []
  for (const entry of current) {
    const v = entry.value
    if (Array.isArray(v)) {
      if (modifier === 'each') {
        values.push(...v)
        multi = true
      } else {
        values.push(JSON.stringify(v))
      }
    } else {
      values.push(v)
    }
  }
  multi = multi || modifier === 'each'

  if (modifier === 'length') {
    // :length counts items of multi-value fields; undefined/empty -> 0
    let count = 0
    for (const entry of current) {
      const v = entry.value
      if (Array.isArray(v)) count += v.length
      else if (v !== undefined && v !== null && v !== '') count += 1
    }
    return { values: [count], multi: false }
  }
  if (modifier === 'lower') {
    values = values.map((v) => (typeof v === 'string' ? v.toLowerCase() : v))
  }
  return { values, multi }
}

function resolveOperand(record: BaseRecord, collection: string, operand: Operand, ctx: EvalContext): Resolved {
  if (operand.kind === 'literal') return { values: [operand.value], multi: false }
  if (operand.kind === 'macro') return { values: [resolveMacro(operand.name)], multi: false }
  return resolveIdent(record, collection, operand, ctx)
}

type Scalarish = string | number | boolean | null | undefined

function applyOp(op: CmpOp, l: Scalarish, r: Scalarish): boolean {
  switch (op) {
    case '=':
      // PocketBase normalizes empty values (COALESCE(x, '')) for equality
      return equalValues(l, r)
    case '!=':
      return !equalValues(l, r)
    // ordering follows SQL NULL semantics: comparisons with NULL are false
    case '>':
      return l != null && r != null && compareValues(l, r) > 0
    case '>=':
      return l != null && r != null && compareValues(l, r) >= 0
    case '<':
      return l != null && r != null && compareValues(l, r) < 0
    case '<=':
      return l != null && r != null && compareValues(l, r) <= 0
    case '~':
      return likeValues(l, r)
    case '!~':
      return !likeValues(l, r)
  }
}

function toScalar(v: unknown): Scalarish {
  if (v === null || v === undefined) return v as null | undefined
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  // json objects/arrays compared as their JSON text (mirrors json_extract text output)
  return JSON.stringify(v)
}

function evalCmp(node: Extract<FilterNode, { type: 'cmp' }>, record: BaseRecord, collection: string, ctx: EvalContext): boolean {
  const left = resolveOperand(record, collection, node.left, ctx)
  const right = resolveOperand(record, collection, node.right, ctx)
  // Empty multi-value sets behave like a single empty value (PB compares
  // empty arrays as "" through COALESCE-style normalization).
  const ls = left.values.length > 0 ? left.values : [undefined]
  const rs = right.values.length > 0 ? right.values : [undefined]
  const test = (l: unknown, r: unknown) => applyOp(node.op, toScalar(l), toScalar(r))
  if (node.any) {
    // ?op : at least one combination matches
    return ls.some((l) => rs.some((r) => test(l, r)))
  }
  // plain op on multi-value: every item must match
  return ls.every((l) => rs.every((r) => test(l, r)))
}

export function evaluateFilter(node: FilterNode, record: BaseRecord, collection: string, ctx: EvalContext): boolean {
  if (node.type === 'logic') {
    if (node.op === '&&') return evaluateFilter(node.left, record, collection, ctx) && evaluateFilter(node.right, record, collection, ctx)
    return evaluateFilter(node.left, record, collection, ctx) || evaluateFilter(node.right, record, collection, ctx)
  }
  return evalCmp(node, record, collection, ctx)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const parseCache = new Map<string, FilterNode>()

/** Parse a PocketBase filter string; returns null for empty filters. */
export function parseFilter(filter: string | undefined | null): FilterNode | null {
  if (!filter || !filter.trim()) return null
  let node = parseCache.get(filter)
  if (!node) {
    node = new Parser(tokenize(filter), filter).parse()
    if (parseCache.size > 500) parseCache.clear()
    parseCache.set(filter, node)
  }
  return node
}

/** Compile a filter into a predicate over records of `collection`. */
export function compileFilter(filter: string | undefined | null, collection: string, ctx: EvalContext): (record: BaseRecord) => boolean {
  const ast = parseFilter(filter)
  if (!ast) return () => true
  return (record) => evaluateFilter(ast, record, collection, ctx)
}

/**
 * Placeholder interpolation compatible with `pb.filter("a = {:name}", {...})`
 * from the PocketBase JS SDK.
 */
export function interpolateFilter(raw: string, params?: Record<string, unknown>): string {
  if (!params) return raw
  return raw.replace(/\{:(\w+)\}/g, (match, key: string) => {
    if (!(key in params)) return match
    const value = params[key]
    if (value === null || value === undefined) return 'null'
    if (typeof value === 'number') return String(value)
    if (typeof value === 'boolean') return value ? 'true' : 'false'
    if (value instanceof Date) return `'${toPocketBaseDate(value)}'`
    if (typeof value === 'string') return `'${value.replace(/'/g, "\\'")}'`
    return `'${JSON.stringify(value).replace(/'/g, "\\'")}'`
  })
}

export { nowPocketBaseDate }
