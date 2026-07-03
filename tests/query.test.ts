import { describe, expect, it } from 'vitest'
import { QueryError } from '../src/errors'
import { applyExpand } from '../src/query/expand'
import { applyFields } from '../src/query/fields'
import type { EvalContext } from '../src/query/filter'
import { sortRecords } from '../src/query/sort'
import type { BaseRecord } from '../src/types'

describe('sortRecords', () => {
  const records: BaseRecord[] = [
    { id: 'b', num: 2, name: 'beta', created: '2024-01-02 00:00:00.000Z' },
    { id: 'a', num: 10, name: 'alpha', created: '2024-01-01 00:00:00.000Z' },
    { id: 'c', num: 2, name: 'Gamma', created: '2024-01-03 00:00:00.000Z' },
  ]

  it('sorts ascending / descending', () => {
    expect(sortRecords(records, 'num').map((r) => r.id)).toEqual(['b', 'c', 'a'])
    expect(sortRecords(records, '-num').map((r) => r.id)).toEqual(['a', 'b', 'c'])
    expect(sortRecords(records, '+name').map((r) => r.id)).toEqual(['c', 'a', 'b']) // bytewise: 'G' < 'a'
  })

  it('sorts by multiple fields with deterministic ties', () => {
    expect(sortRecords(records, 'num,-created').map((r) => r.id)).toEqual(['c', 'b', 'a'])
  })

  it('defaults to created,id order when no sort given', () => {
    expect(sortRecords(records, undefined).map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })

  it('@random returns all records', () => {
    expect(sortRecords(records, '@random').map((r) => r.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('does not mutate the input', () => {
    const before = records.map((r) => r.id)
    sortRecords(records, '-num')
    expect(records.map((r) => r.id)).toEqual(before)
  })
})

describe('applyExpand', () => {
  const users: BaseRecord[] = [
    { id: 'u1', name: 'Alice', team: 't1' },
    { id: 'u2', name: 'Bob', team: 't1' },
  ]
  const teams: BaseRecord[] = [{ id: 't1', name: 'Core' }]
  const posts: BaseRecord[] = [
    { id: 'p1', title: 'One', author: 'u1', reviewers: ['u1', 'u2'] },
    { id: 'p2', title: 'Two', author: '', reviewers: [] },
  ]

  const relationMap: Record<string, Record<string, string>> = {
    posts: { author: 'users', reviewers: 'users' },
    users: { team: 'teams' },
  }
  const ctx: EvalContext = {
    getRelations: (collection) => relationMap[collection],
    getAll: (collection) => ({ posts, users, teams })[collection],
    getById: (collection, id) => ({ posts, users, teams })[collection]?.find((r: BaseRecord) => r.id === id),
  }

  it('expands single relations to an object', () => {
    const [expanded] = applyExpand([posts[0]], 'posts', 'author', ctx)
    expect((expanded.expand as any).author.name).toBe('Alice')
  })

  it('expands multi relations to an array', () => {
    const [expanded] = applyExpand([posts[0]], 'posts', 'reviewers', ctx)
    expect((expanded.expand as any).reviewers.map((u: BaseRecord) => u.name)).toEqual(['Alice', 'Bob'])
  })

  it('expands nested paths', () => {
    const [expanded] = applyExpand([posts[0]], 'posts', 'author.team', ctx)
    expect((expanded.expand as any).author.expand.team.name).toBe('Core')
  })

  it('expands back-relations as arrays', () => {
    const [expanded] = applyExpand([users[0]], 'users', 'posts_via_author', ctx)
    expect((expanded.expand as any).posts_via_author.map((p: BaseRecord) => p.id)).toEqual(['p1'])
  })

  it('empty relations yield an empty expand object like PocketBase v0.23+', () => {
    const [expanded] = applyExpand([posts[1]], 'posts', 'author,reviewers', ctx)
    expect(expanded.expand).toEqual({})
  })

  it('does not mutate the original record', () => {
    applyExpand([posts[0]], 'posts', 'author', ctx)
    expect(posts[0].expand).toBeUndefined()
  })

  it('throws for unknown expand fields', () => {
    expect(() => applyExpand([posts[0]], 'posts', 'nonexistent', ctx)).toThrow(QueryError)
  })
})

describe('applyFields', () => {
  const records: BaseRecord[] = [
    {
      id: 'p1',
      title: 'Hello',
      body: '<p>Some <b>long</b> html content here</p>',
      views: 5,
      expand: { author: { id: 'u1', name: 'Alice', secret: 'x' } },
    },
  ]

  it('keeps only listed fields', () => {
    expect(applyFields(records, 'id,title')).toEqual([{ id: 'p1', title: 'Hello' }])
  })

  it('supports nested expand paths', () => {
    const [out] = applyFields(records, 'id,expand.author.name')
    expect(out).toEqual({ id: 'p1', expand: { author: { name: 'Alice' } } })
  })

  it('supports wildcards', () => {
    const [out] = applyFields(records, '*')
    expect(out.title).toBe('Hello')
    expect(out.views).toBe(5)
  })

  it('supports :excerpt on strings', () => {
    const [out] = applyFields(records, 'body:excerpt(9,true)')
    expect(out.body).toBe('Some long...')
  })

  it('returns records untouched when fields is empty', () => {
    expect(applyFields(records, undefined)[0]).toBe(records[0])
  })
})
