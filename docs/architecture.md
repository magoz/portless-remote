# Architecture and verification boundaries

## Runtime

The current program has no networking or apply adapter. Its only side effects are bounded reads, PID signal-0 probes, filesystem watches, stdout/stderr and writes inside the private companion data directory.

```text
Portless-owned routes.json
  → stable read + Effect Schema validation
  → namespace + PID visibility policy
  → serialized reconciliation
      ├─ private retained-name intent (atomic local persistence)
      ├─ optional normalized DNS inventory file → ownership-aware diff
      └─ exact certificate subjects + non-executable gateway intent
  → dry-run JSON / not-ready status
```

First-party Effect v4 modules provide `Context.Service`, `Layer`, `Schema`, `Effect.fn`, `Ref`, `Semaphore`, `Schedule`, `Queue`, `Stream`, `FileSystem`, `Path`, CLI and Node runtime. `@effect/vitest` provides effect/scoped tests and `TestClock`. Small synchronous Node built-ins handle pure IP/path checks and the signal-0 PID boundary; there are no custom Promise loops, timers, watcher callbacks, or third-party runtime frameworks.

- `src/model.ts`: credential-free configuration, strict hostnames and persisted intent schema.
- `src/io.ts`: bounded, scoped native filesystem reads and PID visibility service.
- `src/observer.ts`: stable registry snapshots; does not import Portless at runtime.
- `src/dns.ts`: read-only inventory service and pure certificate/DNS planning.
- `src/state.ts`: exclusive companion lock, atomic state persistence and validation.
- `src/reconciler.ts`: one semaphore-serialized Effect, with retained state in a Ref.
- `src/watch.ts`: scoped watcher renewal, bounded notification queue, periodic fallback and report deduplication.
- `src/cli.ts`: Effect-native CLI and signal-aware Node runtime.

## Registry compatibility and failure policy

Pinned/tested surface: Portless 0.15.6 `routes.json` array containing `hostname`, `port`, `pid`. Optional transport metadata is ignored, not forwarded. Portless's exported `RouteStore` is real and useful, but both raw and PID-filtered reads collapse errors to `[]`. The companion reads the documented file shape directly to preserve error/empty distinctions. It never invokes `ensureDir`, mutating route methods, locks, `loadRoutes(true)`, pruning or forced registration. A compatibility test compares actual file observation with the pinned package's read-only API.

Reads require equal bytes twice, 75ms apart, with at most two retries using 50ms exponential backoff. Invalid JSON, invalid row shapes, duplicate accepted hostnames and read failures invalidate the snapshot. Invalid/out-of-namespace hostname rows are excluded with index/reason notices; their raw values are not echoed. Files are bounded to 2MiB and required to be regular, valid UTF-8 files.

A structurally valid stable snapshot is **not a transactional guarantee** against every possible concurrent Portless write. Safety comes from additive DNS/certificate intent and confirmed gateway removals, not only from retrying reads.

PID checks require an explicit same-PID-namespace assertion. EPERM means the process exists but is inaccessible; it is retained and reported. ESRCH means dead. Other probe failures and unverified foreign namespaces are excluded. PID reuse cannot be detected from this registry, and process existence does not prove the app or proxy is healthy. PID-0 aliases need explicit inclusion and always remain liveness-unverified. No target-port health checks occur at this milestone.

## Retention and recovery

DNS/certificate intent grows monotonically, so project restarts, dead routes, an empty registry, or transient read failures do not request deletion/reissuance. Repeated worktree observations do not rewrite unchanged state. A cached name is **not** an issued certificate or applied DNS record; every report remains unverified unless a provided fixture establishes only the hypothetical DNS diff.

Gateway removals need two matching healthy snapshots separated by at least `pollIntervalMs`. Errors reset that confirmation. On restart, retained names are used conservatively until removal confirmation; this does not assert that an actual gateway has those routes. `gateway.action: hold` means no proposed replacement should be used. The gateway structure is descriptive, never executable.

`dataDir/intent.json` has version, namespace, owner ID and retained names only. A same-filesystem temporary file is written mode 0600, flushed, atomically renamed, then the directory is flushed. The short save/Ref commit is uninterruptible; network waits and the watch loop remain cancellable. Serialized size is checked before replacing existing state, so the companion cannot write an intent larger than it can subsequently read. `maxHosts` and the 2MiB bound both apply.

`dataDir/observer.lock` is an exclusive directory for the process lifetime. No stale-lock stealing or PID-based auto-recovery is attempted. On an ordinary exit/SIGINT/SIGTERM, scoped cleanup removes it. After a hard crash:

