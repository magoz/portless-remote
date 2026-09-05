import { Clock, Effect, Ref, Schedule, Semaphore } from 'effect'
import { BoundaryError, sortedUnique } from '#app/model'
import type { Config, Intent } from '#app/model'
import { Files, Processes } from '#app/io'
import { observe } from '#app/observer'
import type { Snapshot } from '#app/observer'
import { certificateGroups, desiredDns, diffDns, DnsInventory } from '#app/dns'
import type { DnsChange } from '#app/dns'
import { IntentStore } from '#app/state'

export interface Report {
  readonly mode: 'dry-run'
  readonly ready: false
  readonly observation: {
    readonly status: 'healthy' | 'unavailable'
    readonly hosts: readonly string[]
    readonly notices: Snapshot['notices']
  }
  readonly retainedHosts: readonly string[]
  readonly blockers: readonly string[]
  readonly dns: {
    readonly source: 'unconfigured' | 'file-snapshot' | 'unavailable'
    readonly changes: readonly DnsChange[]
  }
  readonly certificates: {
    readonly action: 'ensure-via-caddy-dns01'
    readonly subjects: readonly string[]
  }[]
  readonly gateway: ReturnType<typeof gatewayIntent>
}

interface ReconciliationState {
  readonly intent: Intent
  readonly lastGood: Snapshot
  readonly pendingRemoval: { readonly key: string; readonly since: number } | undefined
}

// Deliberately NOT a Caddy API payload. A provider-specific, validated adapter is
// a later milestone. Explicit literals avoid trusting client-supplied forwarding headers.
export const gatewayIntent = (config: Config, hosts: readonly string[], hold: boolean) => ({
  kind: 'non-executable-caddy-intent' as const,
  action: hold ? ('hold' as const) : ('replace-exact-allowlist-proposal' as const),
  externalOrigin: 'https:443',
  bind: 'private-interface-only; address/provisioning not configured',
  admin: 'protected-unix-socket; not configured',
  unknownHosts: 'reject; no on-demand TLS; no upstream fallback',
  discardIncomingHeaders: ['Forwarded', 'X-Forwarded-*'],
  routes: hosts.map(hostname => ({
    hostname,
    upstream: 'https://127.0.0.1:443',
    tls: {
      serverName: hostname,
      caFile: config.portlessCaFile,
      insecureSkipVerify: false
    },
    headers: {
      Host: hostname,
      'X-Forwarded-Host': hostname,
      'X-Forwarded-Proto': 'https',
      'X-Forwarded-Port': '443'
    }
  }))
})

export const makeReconciler = (
  config: Config,
  options: { settleMs?: number; removalConfirmationMs?: number } = {}
) =>
  Effect.gen(function* () {
    const store = yield* IntentStore
    const dns = yield* DnsInventory
    const files = yield* Files
    const processes = yield* Processes
    const initialIntent = yield* store.load
    const memory = yield* Ref.make<ReconciliationState>({
      intent: initialIntent,
      // On restart, conservatively hold retained names until removals have two
      // healthy confirmations. Retention is not proof of an active gateway.
      lastGood: { hosts: initialIntent.retainedHosts, notices: [] },
      pendingRemoval: undefined
    })
    const semaphore = yield* Semaphore.make(1)
    const observation = observe(config, options.settleMs).pipe(
      Effect.provideService(Files, files),
      Effect.provideService(Processes, processes)
    )
    const run = semaphore.withPermits(1)(
      Effect.gen(function* () {
        let { intent, lastGood, pendingRemoval } = yield* Ref.get(memory)
        const blockers: string[] = [
          'dry-run-only',
          'caddy-dns01-not-configured',
          'gateway-and-origin-not-verified'
        ]
        const observed = yield* Effect.result(observation)
        let hold = false
        let healthy = false
        if (observed._tag === 'Failure') {
          blockers.push(observed.failure.code)
          pendingRemoval = undefined
          hold = true
        } else {
          const snapshot = observed.success
          healthy = true
          const nextHosts = sortedUnique([...intent.retainedHosts, ...snapshot.hosts])
          if (nextHosts.length > config.maxHosts) {
            blockers.push('retention-limit-manual-review-required')
            hold = true
          } else {
            const next: Intent = { ...intent, retainedHosts: nextHosts }
            const changed = JSON.stringify(intent.retainedHosts) !== JSON.stringify(nextHosts)
            const saved = changed
              ? yield* Effect.result(
                  store
                    .save(next)
                    .pipe(
                      Effect.andThen(Ref.update(memory, m => ({ ...m, intent: next }))),
                      Effect.uninterruptible
                    )
                )
              : undefined
            if (saved?._tag === 'Failure') {
              blockers.push(
                saved.failure.code === 'intent-size-limit'
                  ? 'intent-size-limit'
                  : 'intent-save-failed'
              )
              hold = true
            } else {
              intent = next
              const removing = lastGood.hosts.some(h => !snapshot.hosts.includes(h))
              if (removing) {
                const key = JSON.stringify(snapshot.hosts)
                const now = yield* Clock.currentTimeMillis
                if (pendingRemoval?.key !== key) pendingRemoval = { key, since: now }
                if (
                  now - pendingRemoval.since <
                  (options.removalConfirmationMs ?? config.pollIntervalMs)
                ) {
                  blockers.push('route-removal-awaiting-confirmation')
                  hold = true
                }
              } else pendingRemoval = undefined
              if (!hold) {
                lastGood = snapshot
                pendingRemoval = undefined
              }
            }
          }
          if (snapshot.notices.length > 0) blockers.push('registry-notices-require-review')
        }
        yield* Ref.set(memory, { intent, lastGood, pendingRemoval })
        const inventory = yield* Effect.result(
          dns.read.pipe(
            Effect.timeoutOrElse({
              duration: '2 seconds',
              orElse: () => Effect.fail(new BoundaryError({ code: 'dns-read-timeout' }))
            }),
            Effect.retry({
              times: 2,
              schedule: Schedule.exponential('100 millis')
            })
          )
        )
        let source: Report['dns']['source']
        let changes: DnsChange[] = []
        if (inventory._tag === 'Failure') {
          source = 'unavailable'
          blockers.push('dns-inventory-unavailable')
          hold = true
        } else {
          source = inventory.success === undefined ? 'unconfigured' : 'file-snapshot'
          changes = diffDns(config, desiredDns(config, intent.retainedHosts), inventory.success)
          if (source === 'unconfigured') blockers.push('dns-inventory-not-configured')
          if (changes.some(c => c.action === 'blocked')) {
            blockers.push('dns-conflicts')
            hold = true
          }
        }
        return {
          mode: 'dry-run',
          ready: false,
          observation: {
            status: healthy ? 'healthy' : 'unavailable',
            hosts: observed._tag === 'Success' ? observed.success.hosts : [],
            notices: observed._tag === 'Success' ? observed.success.notices : []
          },
          retainedHosts: intent.retainedHosts,
          blockers: sortedUnique(blockers),
          dns: { source, changes },
          certificates: certificateGroups(intent.retainedHosts, config.namespace).map(g => ({
            action: 'ensure-via-caddy-dns01',
            subjects: g.subjects
          })),
          gateway: gatewayIntent(config, lastGood.hosts, hold)
        } satisfies Report
      })
    )
    return { run }
  })
