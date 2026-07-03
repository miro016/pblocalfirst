/**
 * End-to-end parity check against a REAL PocketBase server.
 *
 * Verifies that queries served from the local db return the same results as
 * the same queries against the remote API, that realtime changes flow into
 * the local db, and that offline writes are replayed after a server outage.
 *
 * Usage (requires `npm run build` first — this tests the built artifacts):
 *   PB_BIN=/path/to/pocketbase node --experimental-eventsource scripts/parity-check.mjs
 *
 * With PB_BIN set the script spawns its own disposable server (in a temp
 * dir) and also runs the offline/restart test. Alternatively point it at an
 * already running instance with PB_URL/PB_EMAIL/PB_PASSWORD (the offline
 * test is skipped then). Test collections are prefixed with `lfck_`.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import PocketBase from 'pocketbase'
import { createLocalFirst } from '../dist/index.js'

const PB_BIN = process.env.PB_BIN
const PB_URL = process.env.PB_URL ?? 'http://127.0.0.1:8098'
const PB_EMAIL = process.env.PB_EMAIL ?? 'admin@example.com'
const PB_PASSWORD = process.env.PB_PASSWORD ?? 'password123456'

let failures = 0
let passes = 0
function report(ok, label, detail = '') {
  if (ok) {
    passes++
    console.log(`  PASS ${label}`)
  } else {
    failures++
    console.error(`  FAIL ${label}${detail ? ` -> ${detail}` : ''}`)
  }
}

async function waitFor(fn, timeoutMs = 8000, everyMs = 100) {
  const start = Date.now()
  let lastErr
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await fn()
      if (result) return result
    } catch (err) {
      lastErr = err
    }
    await new Promise((resolve) => setTimeout(resolve, everyMs))
  }
  throw lastErr ?? new Error('waitFor timed out')
}

// ---------------------------------------------------------------------------
// optional: spawn a disposable server
// ---------------------------------------------------------------------------
let serverProc = null
const dataDir = PB_BIN ? mkdtempSync(join(tmpdir(), 'pblf-parity-')) : null

async function startServer() {
  if (!PB_BIN) return
  const host = new URL(PB_URL).host
  // keep auto-generated migrations inside the temp dir (default is ./pb_migrations in CWD)
  const proc = spawn(PB_BIN, ['serve', '--dir', dataDir, '--migrationsDir', join(dataDir, 'pb_migrations'), '--http', host], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  proc.stdout.on('data', (chunk) => (output += chunk))
  proc.stderr.on('data', (chunk) => (output += chunk))
  serverProc = proc
  try {
    await waitFor(async () => {
      const res = await fetch(`${PB_URL}/api/health`).catch(() => null)
      return res?.ok
    }, 15000)
  } catch (err) {
    console.error(`PocketBase failed to start:\n${output}`)
    throw err
  }
}

async function stopServer() {
  if (!serverProc) return
  const proc = serverProc
  serverProc = null
  proc.kill('SIGTERM')
  await new Promise((resolve) => proc.once('exit', resolve))
}

if (PB_BIN) {
  await startServer()
  await stopServer()
  // create the superuser while the server is down (CLI needs exclusive db access on some systems)
  await new Promise((resolve, reject) => {
    const proc = spawn(PB_BIN, ['superuser', 'upsert', PB_EMAIL, PB_PASSWORD, '--dir', dataDir], { stdio: 'ignore' })
    proc.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`superuser upsert exited ${code}`))))
  })
  await startServer()
}

// ---------------------------------------------------------------------------
// schema + seed data
// ---------------------------------------------------------------------------
const admin = new PocketBase(PB_URL) // plays "the server / another client"
admin.autoCancellation(false)
await admin.collection('_superusers').authWithPassword(PB_EMAIL, PB_PASSWORD)

for (const name of ['lfck_posts', 'lfck_authors']) {
  await admin.collections.delete(name).catch(() => {})
}
// API-created collections don't get created/updated automatically (v0.23+):
// add the autodate fields explicitly — the sync engine uses `updated`.
const autodates = [
  { name: 'created', type: 'autodate', onCreate: true },
  { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
]
const authorsCol = await admin.collections.create({
  name: 'lfck_authors',
  type: 'base',
  fields: [
    { name: 'name', type: 'text' },
    { name: 'age', type: 'number' },
    ...autodates,
  ],
  listRule: '',
  viewRule: '',
  createRule: '',
  updateRule: '',
  deleteRule: '',
})
await admin.collections.create({
  name: 'lfck_posts',
  type: 'base',
  fields: [
    { name: 'title', type: 'text' },
    { name: 'views', type: 'number' },
    { name: 'published', type: 'bool' },
    { name: 'author', type: 'relation', collectionId: authorsCol.id, maxSelect: 1 },
    { name: 'tags', type: 'select', maxSelect: 4, values: ['news', 'tech', 'life', 'misc'] },
    { name: 'meta', type: 'json' },
    ...autodates,
  ],
  listRule: '',
  viewRule: '',
  createRule: '',
  updateRule: '',
  deleteRule: '',
})

const alice = await admin.collection('lfck_authors').create({ name: 'Alice', age: 34 })
const bob = await admin.collection('lfck_authors').create({ name: 'Bob', age: 28 })
await admin.collection('lfck_posts').create({ title: 'Hello World', views: 150, published: true, author: alice.id, tags: ['news', 'tech'], meta: { rating: 5, info: { pinned: true } } })
await admin.collection('lfck_posts').create({ title: 'Draft post', views: 0, published: false, author: bob.id, tags: [], meta: null })
await admin.collection('lfck_posts').create({ title: '100% legit_stuff', views: 42, published: true, author: alice.id, tags: ['tech'], meta: { rating: 2 } })
await admin.collection('lfck_posts').create({ title: 'No Author Here', views: 7, published: true, author: '', tags: ['life', 'misc'], meta: { rating: 4 } })
await admin.collection('lfck_posts').create({ title: `It's got "quotes"`, views: 99, published: false, author: bob.id, tags: ['misc'], meta: { rating: 3 } })

// ---------------------------------------------------------------------------
// the local-first client under test (built dist artifacts)
// ---------------------------------------------------------------------------
const pb = new PocketBase(PB_URL)
pb.autoCancellation(false)
await pb.collection('_superusers').authWithPassword(PB_EMAIL, PB_PASSWORD)

const lf = createLocalFirst({
  pb,
  collections: {
    lfck_posts: { cache: true, relations: { author: 'lfck_authors' } },
    lfck_authors: { cache: true },
  },
  persistence: 'memory',
  reconcileIntervalMs: 0,
  healthCheckIntervalMs: 500,
})
await lf.collection('lfck_posts').getFullList() // waits for the initial sync

// ---------------------------------------------------------------------------
// 1) query parity: local results must equal remote results
// ---------------------------------------------------------------------------
console.log('\nquery parity (local db vs remote API):')

/** JSON with object keys sorted, so key order doesn't affect comparisons. */
const canonical = (value) =>
  JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v,
  )

