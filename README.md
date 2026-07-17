# @miro016/pocketbase-localfirst

A local-first, signal-reactive data layer for [PocketBase](https://pocketbase.io), inspired by [SignalDB](https://signaldb.js.org) but built specifically for PocketBase and typed end-to-end via [pocketbase-typegen](https://github.com/patmood/pocketbase-typegen).

Declare which collections are cached on the client. Then use the same API you know from the PocketBase JS SDK — `getList`, `getFullList`, `getOne`, `getFirstListItem`, `create`, `update`, `delete`, `subscribe` — and the library transparently answers from a local, automatically synced database (or passes through to the server for non-cached collections). Filters, sorting, `expand` and `fields` are evaluated locally with PocketBase-compatible semantics, so **a query returns the same results whether it runs against the local db or the remote API**.

- **Works offline.** Cached collections are persisted (IndexedDB by default) and readable/writable without a connection. Writes are queued and replayed in order when the server is reachable again.
- **Everything is live.** Remote changes stream in over PocketBase realtime and update local queries, signals and subscriptions immediately. Local writes are applied optimistically.
- **Conflicts resolve automatically.** Last-update-wins by default, with a hook for your own resolver (per collection or global).
- **Angular-first, framework-agnostic.** Reactive reads integrate with Angular signals out of the box (`@miro016/pocketbase-localfirst/angular`); a tiny adapter interface plugs into any other signal system, and callback-based live queries work everywhere.
- **Verified against a real server.** `scripts/parity-check.mjs` runs a matrix of filters/sorts/expands against both the local engine and a real PocketBase instance and asserts identical results, plus end-to-end realtime and offline-replay scenarios.

## Installation

```sh
npm install @miro016/pocketbase-localfirst pocketbase
```

`pocketbase` (SDK ≥ 0.21) is a peer dependency. `@angular/core` ≥ 17 is an optional peer dependency, needed only for the Angular adapter.

## Quick start

Generate types from your PocketBase instance with pocketbase-typegen:

```sh
npx pocketbase-typegen --url https://your.pocketbase.io --email admin@example.com --password pass --out src/pocketbase-types.ts
```

Create the client:

```ts
import PocketBase from 'pocketbase'
import { createLocalFirst } from '@miro016/pocketbase-localfirst'
import type { CollectionResponses } from './pocketbase-types' // generated

const pb = new PocketBase('https://your.pocketbase.io')

export const lf = createLocalFirst<CollectionResponses>({
  pb,
  collections: {
    // cached: reads/queries/realtime run against the local db, work offline
    posts: {
      cache: true,
      // relation fields -> target collection, so `expand` and relation
      // filters (`author.name = "x"`) can be resolved locally
      relations: { author: 'users' },
      // optionally cache only a subset:
      // sync: { filter: 'owner = "abc"' },
    },
    users: { cache: true },

    // not cached: every call passes through to the server, like the plain SDK
    audit_logs: {},
  },
})
```

Use it like the PocketBase SDK — results are identical, but served locally, instantly, and offline:

```ts
const page = await lf.collection('posts').getList(1, 20, {
  filter: lf.filter('published = {:p} && views > {:min}', { p: true, min: 10 }),
  sort: '-created',
  expand: 'author',
})

const post = await lf.collection('posts').getOne(id, { expand: 'author' })
const created = await lf.collection('posts').create({ title: 'Hello' })
await lf.collection('posts').update(created.id, { 'views+': 1 })
await lf.collection('posts').delete(created.id)

// realtime-compatible subscriptions, driven by the local db:
// fires for remote realtime changes AND local (optimistic/offline) writes
const unsub = await lf.collection('posts').subscribe('*', (e) => {
  console.log(e.action, e.record)
}, { filter: 'published = true', expand: 'author' })
```

## Angular

```ts
// app.config.ts
import { provideLocalFirst } from '@miro016/pocketbase-localfirst/angular'

export const appConfig: ApplicationConfig = {
  providers: [
    provideLocalFirst(() => ({
      pb: new PocketBase(environment.pbUrl),
      collections: {
        posts: { cache: true, relations: { author: 'users' } },
        users: { cache: true },
      },
    })),
  ],
}
```

```ts
// posts.component.ts
import { Component, computed } from '@angular/core'
import { injectLocalFirst } from '@miro016/pocketbase-localfirst/angular'
import type { CollectionResponses } from '../pocketbase-types'

@Component({
  selector: 'app-posts',
  template: `
    @if (!status().online) { <p>offline — {{ status().pending }} changes pending</p> }
    @for (post of posts(); track post.id) {
      <article>{{ post.title }} by {{ post.expand?.author?.name }}</article>
    }
  `,
})
export class PostsComponent {
  private lf = injectLocalFirst<CollectionResponses>()

  // recomputes automatically whenever local data changes (sync, realtime, local writes)
  posts = computed(() => this.lf.collection('posts').list({ filter: 'published = true', sort: '-created', expand: 'author' }))
  status = computed(() => this.lf.status)

  async publish(id: string) {
    await this.lf.collection('posts').update(id, { published: true }) // optimistic + synced
  }
}
```

`provideLocalFirst` installs the Angular signals reactivity adapter automatically, so every reactive read (`list`, `one`, `first`, `count`, `client.status`, `liveQuery.value`) participates in Angular's change detection.

## Other frameworks / vanilla JS

Reactive reads use a tiny SignalDB-style adapter interface — implement two functions to integrate any signal library:

```ts
import { createLocalFirst, signalReactivity } from '@miro016/pocketbase-localfirst'
// e.g. for Vue: depend -> track a ref, notify -> bump it
const vueReactivity = signalReactivity(() => {
  const version = shallowRef(0)
  return [() => { void version.value }, () => { version.value++ }]
})
```

Or skip signals entirely and use live queries / subscriptions:

```ts
const live = lf.collection('posts').liveList({ filter: 'published = true', sort: '-created' })
const stop = live.subscribe((posts) => render(posts))
// live.value is always current; live.dispose() when done

// liveList/liveOne also work for NON-cached collections: they refetch from
// the server whenever a realtime event for the collection arrives.
```

## How syncing works

1. **Start** (automatic; pass `autoStart: false` to control it): persisted local data is loaded so the app is usable immediately, even offline.
2. **Initial sync / reconcile:** for each cached collection the engine pulls an id+`updated` index, fetches new/changed records, and removes records deleted remotely. Reads issued before the first sync finishes wait for it (only when there is no persisted data yet), so a cold start never answers from a half-filled cache.
3. **Realtime:** each cached collection subscribes to PocketBase realtime; creates/updates/deletes stream into the local db and notify queries, signals, live queries and subscriptions.
4. **Reconcile loop:** a full reconcile runs on reconnect, after auth changes, on `lf.sync()`, and periodically (`reconcileIntervalMs`, default 5 min) to catch anything realtime missed (e.g. deletions while offline).
5. **Writes** are applied to the local db immediately and queued (persisted, ordered across collections so offline-created relations replay parent-first). When online, the write is pushed right away and the returned promise resolves with the server record, exactly like the SDK; offline it resolves with the optimistic record. Server-rejected writes (validation, auth) are rolled back locally — the promise rejects, or `onSyncError` fires for queued offline writes.
6. **Connectivity** is tracked via request outcomes, browser online/offline events, and a health poll while offline. `lf.status` (reactive) exposes `{ online, syncing, pending, lastSyncedAt }`.
7. **Auth changes:** when the authenticated user changes (login/logout), the local cache and pending queue are cleared and cached collections resync under the new identity. Token refreshes for the same user are ignored.

### Conflict resolution

If a record changed both locally (not yet pushed) and remotely, the default policy is **last-update-wins** (comparing the remote `updated` timestamp with the local change time; note this involves the client clock). A remote *deletion* wins over a concurrent local edit by default.

Override it globally or per collection:

```ts
createLocalFirst({
  pb,
  collections: {
    posts: {
      cache: true,
      conflictResolver: ({ local, remote, base }) => {
        if (!remote) return local            // record deleted remotely: keep ours (it will be re-created)
        if (!local) return remote            // deleted locally: let the remote version win
        return { ...remote, body: local.body } // field-level merge
      },
    },
  },
})
```

Return the record that should win (kept locally and pushed to the server) or `null` to let the delete win. Resolvers may be async.

## Configuration reference

```ts
createLocalFirst<Schema>({
  pb,                                  // PocketBase SDK instance (typegen's TypedPocketBase works)
  collections: { [name]: {
    cache?: boolean,                   // default false = remote passthrough
    relations?: { field: 'target' },   // needed for local expand / relation filters
    sync?: { filter?: string, batch?: number },
    conflictResolver?: ConflictResolver,
  }},
  reactivity?: ReactivityAdapter,      // e.g. angularReactivity
  persistence?: 'indexeddb' | 'localstorage' | 'memory' | PersistenceAdapter, // default: indexeddb in browsers
  namespace?: string,                  // storage key prefix, default 'pblf'
  conflictResolver?: ConflictResolver, // global fallback
  autoStart?: boolean,                 // default true
  reconcileIntervalMs?: number,        // default 300000, 0 disables
  healthCheckIntervalMs?: number,      // offline poll, default 10000
  onSyncError?: (info) => void,        // queued write permanently rejected
})
```

Client: `collection(name)`, `ready()`, `start()`, `sync()`, `status` (reactive), `onStatusChange(cb)`, `filter(expr, params)`, `destroy()`.

Cached collections additionally expose reactive synchronous reads: `list(options)`, `one(id, options)`, `first(filter, options)`, `count(filter)`, and both cached and non-cached expose `liveList(options)` / `liveOne(id, options)`.

## PocketBase compatibility

The local query engine implements PocketBase's documented behavior and is continuously verified against a real server (`npm run build && PB_BIN=path/to/pocketbase npm run test:parity`, PocketBase v0.23+ / tested with 0.39):

- All comparison operators `= != > >= < <= ~ !~` and the `?`-prefixed any-of variants, `&&`, `||`, parentheses, quoted strings with escapes.
- Field modifiers `:each`, `:length`, `:lower`; datetime macros `@now`, `@todayStart/End`, `@monthStart/End`, `@yearStart/End`, `@second/minute/hour/day/weekday/month/year`, `@yesterday`, `@tomorrow`.
- Relation traversal (`author.name = "x"`), back-relations (`comments_via_post.text ?~ "hi"`), JSON paths (`meta.info.pinned = true`).
- Multi-value fields (multi select/relation/file) match SQLite semantics: without `:each` the raw JSON text of the array is compared (`tags = '["a","b"]'`, `tags ~ "a"`); `:each` unwraps items with ALL semantics for plain operators and ANY for `?` operators. Relation traversal always unwraps (join semantics).
- Empty-value normalization for `=`/`!=` (null ≈ `""`), SQL `NULL` semantics for ordering operators, numeric column affinity (`views = "10"`), `~` LIKE semantics incl. `%`/`_` wildcards and auto-wrapping.
- `sort` incl. `-`/`+` prefixes and `@random`; `expand` incl. nested and back-relation expands (with `expand: {}` always present when requested, as in PocketBase ≥ 0.23); `fields` incl. wildcards and `:excerpt(n,bool)`.

### Requirements & known divergences

- **Cached collections should have an `updated` autodate field** (dashboard-created collections have one by default). Change detection between reconciles and last-update-wins rely on it.
- Filters referencing **unknown fields** return a 400 from the server but simply match nothing locally — the client has no runtime schema to validate against.
- Ties without an explicit `sort` (or within equal sort keys) use a deterministic `created, id` order locally; the server's tie order (`rowid`) is unspecified anyway. Add explicit sorts for pagination, as PocketBase itself recommends.
- A subscription may deliver **two events for one local write** (optimistic apply + server confirmation).
- `@request.*`, `@collection.*` and `geoDistance()` are API-rule constructs and throw a descriptive `QueryError` locally.
- `~` case-insensitivity uses Unicode folding locally vs. SQLite's ASCII-only folding.
- File uploads (`FormData`) can't be queued offline; when online they pass through to the server directly.
- Back-relation expands are always arrays locally (PocketBase collapses them to an object when a unique index exists).

## Persistence

- Browser default: IndexedDB (`indexedDBPersistence()`), fallback to localStorage, then in-memory.
- SSR/Node: in-memory (or bring your own).
- Custom: implement the 4-method `PersistenceAdapter` interface (`load`, `save`, `remove`, `clear`).

## Development

```sh
npm install
npm test              # unit tests (query engine, store, queue, sync, collection API)
npm run typecheck
npm run build
# end-to-end parity against a real PocketBase (spawns a disposable server):
PB_BIN=/path/to/pocketbase npm run test:parity
# end-to-end against a real 2-node pbreplication cluster (builds and spawns
# two replicating nodes; needs the Go toolchain or a prebuilt node binary):
PBR_SRC=/path/to/pbreplication npm run test:cluster
```

## License

MIT
