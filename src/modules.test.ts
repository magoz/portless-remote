import { expect, it } from '@effect/vitest'
import { Effect, FileSystem } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import { platform } from '#app/testing/fixtures'

it.live(
  'native Node resolves extensionless aliases to source only under development conditions',
  () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      for (const development of [false, true]) {
        const resolved = yield* spawner.string(
          ChildProcess.make(
            process.execPath,
            [
              ...(development ? ['--conditions=development'] : []),
              '--input-type=module',
              '--eval',
              'console.log(import.meta.resolve("#app/model"))'
            ],
            { env: {}, extendEnv: false }
          )
        )
        expect(resolved.trim().endsWith(development ? '/src/model.ts' : '/dist/model.js')).toBe(
          true
        )
      }
    }).pipe(Effect.provide(platform))
)

it.live('compiled output excludes colocated tests and test fixtures', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const files = yield* fs.readDirectory('dist', { recursive: true })
    expect(files).toContain('cli.js')
    expect(
      files.some(
        name => name.includes('.test.') || name === 'testing' || name.startsWith('testing/')
      )
    ).toBe(false)
  }).pipe(Effect.provide(platform))
)
