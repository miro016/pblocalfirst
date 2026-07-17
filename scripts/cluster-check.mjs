/**
 * End-to-end check against a REAL 2-node pbreplication cluster.
 *
 * Verifies the behaviors the local-first client must absorb when its
 * PocketBase node is part of a replicating cluster: eventual cross-node
 * consistency, realtime events fired for replicated applies, last-write-wins
 * convergence of concurrent writes on different nodes, deletes propagating
 * across nodes, and offline-queued writes replaying into the cluster.
 *
 * Usage (requires `npm run build` first — this tests the built artifacts):
 *   PBR_BIN=/path/to/node-binary node --experimental-eventsource scripts/cluster-check.mjs
 *   PBR_SRC=/path/to/pbreplication node --experimental-eventsource scripts/cluster-check.mjs
 *
 * With PBR_SRC set (default: ../pbreplication next to this repo) the script
 * builds the example binary with the Go toolchain. If neither a binary nor a
 * buildable source tree is available the script prints SKIP and exits 0.
 * Test collections are prefixed with `lfck_`.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import PocketBase from 'pocketbase'
import { createLocalFirst } from '../dist/index.js'

const PBR_SRC = process.env.PBR_SRC ?? resolve(import.meta.dirname, '../../pbreplication')
const CLUSTER_SECRET = 'lfck-cluster-secret-0123456789'
const URL_A = 'http://127.0.0.1:8391'
const URL_B = 'http://127.0.0.1:8392'
const EMAIL = 'admin@example.com'
const PASSWORD = 'password123456'

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

async function waitFor(fn, timeoutMs = 20000, everyMs = 200) {
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
// obtain the cluster node binary
// ---------------------------------------------------------------------------
let binary = process.env.PBR_BIN
if (!binary) {
  const haveGo = spawnSync('go', ['version'], { stdio: 'ignore' }).status === 0
  if (!haveGo || !existsSync(join(PBR_SRC, 'example', 'main.go'))) {
    console.log('SKIP: no PBR_BIN and no buildable pbreplication source (set PBR_BIN or PBR_SRC)')
    process.exit(0)
  }
  binary = join(mkdtempSync(join(tmpdir(), 'pblf-cluster-bin-')), 'pbr-node')
  console.log(`building cluster node binary from ${PBR_SRC}/example ...`)
  const build = spawnSync('go', ['build', '-o', binary, '.'], { cwd: join(PBR_SRC, 'example'), stdio: 'inherit' })
  if (build.status !== 0) {
    console.error('FAIL: could not build the pbreplication example binary')
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// spawn the two nodes
// ---------------------------------------------------------------------------
const dirs = { A: mkdtempSync(join(tmpdir(), 'pblf-cluster-a-')), B: mkdtempSync(join(tmpdir(), 'pblf-cluster-b-')) }
const procs = { A: null, B: null }
const logs = { A: '', B: '' }

function nodeEnv(name) {
  return {
    ...process.env,
    PBR_NODE_URL: name === 'A' ? URL_A : URL_B,
    PBR_SEED_URL: name === 'A' ? '' : URL_A,
    PBR_CLUSTER_SECRET: CLUSTER_SECRET,
  }
}

async function startNode(name) {
  const url = name === 'A' ? URL_A : URL_B
  const dir = dirs[name]
  // no --migrationsDir: the example app doesn't register the automigrate plugin
  const proc = spawn(binary, ['serve', '--dir', dir, '--http', new URL(url).host], {
    env: nodeEnv(name),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stdout.on('data', (chunk) => (logs[name] += chunk))
  proc.stderr.on('data', (chunk) => (logs[name] += chunk))
  procs[name] = proc
  try {
    await waitFor(async () => {
      const res = await fetch(`${url}/api/health`).catch(() => null)
      return res?.ok
    }, 30000)
  } catch (err) {
    console.error(`node ${name} failed to start:\n${logs[name]}`)
    throw err
  }
}

async function stopNode(name) {
  const proc = procs[name]
  if (!proc) return
  procs[name] = null
  proc.kill('SIGTERM')
  await new Promise((resolve) => proc.once('exit', resolve))
}

async function cleanup() {
  await stopNode('B')
  await stopNode('A')
  for (const dir of Object.values(dirs)) rmSync(dir, { recursive: true, force: true })
}

process.on('SIGINT', () => cleanup().then(() => process.exit(130)))

// superusers stay node-local unless the full-copy bootstrap clones them; create one per node up front.
// Run the upserts WITHOUT a seed URL: with PBR_SEED_URL set the plugin blocks
// waiting for the (not yet started) seed node even for CLI commands.
for (const name of ['A', 'B']) {
  const upsert = spawnSync(binary, ['superuser', 'upsert', EMAIL, PASSWORD, '--dir', dirs[name]], {
    env: { ...nodeEnv(name), PBR_SEED_URL: '' },
    stdio: 'ignore',
    timeout: 60000,
  })
  if (upsert.status !== 0) {
    console.error(`FAIL: superuser upsert on node ${name} exited ${upsert.status}`)
    process.exit(1)
  }
}

console.log('starting node A (cluster seed) ...')
await startNode('A')

// ---------------------------------------------------------------------------
// schema on node A
// ---------------------------------------------------------------------------
const adminA = new PocketBase(URL_A)
adminA.autoCancellation(false)
await adminA.collection('_superusers').authWithPassword(EMAIL, PASSWORD)

await adminA.collections.delete('lfck_notes').catch(() => {})
await adminA.collections.create({
  name: 'lfck_notes',
  type: 'base',
  fields: [
    { name: 'title', type: 'text' },
    { name: 'body', type: 'text' },
    { name: 'created', type: 'autodate', onCreate: true },
    { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
  ],
  listRule: '',
  viewRule: '',
  createRule: '',
  updateRule: '',
  deleteRule: '',
})
const seeded = await adminA.collection('lfck_notes').create({ title: 'seeded on A', body: 'hello' })

console.log('starting node B (joins A) ...')
await startNode('B')

const adminB = new PocketBase(URL_B)
adminB.autoCancellation(false)
await adminB.collection('_superusers').authWithPassword(EMAIL, PASSWORD)

// ---------------------------------------------------------------------------
// 1) cluster bootstrap: B receives schema + data from A
// ---------------------------------------------------------------------------
console.log('\ncluster bootstrap:')
try {
  await waitFor(async () => (await adminB.collection('lfck_notes').getOne(seeded.id).catch(() => null))?.title === 'seeded on A', 60000)
  report(true, 'node B bootstrapped the collection and its records from A')
} catch (err) {
  report(false, 'node B bootstrapped the collection and its records from A', String(err))
  console.error(`node B log tail:\n${logs.B.slice(-2000)}`)
  await cleanup()
  process.exit(1)
}

// ---------------------------------------------------------------------------
// the local-first client under test, connected to node B only
// ---------------------------------------------------------------------------
const pbB = new PocketBase(URL_B)
pbB.autoCancellation(false)
await pbB.collection('_superusers').authWithPassword(EMAIL, PASSWORD)

const lf = createLocalFirst({
  pb: pbB,
  collections: { lfck_notes: { cache: true } },
  persistence: 'memory',
  reconcileIntervalMs: 0,
  healthCheckIntervalMs: 500,
})
await lf.collection('lfck_notes').getFullList() // waits for the initial sync

// ---------------------------------------------------------------------------
// 2) replicated writes reach the client through its node's realtime
// ---------------------------------------------------------------------------
console.log('\ncross-node propagation into the client:')
{
  const onA = await adminA.collection('lfck_notes').create({ title: 'written on A', body: 'via replication' })
  try {
    await waitFor(async () => (await lf.collection('lfck_notes').getOne(onA.id).catch(() => null))?.title === 'written on A', 30000)
    report(true, 'a write on node A arrives in the client connected to node B')
  } catch (err) {
    report(false, 'a write on node A arrives in the client connected to node B', String(err))
  }

  await adminA.collection('lfck_notes').update(onA.id, { body: 'edited on A' })
  try {
    await waitFor(async () => (await lf.collection('lfck_notes').getOne(onA.id)).body === 'edited on A', 30000)
    report(true, 'an update on node A arrives in the client')
  } catch (err) {
    report(false, 'an update on node A arrives in the client', String(err))
  }

  await adminA.collection('lfck_notes').delete(onA.id)
  try {
    await waitFor(async () => (await lf.collection('lfck_notes').getOne(onA.id).catch((e) => e.status)) === 404, 30000)
    report(true, 'a delete on node A removes the record from the client')
  } catch (err) {
    report(false, 'a delete on node A removes the record from the client', String(err))
  }
}

// ---------------------------------------------------------------------------
// 3) client writes replicate to the other node
// ---------------------------------------------------------------------------
console.log('\nclient writes replicate across the cluster:')
{
  const created = await lf.collection('lfck_notes').create({ title: 'written by client on B', body: 'x' })
  try {
    await waitFor(async () => (await adminA.collection('lfck_notes').getOne(created.id).catch(() => null))?.title === 'written by client on B', 30000)
    report(true, 'a client create on node B replicates to node A')
  } catch (err) {
    report(false, 'a client create on node B replicates to node A', String(err))
  }

  await lf.collection('lfck_notes').delete(created.id)
  try {
    await waitFor(async () => (await adminA.collection('lfck_notes').getOne(created.id).catch((e) => e.status)) === 404, 30000)
    report(true, 'a client delete on node B replicates to node A')
  } catch (err) {
    report(false, 'a client delete on node B replicates to node A', String(err))
  }
}

// ---------------------------------------------------------------------------
// 4) concurrent writes on both nodes converge (last-write-wins)
// ---------------------------------------------------------------------------
console.log('\nLWW convergence of concurrent cross-node writes:')
{
  const record = await lf.collection('lfck_notes').create({ title: 'conflict target', body: 'v0' })
  await waitFor(async () => (await adminA.collection('lfck_notes').getOne(record.id).catch(() => null)) !== null, 30000)

  // near-simultaneous conflicting updates on both nodes
  await Promise.all([
    adminA.collection('lfck_notes').update(record.id, { body: 'edited on A' }),
    lf.collection('lfck_notes').update(record.id, { body: 'edited on B' }),
  ])

  try {
    await waitFor(async () => {
      const a = await adminA.collection('lfck_notes').getOne(record.id)
      const b = await adminB.collection('lfck_notes').getOne(record.id)
      return a.body === b.body && (a.body === 'edited on A' || a.body === 'edited on B')
    }, 30000)
    const a = await adminA.collection('lfck_notes').getOne(record.id)
    report(true, `both nodes converged on one winner ("${a.body}")`)

    // the client's local db converges onto the same winner
    await waitFor(async () => (await lf.collection('lfck_notes').getOne(record.id)).body === a.body, 30000)
    report(true, 'the client converged onto the cluster-wide winner')
  } catch (err) {
    report(false, 'nodes + client converge after concurrent conflicting writes', String(err))
  }
}

// ---------------------------------------------------------------------------
// 5) offline replay into the cluster (node B restarts)
// ---------------------------------------------------------------------------
console.log('\noffline replay through a node restart:')
{
  await stopNode('B')

  const offlineCreated = await lf.collection('lfck_notes').create({ title: 'written while B was down', body: 'queued' })
  report(!!offlineCreated.id, 'offline create resolves optimistically')
  await waitFor(() => lf.status.pending === 1 && !lf.status.online, 15000)
  report(true, 'client detects the outage and queues the write')

  await startNode('B')
  try {
    await waitFor(() => lf.status.online && lf.status.pending === 0, 30000)
    report(true, 'queued write replayed to node B after the restart')
    await waitFor(async () => (await adminA.collection('lfck_notes').getOne(offlineCreated.id).catch(() => null))?.title === 'written while B was down', 30000)
    report(true, 'the replayed write replicated onward to node A')
  } catch (err) {
    report(false, 'offline write replayed and replicated after node restart', String(err))
  }
}

// ---------------------------------------------------------------------------
console.log(`\n${passes} passed, ${failures} failed`)
lf.destroy()
await adminA.collections.delete('lfck_notes').catch(() => {})
await cleanup()
process.exit(failures > 0 ? 1 : 0)
