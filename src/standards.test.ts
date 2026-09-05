import { expect, it } from '@effect/vitest'
import { Effect, FileSystem, Path, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import { platform } from '#app/testing/fixtures'

const lintFixture = Effect.fn(function* (source: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'portless-lint-test-' })
  const file = path.join(directory, 'fixture.ts')
  yield* fs.writeFileString(file, source)
  const handle = yield* spawner.spawn(
    ChildProcess.make(
      process.execPath,
      ['node_modules/oxlint/bin/oxlint', '--config', '.oxlintrc.json', file],
      { env: {}, extendEnv: false }
    )
  )
  const [code, output] = yield* Effect.all(
    [handle.exitCode, Stream.mkString(Stream.decodeText(handle.all))],
    { concurrency: 'unbounded' }
  )
  return { code, output }
}, Effect.scoped)

it.live('lint accepts extensionless aliases and separate type imports', () =>
  Effect.gen(function* () {
    const result = yield* lintFixture(
      [
        "import type { Config } from '#app/model'",
        "import { fixture } from '#app/testing/fixtures'",
        'export const value = fixture',
        'export const use = (config: Config) => config'
      ].join('\n')
    )
    expect(result.code).toBe(0)
  }).pipe(Effect.provide(platform))
)

for (const specifier of [
  '#app/model.js',
  '#app/model.ts',
  '#app/testing/fixtures.js',
  '#app/testing/fixtures.ts',
  'effect/Effect.js',
  'effect/unstable/cli/Command.ts',
  './model',
  './testing/fixtures',
  '../model',
  '../testing/fixtures'
])
  it.live(`lint rejects nonconforming import ${specifier}`, () =>
    Effect.gen(function* () {
      const result = yield* lintFixture(`export { value } from '${specifier}'`)
      expect(result.code).not.toBe(0)
      expect(result.output).toContain('no-restricted-imports')
    }).pipe(Effect.provide(platform))
  )

it.live('lint rejects any, casts, default exports and value-only type imports', () =>
  Effect.gen(function* () {
    const result = yield* lintFixture(
      [
        "import { Config } from '#app/model'",
        'export const use = (config: Config) => config',
        'export const unsafe: any = 1',
        'export const cast = {} as Date',
        'export default 1'
      ].join('\n')
    )
    expect(result.code).not.toBe(0)
    for (const rule of [
      'no-explicit-any',
      'consistent-type-assertions',
      'no-default-export',
      'consistent-type-imports'
    ]) {
      expect(result.output).toContain(rule)
    }
  }).pipe(Effect.provide(platform))
)