1. Confirm no other companion instance is running against this data directory.
2. Back up the directory privately. Do not use a public issue as a log dump.
3. Remove **only the empty `observer.lock` directory**, then restart.

Corrupt, oversized, mismatched-owner/namespace or unsupported-version intent fails closed without overwriting it. Restore a known-good backup. If deliberate cache reset or retention pruning is necessary, do it offline after reviewing the recorded names; there is no automatic external resource deletion. Changing owner/namespace requires a separately reviewed state directory/migration, not silently adopting the previous identity. Changing the target address can produce hypothetical owned updates or unmanaged conflicts.

Symlink ancestors are canonicalized before checking directory separation. Data directories must be owned by the current user and not group/world-accessible; existing permissions are never relaxed or changed. Intent symlinks are rejected. This is not a sandbox against a malicious process with the same OS identity changing files between checks. Protect the observer/state from untrusted code; external write credentials must eventually live on a separately protected control plane, not in app environments.

## DNS and certificate planning

The planner retains exact route names and creates main/wildcard DNS intents for certificate groups. Explicit route records avoid dependence on broad DNS wildcard expansion when descendants or ACME-created empty nonterminals exist. TLS wildcards match only one label; every deeper group gets suitable coverage. A maximum-length base that cannot have a valid wildcard uses exact coverage only.

An inventory file is a complete normalized snapshot **asserted by the operator**, not a live or authenticated provider observation. Its DNS owner-name grammar accepts ACME/SRV underscores; the HTTP route grammar does not. Duplicate RRsets and mismatched namespace envelopes are rejected. The DNS service deliberately has no mutation method. Failure/timeout yields no DNS changes and a hold; reads have two bounded backoff retries and a two-second per-attempt timeout. Unconfigured inventory is unknown, never implicitly empty.

Matching unmanaged records are not adopted. Conflicting unmanaged values are blocked, not updated or removed. Other address-family records/CNAMEs, descendant NS delegation and names below an ancestor DNAME are blocked conservatively. This does not analyze DNSSEC, all alias/provider features, CAA issuance restrictions, propagation, TTL/proxy settings or ACME challenge delegation. A production adapter must validate those relevant provider capabilities before applying anything. `ownerId` in a fixture is not proof of ownership. Public DNS wildcard records do not grant wildcard HTTP routing.

Certificate actions are stable **ensure intents**, not direct issuance requests and not claims of issuance. An eventual Caddy adapter must inspect/reuse existing managed policy/storage; replaying reports must not force issuance. Caddy must own DNS-01 challenge records, ACME account data, private keys, renewal and backoff. No homemade ACME implementation.

## Remaining live gates

Implementation/permission decisions still needed before external changes:

- DNS provider, dedicated zone/delegation, account scope, authenticated ownership markers and conflict policy. Prefer provider credentials restricted to the development namespace, with a read-only adapter first.
- Caddy build/provider module, durable storage, ACME account and protected Unix-socket admin access. Use ownership-scoped config changes with optimistic concurrency; preserve unrelated Caddy configuration. Never expose the default admin port to apps.
- Private gateway identity/address, service supervision, interface binding and ACL/firewall approval. Confirm coexistence with Portless HTTPS443. No node retagging, Serve changes, Funnel or public tunnels by default.
- Remote-only Portless first TLD / HTTPS443 verification and upstream CA/SNI verification. Pin and test Caddy behavior, including explicit HTTP Host preservation, forwarded-header sanitization and unknown-host rejection.
- Staging ACME testing only with explicit permission, then deliberate public issuance approval. Verify DNS propagation and certificate readiness before offering URLs as ready.
- Real browser auth/callback, streaming/WebSocket/HMR and device tests. JS/unit tests are not native-device validation.

No public release, license choice, push, credentials, public issuance or infrastructure deployment is part of this milestone.

## Primary sources

- [Portless 0.15.6 route implementation](https://github.com/vercel-labs/portless/blob/v0.15.6/packages/portless/src/routes.ts)
- [Portless exported API](https://github.com/vercel-labs/portless/blob/v0.15.6/packages/portless/src/index.ts)
- [Portless configuration](https://github.com/vercel-labs/portless/blob/v0.15.6/apps/docs/src/app/configuration/page.mdx)
- [Effect v4 source and examples](https://github.com/Effect-TS/effect-smol) — exact installed `effect@4.0.0-rc.112` source/examples were checked during implementation.
- [Caddy admin API and concurrency](https://caddyserver.com/docs/api)
- [Caddy reverse proxy TLS and headers](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
- [ACME DNS-01](https://letsencrypt.org/docs/challenge-types/#dns-01-challenge)