const project = (r) => ({
  id: r.id,
  expand: r.expand
    ? Object.fromEntries(Object.entries(r.expand).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => x.id) : v.id]))
    : undefined,
})

const cases = [
  { filter: 'published = true', sort: 'title' },
  { filter: 'published = false', sort: '-views' },
  { filter: 'views > 42', sort: 'views' },
  { filter: 'views >= 42 && views <= 150', sort: '-views,title' },
  { filter: 'views = "150"', sort: 'title' }, // numeric coercion
  { filter: 'title ~ "post"', sort: 'title' }, // contains, case-insensitive
  { filter: 'title ~ "hello%"', sort: 'title' }, // explicit wildcard
  { filter: 'title !~ "o"', sort: 'title' },
  { filter: 'title ~ "100%"', sort: 'title' }, // literal % prefix
  { filter: `title = "It's got \\"quotes\\""`, sort: 'title' }, // escapes
  { filter: 'tags ?= "tech"', sort: 'title' }, // raw JSON text semantics (matches nothing)
  { filter: 'tags:each ?= "tech"', sort: 'title' },
  { filter: 'tags:each ?= "tech" || tags:each ?= "life"', sort: '-created,title' },
  { filter: 'tags:each = "tech"', sort: 'title' },
  { filter: 'tags:each != "news"', sort: 'title' },
  { filter: 'tags ~ "tech"', sort: 'title' }, // LIKE over the JSON text
  { filter: `tags = '["news","tech"]'`, sort: 'title' },
  { filter: 'tags = ""', sort: 'title' }, // empty multi-value is "[]", matches nothing
  { filter: 'tags = "[]"', sort: 'title' },
  { filter: 'tags:length > 1', sort: 'title' },
  { filter: 'tags:length = 0', sort: 'title' },
  { filter: 'title:lower = "hello world"', sort: 'title' },
  { filter: 'author = ""', sort: 'title' }, // empty relation
  { filter: `author = "${alice.id}"`, sort: 'title' },
  { filter: 'author.name = "Alice"', sort: '-views' },
  { filter: 'author.age > 30', sort: 'title' },
  { filter: 'author.name != "Alice"', sort: 'title' },
  { filter: 'meta.rating > 3', sort: 'title' },
  { filter: 'meta.info.pinned = true', sort: 'title' },
  { filter: 'created <= @now', sort: 'title' },
  { filter: 'created >= @todayStart && created <= @todayEnd', sort: 'title' },
  { filter: '(published = true && views > 10) || tags:each ?= "misc"', sort: 'views,title' },
  { filter: 'published != true', sort: 'title' },
  { sort: '-views' },
  { sort: 'author,title' },
  { sort: '-published,-views' },
  { filter: 'published = true', sort: '-views', expand: 'author' },
  { filter: 'views > 0', sort: 'title', expand: 'author', fields: 'id,title,expand.author.name' },
]

