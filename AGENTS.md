# Portless Remote

## Scope and safety

This repository currently implements a read-only Portless observer and dry-run planner, not a live HTTPS deployment. See `README.md` and `docs/architecture.md` for behavior, boundaries and remaining gates. Follow `docs/standards.md` for TypeScript, Effect, import and testing conventions.

- Use **Effect v4** and matching first-party packages; current pins are `4.0.0-rc.112`. Use native Effect services, schemas, layers, scoped resources, CLI, filesystem and test APIs. Do not add v3 packages or handwritten Promise/timer orchestration.
- Portless owns app startup, registration, routes and cleanup. Production code must not mutate Portless state or call mutating RouteStore methods. Compatibility tests pin Portless 0.15.6.
- Preserve registered nested names. Validate all names against the configured development namespace. Retain DNS/certificate intents across route removal; unknown snapshots are not empty inventories.
- Never introduce external writes, public ACME issuance, network changes or publication without explicit authorization. Caddy owns ACME, keys and renewal. Current DNS service has no mutation capability; gateway output is non-executable intent.
- Keep credentials and unrelated transport metadata out of reports, persistence and app environments. Use only synthetic domains/IPs/paths in committed examples and fixtures. No private infrastructure transcripts or other repositories' source.
- Do not choose a license on the owner's behalf. Package is private to prevent accidental npm publication.

## Development

`npm ci`, then `npm run check` (Oxlint, typecheck, build, colocated Effect Vitest tests, Oxfmt). Use `npm run lint:fix` and `npm run format:fix` for fixes; use the npm lockfile. Project imports use extensionless native `#app/...` aliases, with separate `import type` declarations. No explicit `any` or type casts; `as const` is allowed. Tests live beside source, with shared fixtures in `src/testing/`, and never enter the compiled output. Test filesystem/process behavior only with scoped temporary fixtures and owned child processes; never use a live app registry as a write fixture.

Use `Context.Service` + `Layer` for boundaries, `Schema` for external data and typed errors, `Effect.fn` for effectful operations, and first-party `@effect/vitest`/`TestClock` for behavior and cancellation tests. Keep pure planning functions separate from I/O. Errors should carry safe codes, not raw credential-bearing responses or input.
