import { expect, it } from '@effect/vitest'
import { Effect, Fiber, Layer, Ref } from 'effect'
import { TestClock } from 'effect/testing'
import { RouteStore } from 'portless'
import { BoundaryError } from '#app/model'
import { Files, Processes, probePid } from '#app/io'
import { observe } from '#app/observer'
import { configEffect, fixture, platform, route } from '#app/testing/fixtures'

it.live(
  'reads real files and live PIDs, compatible with Portless 0.15.6, without modifying its state',
  () =>
    Effect.gen(function* () {
      const { fs, config, registry } = yield* fixture
      const value = [
        route(),
        {
          ...route('feat.app.dev.example.com'),
          ngrokUrl: 'secret-canary',
          ngrokPid: 123
        }
      ]
      yield* fs.writeFileString(registry, JSON.stringify(value))
      const before = yield* fs.stat(registry)
      const result = yield* observe(config, 1)
      const compatible = yield* Effect.sync(() =>
        new RouteStore(config.portlessStateDir).loadRoutesRaw()
      )
      expect(result.hosts).toEqual(compatible.map(r => r.hostname).sort())
      expect(JSON.stringify(result)).not.toContain('secret-canary')
      expect(yield* fs.readFileString(registry)).toBe(JSON.stringify(value))
      expect((yield* fs.stat(registry)).mtime).toEqual(before.mtime)
      expect(yield* fs.readDirectory(config.portlessStateDir)).toEqual(['routes.json'])
    }).pipe(Effect.provide(platform))
)

it.effect('EPERM means alive; ESRCH means dead; unexpected probe failures remain unknown', () =>
  Effect.gen(function* () {
    for (const [code, expected] of [
      ['EPERM', 'permission-denied'],
      ['ESRCH', 'dead'],
      ['EIO', 'unknown']
    ]) {
      expect(
        yield* probePid(42, () => {
          throw { code }
        })
      ).toBe(expected)
    }
    expect(
      yield* probePid(42, (_pid, signal) => {
        expect(signal).toBe(0)
      })
    ).toBe('alive')
  })
)

it.effect('filters dead PIDs and defaults to excluding unverified aliases', () =>
  Effect.gen(function* () {
    const config = yield* configEffect
    const text = JSON.stringify([
      route('live.dev.example.com', 1),
      route('dead.dev.example.com', 2),
      route('permission.dev.example.com', 3),
      route('alias.dev.example.com', 0),
      route('bad.localhost', 1)
    ])
    const result = yield* observe(config, 0).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(Files, { read: () => Effect.succeed(text) }),
          Layer.succeed(Processes, {
            probe: pid =>
              Effect.succeed(pid === 2 ? 'dead' : pid === 3 ? 'permission-denied' : 'alive')
          })
        )
      )
    )
    expect(result.hosts).toEqual(['live.dev.example.com', 'permission.dev.example.com'])
    expect(result.notices.map(n => n.code)).toContain('alias-excluded')
  })
)

it.effect('does not probe foreign PID namespaces; aliases require explicit opt-in', () =>
  Effect.gen(function* () {
    const config = yield* configEffect
    const result = yield* observe(
      { ...config, pidMode: 'unverified', includePersistentAliases: true },
      0
    ).pipe(
      Effect.provideService(Files, {
        read: () => Effect.succeed(JSON.stringify([route(), route('alias.dev.example.com', 0)]))
      }),
      Effect.provideService(Processes, {
        probe: () => Effect.die('must not probe')
      })
    )
    expect(result.hosts).toEqual(['alias.dev.example.com'])
    expect(result.notices.map(n => n.code)).toEqual([
      'pid-namespace-unverified-excluded',
      'alias-liveness-unverified'
    ])
  })
)

it.effect('retries partial/unstable writes and only accepts a matching pair', () =>
  Effect.gen(function* () {
    const config = yield* configEffect
    const reads = yield* Ref.make(0)
    const complete = JSON.stringify([route()])
    const run = observe(config).pipe(
      Effect.provideService(Files, {
        read: () =>
          Ref.getAndUpdate(reads, n => n + 1).pipe(Effect.map(n => (n === 0 ? '[{' : complete)))
      }),
      Effect.provideService(Processes, {
        probe: () => Effect.succeed('alive')
      })
    )
    const fiber = yield* Effect.forkScoped(run)
    yield* TestClock.adjust('1 second')
    expect((yield* Fiber.join(fiber)).hosts).toEqual(['app.dev.example.com'])
    expect(yield* Ref.get(reads)).toBe(4)
  })
)

for (const text of [
  '[{secret-canary',
  '{}',
  JSON.stringify([{ ...route(), port: 0 }]),
  JSON.stringify([route(), route()]),
  JSON.stringify([{ ...route(), pid: -1 }])
]) {
  it.effect(`rejects malformed snapshots (${text.slice(0, 30)})`, () =>
    Effect.gen(function* () {
      const config = yield* configEffect
      const run = observe(config, 0).pipe(
        Effect.provideService(Files, { read: () => Effect.succeed(text) }),
        Effect.provideService(Processes, {
          probe: () => Effect.succeed('alive')
        }),
        Effect.result
      )
      const fiber = yield* Effect.forkScoped(run)
      yield* TestClock.adjust('1 second')
      const result = yield* Fiber.join(fiber)
      expect(result._tag).toBe('Failure')
      expect(JSON.stringify(result)).not.toContain('secret-canary')
    })
  )
}

it.effect('missing/unreadable registry is not an empty snapshot', () =>
  Effect.gen(function* () {
    const config = yield* configEffect
    for (const code of ['file-missing', 'file-unreadable']) {
      const fiber = yield* Effect.forkScoped(
        observe(config, 0).pipe(
          Effect.provideService(Files, {
            read: () => Effect.fail(new BoundaryError({ code }))
          }),
          Effect.provideService(Processes, {
            probe: () => Effect.succeed('alive')
          }),
          Effect.result
        )
      )
      yield* TestClock.adjust('1 second')
      expect((yield* Fiber.join(fiber))._tag).toBe('Failure')
    }
  })
)
