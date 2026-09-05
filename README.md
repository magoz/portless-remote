# Portless Remote

An Effect-based companion for private, publicly trusted HTTPS access to running [Portless](https://github.com/vercel-labs/portless) apps, without remote-specific launch wrappers or per-project onboarding.

**Current milestone: a working read-only observer and dry-run planner, not a remote HTTPS deployment.** It reads the actual Portless registry, tracks new projects/worktrees, and prints exact desired DNS records and certificate subjects. It never changes DNS, Caddy, Tailscale, app processes, or Portless state. There is no `apply` command.

## Run from source

Requires **Node.js 24+** on a POSIX host. Uses **Effect v4 `4.0.0-rc.112`**, with matching first-party platform and test packages. V4 is a release candidate; dependencies and the lockfile are pinned. Portless registry compatibility is tested against **0.15.6** (development dependency only).

```sh
npm ci
npm run check
cp examples/config.json config.local.json
# Edit config.local.json for the actual development user and namespace.
npm run dev -- dry-run --config config.local.json
npm run dev -- status --config config.local.json
npm run dev -- watch --config config.local.json
```

Or build with `npm run build`, then run `node dist/cli.js ...`.

- `dry-run` and `status` produce the same fresh JSON report.
- `watch` emits changed reports as JSON lines. Filesystem notifications plus periodic scans discover new routes and recover after directory recreation. Ctrl+C/SIGTERM closes watchers and releases the lock.
- `ready` is **always false** at this milestone. Exit 0 means a report was produced, **not** that HTTPS works. Startup configuration/cache-load failures exit nonzero. Reconciliation save failures and registry/DNS observation failures appear in report blockers so watch can recover; inspect those blockers even when exit status is 0.
- These commands write **only companion intent/lock files** in `dataDir`. They are read-only with respect to Portless and external infrastructure.

### Configuration

[`examples/config.json`](examples/config.json) contains placeholders, not machine configuration. All configured filesystem paths must be absolute; `~` and environment substitutions are not expanded.

| Field                      | Meaning                                                                                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `namespace`                | Dedicated development suffix, e.g. `dev.example.com`. Only valid lowercase strict descendants are accepted. No `.localhost` translation.                                            |
| `ownerId`                  | Stable unique identity for future managed DNS RRsets. Do not change it to claim another instance's records.                                                                         |
| `portlessStateDir`         | Actual dev user's Portless state directory. Required; no assumption about the observer's HOME or environment.                                                                       |
| `dataDir`                  | Separate private companion directory, created mode 0700. Must not overlap Portless state or configured CA/inventory inputs, including through symlinks.                             |
| `gatewayAddress`           | Intended private gateway IP: RFC1918, CGNAT or IPv6 ULA. Not a hostname, public, loopback, or link-local address. One address family per instance for now.                          |
| `portlessCaFile`           | Portless CA **public certificate** path for the eventual verified HTTPS upstream. No private key. Currently an intent only; not read or trusted by this tool.                       |
| `pidMode`                  | `same-namespace` asserts the observer sees the dev processes in the same PID namespace; preferably run as the same OS user. `unverified` excludes PID-owned routes without probing. |
| `includePersistentAliases` | Default false. With true, PID-0 aliases are included but flagged as liveness-unverified. Remove stale aliases through Portless, not this companion.                                 |
| `pollIntervalMs`           | Default 5000; range 250–60000. Also the minimum route-removal confirmation interval.                                                                                                |
| `maxHosts`                 | Default 1000; range 1–10000. Bounds each registry snapshot and total retained names. Reaching the retention limit requires manual review.                                           |
| `dnsInventoryFile`         | Optional absolute path to a normalized DNS snapshot, outside `dataDir`. No network provider is contacted.                                                                           |

Unknown configuration keys are rejected. **Do not put credentials here.** Optional Portless transport metadata is discarded; it is not printed or copied to state. Reports contain configured hostnames, private target addresses and the CA path, so treat reports as local operational data, not public logs.

### Reading a plan

For `app.dev.example.com` and `feat.app.dev.example.com`, the planner proposes:

- Explicit `A`/`AAAA` records for both names, plus `*.app.dev.example.com`.
- Caddy DNS-01 subjects `app.dev.example.com` and `*.app.dev.example.com`, reused across sibling worktrees.
- An exact hostname allowlist forwarding to **`https://127.0.0.1:443`**, never the transient app port. The intent specifies preserved HTTP `Host`, sanitized forwarded origin headers, and TLS verification against the Portless CA with the route hostname as SNI.

`deep.feat.app.dev.example.com` needs additional `feat.app.dev.example.com` / `*.feat.app.dev.example.com` coverage. The registry cannot tell dotted app names from branch labels, so grouping uses the immediate parent below the namespace. No flattened worktree slugs or `*.dev.example.com` TLS assumption.

Without an inventory, DNS actions say `ensure-unverified`: absence of credentials is **not** proof that records are absent. To inspect a diff, provide a complete normalized snapshot using the shape in [`examples/dns-inventory.json`](examples/dns-inventory.json). Each entry is an RRset (name/type/values), with `ownerId` only when ownership is independently established. File-based ownership is a **fixture assertion**, not verified provider ownership. An incomplete snapshot can produce incorrect `create` proposals; none are executed.

Diff actions distinguish create, owned update, unchanged, unmanaged-but-already-satisfied and blocked conflicts. CNAME/address-family conflicts and delegated child zones block affected records. **No deletion actions exist**, even for owned records. Existing record values and provider errors are not echoed. Gateway output is explicitly **non-executable Caddy intent**, not a valid Caddyfile or admin API payload.

## Required eventual deployment shape

The companion does not make these changes. Before a separately approved deployment:

1. Only the **remote development machine** uses the development suffix as Portless's **first** `PORTLESS_TLD`, with HTTPS and proxy port **443**, so CLI-injected `PORTLESS_URL` matches the browser origin. Local colleagues keep defaults and ordinary `pnpm dev`. Merely translating `.localhost` at an external proxy is insufficient. The observer does not verify or rewrite launch configuration.
2. A separately provisioned private gateway (Tailscale is one option) accepts HTTPS443 only on its private interface and forwards through Portless's loopback HTTPS443 listener. Shared-host listener coexistence, routing, firewall and ACLs must be verified; don't bind wildcard/LAN listeners as a shortcut.
3. Caddy obtains publicly trusted certificates via DNS-01 using a selected DNS provider module and tightly scoped credentials. Caddy owns certificate storage and renewal. First-project issuance/propagation takes time; this milestone has no issuance progress sensor.
4. Caddy's admin plane uses a restrictive Unix socket unavailable to apps and clients. Unknown hosts must not trigger on-demand certificates or an upstream fallback. Preserve HTTP `Host` explicitly, especially with Caddy 2.11's HTTPS-upstream Host rewrite. Strip untrusted `Forwarded`/`X-Forwarded-*`, then set host/proto/port to the approved HTTPS443 origin.
5. Validate real DNS propagation, TLS chain/SNI, spoofed headers, unknown hosts, auth callbacks and browser/HMR behavior before declaring readiness. No device, Expo Metro/deep-link, or native Fast Refresh compatibility is claimed.

Some apps may need a backward-compatible development-origin adjustment based on injected `PORTLESS_URL`; zero app-repository edits cannot be guaranteed. No companion dependency or remote wrapper belongs in each app. Domain siblings are generally same-site; hostname routing is **not a tenant security boundary**. Public DNS and certificate transparency may disclose development names even when ingress is private.

See [architecture, recovery and remaining gates](docs/architecture.md). No license has been selected and package publication is disabled pending the owner's decision.
