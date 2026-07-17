import type PocketBase from 'pocketbase'
import { expect, vi } from 'vitest'
import { createLocalFirst, type LocalFirstClient } from '../../src'
import type { CollectionSync, SyncManager } from '../../src/sync/engine'
import type { FakePb } from './fakePb'

/**
 * Shared harness for the sync test suites: builds a client wired to a FakePb
 * with fast, deterministic defaults (memory persistence, no reconcile timer,
 * effectively-disabled health poll) and tracks instances so `cleanupClients`
 * can destroy them after each test.
 */

const clients: LocalFirstClient<any>[] = []

export function makeClient(fake: FakePb, extra: Record<string, unknown> = {}): LocalFirstClient<any> {
  const lf = createLocalFirst({
    pb: fake as unknown as PocketBase,
    collections: {
      posts: { cache: true, relations: { author: 'users' } },
      users: { cache: true },
      logs: {},
    },
    persistence: 'memory',
    reconcileIntervalMs: 0,
    healthCheckIntervalMs: 3_600_000,
    ...extra,
  })
  clients.push(lf)
  return lf
}

export function cleanupClients(): void {
  while (clients.length) clients.pop()!.destroy()
}

export function manager(lf: LocalFirstClient<any>): SyncManager {
  return (lf as unknown as { manager: SyncManager }).manager
}

export function engine(lf: LocalFirstClient<any>, name: string): CollectionSync {
  const found = manager(lf).engines.get(name)
  if (!found) throw new Error(`no sync engine for collection "${name}"`)
  return found
}

/** Wait until the local db holds exactly `count` records of a collection. */
export async function synced(lf: LocalFirstClient<any>, collection: string, count: number): Promise<void> {
  await vi.waitFor(async () => {
    const items = await lf.collection(collection).getFullList()
    expect(items).toHaveLength(count)
  })
}

/** Wait until nothing is pending or syncing. */
export async function settled(lf: LocalFirstClient<any>): Promise<void> {
  await vi.waitFor(() => {
    expect(lf.status.pending).toBe(0)
    expect(lf.status.syncing).toBe(false)
  })
}

/**
 * Take the client fully offline: cut the fake server AND let the client's
 * OnlineMonitor observe a failure so `monitor.online` is false before the
 * test continues. (Without the failed sync the monitor still believes it is
 * online and the next write attempts a network round trip.)
 */
export async function goOffline(fake: FakePb, lf: LocalFirstClient<any>): Promise<void> {
  fake.online = false
  await lf.sync()
  await vi.waitFor(() => expect(lf.status.online).toBe(false))
}

/** Count requests with a given prefix, optionally only past an offset into the log. */
export function countRequests(fake: FakePb, prefix: string, since = 0): number {
  return fake.requestLog.slice(since).filter((entry) => entry.startsWith(prefix)).length
}
