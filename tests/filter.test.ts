import { describe, expect, it } from 'vitest'
import { QueryError } from '../src/errors'
import { compileFilter, interpolateFilter, parseFilter, type EvalContext } from '../src/query/filter'
import type { BaseRecord } from '../src/types'

const users: BaseRecord[] = [
  { id: 'u1', name: 'Alice', role: 'admin' },
  { id: 'u2', name: 'Bob', role: 'editor' },
]
const posts: BaseRecord[] = [
  { id: 'p1', title: 'Hello World', views: 10, published: true, author: 'u1', tags: ['news', 'tech'], created: '2024-01-01 10:00:00.000Z', updated: '2024-01-02 10:00:00.000Z', meta: { likes: 5, info: { pinned: true } } },
  { id: 'p2', title: 'Draft post', views: 0, published: false, author: 'u2', tags: [], created: '2024-02-01 10:00:00.000Z', updated: '2024-02-02 10:00:00.000Z', meta: null },
  { id: 'p3', title: '100% legit_underscore', views: 250, published: true, author: 'u1', tags: ['tech'], created: '2024-03-01 10:00:00.000Z', updated: '2024-03-02 10:00:00.000Z', meta: { likes: 0 } },
]

const ctx: EvalContext = {
  getRelations: (collection) => (collection === 'posts' ? { author: 'users' } : undefined),
  getAll: (collection) => (collection === 'posts' ? posts : collection === 'users' ? users : undefined),
  getById: (collection, id) => (collection === 'posts' ? posts : collection === 'users' ? users : []).find((r) => r.id === id),
}

function match(filter: string, records = posts): string[] {
  const predicate = compileFilter(filter, 'posts', ctx)
  return records.filter(predicate).map((r) => r.id)
}

describe('filter parsing', () => {
  it('parses complex expressions', () => {
    expect(parseFilter('(a = 1 || b != 2) && c ~ "x"')).toBeTruthy()
  })
  it('returns null for empty filters', () => {
    expect(parseFilter('')).toBeNull()
    expect(parseFilter('   ')).toBeNull()
    expect(parseFilter(undefined)).toBeNull()
  })
  it('rejects invalid syntax', () => {
    expect(() => parseFilter('a =')).toThrow(QueryError)
    expect(() => parseFilter('a == 1')).toThrow(QueryError)
    expect(() => parseFilter('(a = 1')).toThrow(QueryError)
    expect(() => parseFilter('a = "unterminated')).toThrow(QueryError)
  })
  it('rejects server-only expressions', () => {
    expect(() => parseFilter('@request.auth.id = id')).toThrow(/API rules/)
    expect(() => parseFilter('@collection.posts.id ?= id')).toThrow(/API rules/)
    expect(() => match('geoDistance(1,2,3,4) < 100')).toThrow(/geoDistance/)
  })
})

describe('comparison operators', () => {
  it('= and !=', () => {
    expect(match('title = "Hello World"')).toEqual(['p1'])
    expect(match("title = 'Hello World'")).toEqual(['p1'])
    expect(match('title != "Hello World"')).toEqual(['p2', 'p3'])
    expect(match('views = 10')).toEqual(['p1'])
    expect(match('published = true')).toEqual(['p1', 'p3'])
    expect(match('published = false')).toEqual(['p2'])
  })

  it('numeric comparisons', () => {
    expect(match('views > 0')).toEqual(['p1', 'p3'])
    expect(match('views >= 10')).toEqual(['p1', 'p3'])
    expect(match('views < 10')).toEqual(['p2'])
    expect(match('views <= 10')).toEqual(['p1', 'p2'])
  })

  it('numeric string coercion (column affinity)', () => {
    expect(match('views = "10"')).toEqual(['p1'])
    expect(match('views > "9"')).toEqual(['p1', 'p3'])
  })

  it('date comparisons and macros', () => {
    expect(match('created >= "2024-02-01 00:00:00.000Z"')).toEqual(['p2', 'p3'])
    expect(match('created < @now')).toEqual(['p1', 'p2', 'p3'])
    expect(match('created > @now')).toEqual([])
  })

  it('null/empty normalization', () => {
    expect(match('meta = null', posts)).toEqual(['p2'])
    expect(match('missing_field = null')).toEqual(['p1', 'p2', 'p3'])
    expect(match('missing_field = ""')).toEqual(['p1', 'p2', 'p3'])
  })

  it('~ contains (case-insensitive, auto-wrapped)', () => {
    expect(match('title ~ "hello"')).toEqual(['p1'])
    expect(match('title ~ "WORLD"')).toEqual(['p1'])
    expect(match('title !~ "hello"')).toEqual(['p2', 'p3'])
  })

  it('~ with explicit wildcards', () => {
    expect(match('title ~ "Hello%"')).toEqual(['p1'])
    expect(match('title ~ "%post"')).toEqual(['p2'])
    expect(match('title ~ "Dr_ft%"')).toEqual(['p2'])
  })

  it('~ does not treat regex chars as special', () => {
    expect(match('title ~ "100%"')).toEqual(['p3']) // literal "100" then wildcard
    expect(match('title ~ "(hello)"')).toEqual([])
  })

  it('string escapes inside quotes', () => {
    const records: BaseRecord[] = [{ id: 'x1', note: "it's a \"test\"" }]
    expect(match("note = 'it\\'s a \"test\"'", records)).toEqual(['x1'])
    expect(match('note ~ "\\"test\\""', records)).toEqual(['x1'])
  })
})