for (const options of cases) {
  const label = JSON.stringify(options)
  try {
    const [remote, local] = await Promise.all([
      admin.collection('lfck_posts').getFullList({ ...options }),
      lf.collection('lfck_posts').getFullList({ ...options }),
    ])
    const remoteIds = canonical(remote.map(project))
    const localIds = canonical(local.map(project))
    if (options.fields) {
      report(canonical(remote) === canonical(local), label, `remote=${canonical(remote)} local=${canonical(local)}`)
    } else {
      report(remoteIds === localIds, label, `remote=${remoteIds} local=${localIds}`)
    }
  } catch (err) {
    report(false, label, String(err))
  }
}

// back-relations on the authors collection
for (const options of [
  { filter: 'lfck_posts_via_author.views ?> 100', sort: 'name' },
  { expand: 'lfck_posts_via_author', sort: 'name' },
]) {
  const label = `authors ${JSON.stringify(options)}`
  try {
    const [remote, local] = await Promise.all([
      admin.collection('lfck_authors').getFullList({ ...options }),
      lf.collection('lfck_authors').getFullList({ ...options }),
    ])
    const r = JSON.stringify(remote.map(project))
    const l = JSON.stringify(local.map(project))
    report(r === l, label, `remote=${r} local=${l}`)
  } catch (err) {
    report(false, label, String(err))
  }
}

// getList pagination parity
{
  const opts = { filter: 'views >= 0', sort: '-views,title' }
  const [remote, local] = await Promise.all([
    admin.collection('lfck_posts').getList(2, 2, { ...opts }),
    lf.collection('lfck_posts').getList(2, 2, { ...opts }),
  ])
  report(
    remote.totalItems === local.totalItems &&
      remote.totalPages === local.totalPages &&
      JSON.stringify(remote.items.map((r) => r.id)) === JSON.stringify(local.items.map((r) => r.id)),
    'getList(2, 2) pagination',
    `remote=${JSON.stringify(remote.items.map((r) => r.id))}/${remote.totalItems} local=${JSON.stringify(local.items.map((r) => r.id))}/${local.totalItems}`,
  )
}

