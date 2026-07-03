import type PocketBase from 'pocketbase'

/**
 * Tracks reachability of the PocketBase server. Combines browser
 * online/offline events, observed request failures/successes and a health
 * poll while offline.
 */
export class OnlineMonitor {
  private _online = true
  private listeners = new Set<(online: boolean) => void>()
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private started = false
  private polling = false

  constructor(
    private pb: PocketBase,
    private pollIntervalMs = 10_000,
  ) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) this._online = false
  }

  get online(): boolean {
    return this._online
  }

  start(): void {
    if (this.started) return
    this.started = true
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('online', this.handleBrowserOnline)
      window.addEventListener('offline', this.handleBrowserOffline)
    }
    if (!this._online) this.startPolling()
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    if (typeof window !== 'undefined' && window.removeEventListener) {
      window.removeEventListener('online', this.handleBrowserOnline)
      window.removeEventListener('offline', this.handleBrowserOffline)
    }
    this.stopPolling()
  }

  /** Call when a request failed for network reasons. */
  reportFailure(): void {
    this.setOnline(false)
  }

  /** Call when a request to the server succeeded. */
  reportSuccess(): void {
    this.setOnline(true)
  }

  onChange(listener: (online: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private handleBrowserOnline = (): void => {
    // browser says the NIC is up; verify the server is actually reachable
    void this.checkHealth()
  }

  private handleBrowserOffline = (): void => {
    this.setOnline(false)
  }

  private setOnline(online: boolean): void {
    if (this._online === online) {
      if (!online) this.startPolling()
      return
    }
    this._online = online
    if (online) this.stopPolling()
    else this.startPolling()
    for (const listener of [...this.listeners]) listener(online)
  }

  private startPolling(): void {
    if (this.pollTimer || !this.started) return
    this.pollTimer = setInterval(() => void this.checkHealth(), this.pollIntervalMs)
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
  }

  private async checkHealth(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      await this.pb.health.check({ requestKey: null })
      this.setOnline(true)
    } catch {
      this.setOnline(false)
    } finally {
      this.polling = false
    }
  }
}