describe('multi-value fields (verified against PocketBase 0.39)', () => {
  it('without :each the raw JSON text of the array is compared', () => {
    expect(match('tags ?= "tech"')).toEqual([]) // '["news","tech"]' != 'tech'
    expect(match('tags = "tech"')).toEqual([])
    expect(match('tags = \'["news","tech"]\'')).toEqual(['p1'])
    expect(match('tags ~ "tech"')).toEqual(['p1', 'p3']) // LIKE over the JSON text
    expect(match('tags ~ "news%"')).toEqual([]) // JSON text starts with '['
  })
  it('empty arrays are the JSON text "[]", not ""', () => {
    expect(match('tags = ""')).toEqual([])
    expect(match('tags != ""')).toEqual(['p1', 'p2', 'p3'])
    expect(match('tags = "[]"')).toEqual(['p2'])
  })
  it(':each ?op matches when at least one item matches', () => {
    expect(match('tags:each ?= "tech"')).toEqual(['p1', 'p3'])
    expect(match('tags:each ?= "news"')).toEqual(['p1'])
    expect(match('tags:each ?= "tech"')).not.toContain('p2')
  })
  it(':each with plain op requires all items to match (empty matches vacuously)', () => {
    expect(match('tags:each = "tech"')).toEqual(['p3'])
    expect(match('tags:each ~ "tec"')).toEqual(['p3'])
    expect(match('tags:each != "sports"')).toEqual(['p1', 'p2', 'p3'])
    expect(match('tags:each != "news"')).toEqual(['p2', 'p3'])
  })
  it(':length counts items', () => {
    expect(match('tags:length = 2')).toEqual(['p1'])
    expect(match('tags:length = 0')).toEqual(['p2'])
    expect(match('tags:length > 0')).toEqual(['p1', 'p3'])
  })
  it(':lower compares lowercased', () => {
    expect(match('title:lower = "hello world"')).toEqual(['p1'])
  })
})

describe('relation traversal', () => {
  it('follows single relations', () => {
    expect(match('author.name = "Alice"')).toEqual(['p1', 'p3'])
    expect(match('author.role != "admin"')).toEqual(['p2'])
  })
  it('compares raw relation ids on the last segment', () => {
    expect(match('author = "u1"')).toEqual(['p1', 'p3'])
  })
  it('follows back-relations with ?-operators (any-of)', () => {
    const predicate = compileFilter('posts_via_author.views ?> 100', 'users', ctx)
    expect(users.filter(predicate).map((u) => u.id)).toEqual(['u1'])
  })
  it('back-relations with plain operators require all rows to match', () => {
    const predicate = compileFilter('posts_via_author.views > 5', 'users', ctx)
    // u1's posts have views 10 and 250 (all > 5); u2's post has views 0
    expect(users.filter(predicate).map((u) => u.id)).toEqual(['u1'])
  })
  it('traversal through unknown/unconfigured fields matches nothing', () => {
    expect(match('author.company.name = "x"')).toEqual([])
  })
  it('errors helpfully when a relation target collection is not cached', () => {
    const partialCtx: EvalContext = {
      getRelations: (collection) => (collection === 'posts' ? { author: 'users' } : undefined),
      getAll: (collection) => (collection === 'posts' ? posts : undefined), // users NOT cached
      getById: () => undefined,
    }
    const predicate = compileFilter('author.name = "Alice"', 'posts', partialCtx)
    expect(() => posts.filter(predicate)).toThrow(/not cached/)
  })
})

describe('json fields', () => {
  it('traverses json paths', () => {
    expect(match('meta.likes > 0')).toEqual(['p1'])
    expect(match('meta.info.pinned = true')).toEqual(['p1'])
  })
})

describe('logical operators', () => {
  it('&&, || and parentheses', () => {
    expect(match('published = true && views > 100')).toEqual(['p3'])
    expect(match('views = 0 || views = 250')).toEqual(['p2', 'p3'])
    expect(match('(views = 0 || views = 250) && published = true')).toEqual(['p3'])
    expect(match('published = false || (tags:each ?= "news" && views >= 10)')).toEqual(['p1', 'p2'])
  })
})

describe('interpolateFilter (pb.filter compatibility)', () => {
  it('encodes values safely', () => {
    expect(interpolateFilter('a = {:s} && b = {:n} && c = {:t} && d = {:x}', { s: "o'neil", n: 5, t: true, x: null })).toBe(
      "a = 'o\\'neil' && b = 5 && c = true && d = null",
    )
  })
  it('encodes dates in PocketBase format', () => {
    expect(interpolateFilter('a >= {:d}', { d: new Date('2024-01-02T03:04:05.000Z') })).toBe("a >= '2024-01-02 03:04:05.000Z'")
  })
  it('round-trips through the parser', () => {
    const filter = interpolateFilter('title = {:t}', { t: "it's a \"test\"" })
    const records: BaseRecord[] = [{ id: 'x1', title: "it's a \"test\"" }]
    expect(match(filter, records)).toEqual(['x1'])
  })
})
