# TypeScript and Effect standards

## Imports and module layout

Use extensionless `#app/...` imports for project modules and extensionless package imports. Import from the owning module, not a convenience barrel. Prefer flat, focused, kebab-case modules and named exports; tool configuration files may use required default exports.

```ts
import { Effect } from 'effect'
import { observe } from '#app/observer'
import type { Config } from '#app/model'
```

`package.json#imports` is the single alias definition:

- TypeScript resolves the `types` condition to `src/*.ts`.
- Native Node development and Vitest use the `development` condition to load `src/*.ts`.
- Ordinary Node execution uses `default` to load the emitted `dist/*.js` files.

Run source with `npm run dev -- ...`, which sets `--conditions=development`. Run compiled code with `node dist/cli.js ...`. Node strips erasable TypeScript in development; no bundler, custom alias loader, or `tsx` dependency is needed. Keep `NodeNext` resolution and `erasableSyntaxOnly` enabled. Merely removing extensions from relative ESM imports or adding TypeScript-only `paths` would break ordinary Node execution.

The `.js` suffix belongs in the runtime package mapping, not source imports. Do not add a second alias definition to TypeScript or Vitest. Tests and shared test fixtures are excluded from the build.

## Formatting and linting

Oxfmt owns formatting: no semicolons, no trailing commas, single quotes, two-space indentation, 100-column print width, and no unnecessary arrow-function parentheses. `.oxfmtrc.json` is authoritative.

Oxlint owns code checks, including correctness, named exports, explicit type imports, unused bindings, extensionless project aliases, and type safety. `.oxlintrc.json` is authoritative. Warnings fail the check; do not add a warning allowance to make CI pass.

```sh
npm run lint
npm run lint:fix
npm run format:check
npm run format:fix
npm run check
```

Do not introduce blanket lint disables or weaken TypeScript settings. A narrowly justified suppression must explain the boundary and why a type-safe implementation is not practical; it is not an alternative to fixing a real defect.

## Type safety and Effect boundaries

- No explicit `any` or `as Type`/angle-bracket casts. Use generics, annotations, `satisfies`, or Schema guards. `as const` is allowed for literal narrowing.
- Prefer readonly object fields and collection parameters. Keep mutable construction/state local to the operation that owns it.
- Decode unknown input with Effect Schema at the boundary. Use non-throwing Effect decoders/encoders; `Schema.is` is appropriate for pure guards. Never bypass validation.
- Use the pinned Effect v4 APIs, not snippets from another beta: `Context.Service`, `Layer.effect`, and `Schema.TaggedError` are the APIs used here.
- Expose domain operations as Effects; compose/provide live layers at the CLI boundary. Use `Effect.fn` for effectful operations, typed safe errors, and scoped resource acquisition/release.
- Catch expected failures with `catchTag`, `catch`, or `mapError`; do not convert defects into ordinary recoverable errors with cause-catching handlers.
- Keep pure planning functions pure. Use native Effect filesystem, clock, concurrency and process-runtime services rather than handwritten Promise/timer loops. Small synchronous platform boundaries remain explicit and testable.
- Keep error data safe: no raw input, provider response, credentials or application environment in logs or persistence. The read-only and namespace constraints in `AGENTS.md` still apply.

## Tests

Colocate behavior tests as `src/*.test.ts`; shared isolated-fixture support lives in `src/testing/`. Do not create a separate top-level test tree or emit test code into `dist/`.

Use `@effect/vitest` for Effect programs. Prefer `it.effect` and service layers over `Effect.runPromise` wrappers or global monkeypatches. Fork sleeping effects before advancing `TestClock`. Use `it.live` only for deliberate real filesystem or owned-process behavior.

Choose the outermost practical seam: CLI for command contracts, service operations for recovery/cancellation, pure functions for dense planning invariants. Tests should survive behavior-preserving refactors. Use temporary directories and owned child processes; never mutate another repository, live registry, network, DNS provider, or certificate service in tests.

`npm test` compiles first, then runs the colocated suites. Compiled-CLI integration tests must continue exercising ordinary Node resolution separately from development/source resolution.