// getFirstListItem parity incl. 404 behavior
{
  const [remote, local] = await Promise.all([
    admin.collection('lfck_posts').getFirstListItem('published = true', { sort: '-views' }),
    lf.collection('lfck_posts').getFirstListItem('published = true', { sort: '-views' }),
  ])
  report(remote.id === local.id, 'getFirstListItem')
  const remoteErr = await admin.collection('lfck_posts').getFirstListItem('views > 99999').catch((e) => e.status)
  const localErr = await lf.collection('lfck_posts').getFirstListItem('views > 99999').catch((e) => e.status)
  report(remoteErr === 404 && localErr === 404, 'getFirstListItem 404 parity')
}

// ---------------------------------------------------------------------------
// 2) realtime: remote changes appear in the local db
// ---------------------------------------------------------------------------
console.log('\nrealtime sync:')
{
  const created = await admin.collection('lfck_posts').create({ title: 'Realtime One', views: 1, published: true })
  await waitFor(async () => (await lf.collection('lfck_posts').getOne(created.id).catch(() => null))?.title === 'Realtime One')
  report(true, 'remote create arrives locally')

  await admin.collection('lfck_posts').update(created.id, { views: 2 })
  await waitFor(async () => (await lf.collection('lfck_posts').getOne(created.id)).views === 2)
  report(true, 'remote update arrives locally')

  await admin.collection('lfck_posts').delete(created.id)
  await waitFor(async () => (await lf.collection('lfck_posts').getOne(created.id).catch((e) => e.status)) === 404)
  report(true, 'remote delete arrives locally')
}

// local writes reach the server
{
  const created = await lf.collection('lfck_posts').create({ title: 'Local Write', views: 5, published: true })
  const onServer = await admin.collection('lfck_posts').getOne(created.id)
  report(onServer.title === 'Local Write', 'local create reaches the server')
  await lf.collection('lfck_posts').delete(created.id)
  const gone = await admin.collection('lfck_posts').getOne(created.id).catch((e) => e.status)
  report(gone === 404, 'local delete reaches the server')
}

// ---------------------------------------------------------------------------
// 3) offline: queued writes replay after the server comes back
// ---------------------------------------------------------------------------
if (PB_BIN) {
  console.log('\noffline replay (server restart):')
  await stopServer()

  const offlineCreated = await lf.collection('lfck_posts').create({ title: 'Written Offline', views: 3, published: true })
  report(!!offlineCreated.id, 'offline create resolves optimistically')
  await waitFor(() => lf.status.pending === 1 && !lf.status.online)
  report(true, 'client detects the outage and queues the write')

  const stillReadable = await lf.collection('lfck_posts').getFullList({ filter: 'title = "Written Offline"' })
  report(stillReadable.length === 1, 'offline reads keep working')

  await startServer()
  await waitFor(() => lf.status.online && lf.status.pending === 0, 15000)
  const replayed = await admin.collection('lfck_posts').getOne(offlineCreated.id).catch(() => null)
  report(replayed?.title === 'Written Offline', 'queued write replayed to the server with the same id')
  await admin.collection('lfck_posts').delete(offlineCreated.id).catch(() => {})
} else {
  console.log('\noffline replay: skipped (set PB_BIN to run it)')
}

// ---------------------------------------------------------------------------
console.log(`\n${passes} passed, ${failures} failed`)
lf.destroy()
for (const name of ['lfck_posts', 'lfck_authors']) {
  await admin.collections.delete(name).catch(() => {})
}
await stopServer()
process.exit(failures > 0 ? 1 : 0)
