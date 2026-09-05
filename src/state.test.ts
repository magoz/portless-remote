import { expect, it } from '@effect/vitest'
import { Deferred, Effect, Fiber, Layer } from 'effect'
import { emptyIntent } from '#app/model'
import { Files, MAX_FILE_BYTES } from '#app/io'
import { IntentStore, intentStoreLayer } from '#app/state'
import { fixture, platform } from '#app/testing/fixtures'

it.live(
  'atomically persists private intent, reloads after restart, releases locks and never touches registry',
  () =>
    Effect.gen(function* () {
      const { fs, path, config, registry } = yield* fixture
      yield* fs.writeFileString(registry, '[]')
      const next = {
        ...emptyIntent(config),
        retainedHosts: ['app.dev.example.com']
      }
      yield* Effect.gen(function* () {
        const store = yield* IntentStore
        expect(yield* store.load).toEqual(emptyIntent(config))
        yield* store.save(next)
        expect(yield* store.load).toEqual(next)
        const result = yield* Effect.result(
          Effect.void.pipe(Effect.provide(intentStoreLayer(config)))
        )
        expect(result._tag).toBe('Failure')
      }).pipe(Effect.provide(intentStoreLayer(config)))
      expect(yield* fs.readDirectory(config.dataDir)).toEqual(['intent.json'])
      expect((yield* fs.stat(path.join(config.dataDir, 'intent.json'))).mode & 0o777).toBe(0o600)
      expect((yield* fs.stat(config.dataDir)).mode & 0o777).toBe(0o700)
      const loaded = yield* Effect.gen(function* () {
        return yield* (yield* IntentStore).load
      }).pipe(Effect.provide(intentStoreLayer(config)))
      expect(loaded).toEqual(next)
      expect(yield* fs.readFileString(registry)).toBe('[]')
      expect(yield* fs.readDirectory(config.portlessStateDir)).toEqual(['routes.json'])
    }).pipe(Effect.provide(platform))
)

it.live('fails closed on corrupt state and mismatched identity without overwriting evidence', () =>
  Effect.gen(function* () {
    const { fs, path, config } = yield* fixture
    yield* fs.makeDirectory(config.dataDir, { mode: 0o700 })
    const file = path.join(config.dataDir, 'intent.json')
    for (const text of [
      '{secret-canary',
      JSON.stringify({ ...emptyIntent(config), ownerId: 'other-owner' }),
      JSON.stringify({
        ...emptyIntent(config),
        retainedHosts: ['evil.example.net']
      }),
      JSON.stringify({ ...emptyIntent(config), version: 2 })
    ]) {
      yield* fs.writeFileString(file, text)
      const result = yield* Effect.result(
        Effect.gen(function* () {
          return yield* (yield* IntentStore).load
        }).pipe(Effect.provide(intentStoreLayer(config)))
      )
      expect(result._tag).toBe('Failure')
      expect(JSON.stringify(result)).not.toContain('secret-canary')
      expect(yield* fs.readFileString(file)).toBe(text)
      expect(yield* fs.exists(path.join(config.dataDir, 'observer.lock'))).toBe(false)
    }
  }).pipe(Effect.provide(platform))
)

it.live('refuses overlapping symlink paths before creating anything in Portless state', () =>
  Effect.gen(function* () {
    const { fs, path, root, config } = yield* fixture
    const alias = path.join(root, 'alias')
    yield* fs.symlink(config.portlessStateDir, alias)
    const result = yield* Effect.result(
      Effect.void.pipe(
        Effect.provide(
          intentStoreLayer({
            ...config,
            dataDir: path.join(alias, 'remote')
          })
        )
      )
    )
    expect(result._tag).toBe('Failure')
    expect(yield* fs.readDirectory(config.portlessStateDir)).toEqual([])
  }).pipe(Effect.provide(platform))
)

for (const nested of [false, true])
  it.live(
    `rejects dangling input directory symlinks before any state creation (nested=${nested})`,
    () =>
      Effect.gen(function* () {
        const { fs, path, config } = yield* fixture
        yield* fs.remove(config.portlessStateDir, { recursive: true })
        yield* fs.symlink(config.dataDir, config.portlessStateDir)
        const scopedConfig = nested
          ? {
              ...config,
              portlessStateDir: path.join(config.portlessStateDir, 'child'),
              dataDir: path.join(config.dataDir, 'child')
            }
          : config
        const result = yield* Effect.result(
          Effect.void.pipe(Effect.provide(intentStoreLayer(scopedConfig)))
        )
        expect(result._tag).toBe('Failure')
        expect(yield* fs.exists(config.dataDir)).toBe(false)
        expect(yield* fs.readLink(config.portlessStateDir)).toBe(config.dataDir)
      }).pipe(Effect.provide(platform))
  )

it.live('rejects symlinked intent and shared-writable data directories', () =>
  Effect.gen(function* () {
    const { fs, path, root, config } = yield* fixture
    yield* fs.makeDirectory(config.dataDir, { mode: 0o700 })
    const target = path.join(root, 'elsewhere.json')
    yield* fs.writeFileString(target, JSON.stringify(emptyIntent(config)))
    yield* fs.symlink(target, path.join(config.dataDir, 'intent.json'))
    const load = Effect.gen(function* () {
      return yield* (yield* IntentStore).load
    })
    expect((yield* Effect.result(load.pipe(Effect.provide(intentStoreLayer(config)))))._tag).toBe(
      'Failure'
    )
    yield* fs.chmod(config.dataDir, 0o755)
    expect((yield* Effect.result(load.pipe(Effect.provide(intentStoreLayer(config)))))._tag).toBe(
      'Failure'
    )
  }).pipe(Effect.provide(platform))
)

it.live('rejects dangling intent symlinks without resetting or replacing them', () =>
  Effect.gen(function* () {
    const { fs, path, root, config } = yield* fixture
    yield* fs.makeDirectory(config.dataDir, { mode: 0o700 })
    const missingTarget = path.join(root, 'missing-intent.json')
    const statePath = path.join(config.dataDir, 'intent.json')
    yield* fs.symlink(missingTarget, statePath)
    const result = yield* Effect.result(
      Effect.gen(function* () {
        const store = yield* IntentStore
        yield* store.load
        yield* store.save({
          ...emptyIntent(config),
          retainedHosts: ['app.dev.example.com']
        })
      }).pipe(Effect.provide(intentStoreLayer(config)))
    )
    expect(result._tag === 'Failure' && result.failure.code).toBe('file-symlink-rejected')
    expect(yield* fs.readLink(statePath)).toBe(missingTarget)
    expect(yield* fs.exists(missingTarget)).toBe(false)
    expect(yield* fs.exists(path.join(config.dataDir, 'observer.lock'))).toBe(false)
  }).pipe(Effect.provide(platform))
)

it.live('bounds file reads and treats missing files separately', () =>
  Effect.gen(function* () {
    const { fs, registry } = yield* fixture
    const files = yield* Files
    const missing = yield* Effect.result(files.read(registry))
    expect(missing._tag === 'Failure' && missing.failure.code).toBe('file-missing')
    yield* fs.writeFileString(registry, 'x'.repeat(MAX_FILE_BYTES + 1))
    expect((yield* Effect.result(files.read(registry)))._tag).toBe('Failure')
    yield* fs.writeFile(registry, new Uint8Array([0xff]))
    expect((yield* Effect.result(files.read(registry)))._tag).toBe('Failure')
  }).pipe(Effect.provide(platform))
)

it.live(
  'rejects oversized serialized intent before replacement and reloads the previous state',
  () =>
    Effect.gen(function* () {
      const { config: base } = yield* fixture
      const config = { ...base, maxHosts: 10_000 }
      yield* Effect.gen(function* () {
        const store = yield* IntentStore
        const previous = {
          ...emptyIntent(config),
          retainedHosts: ['app.dev.example.com']
        }
        yield* store.save(previous)
        const retainedHosts = Array.from(
          { length: 10_000 },
          (_, i) =>
            `${String(i).padStart(5, '0')}${'a'.repeat(50)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(50)}.${config.namespace}`
        )
        const result = yield* Effect.result(store.save({ ...previous, retainedHosts }))
        expect(result._tag === 'Failure' && result.failure.code).toBe('intent-size-limit')
        expect(yield* store.load).toEqual(previous)
      }).pipe(Effect.provide(intentStoreLayer(config)))
    }).pipe(Effect.provide(platform))
)

it.live(
  'does not steal a lock left by a hard crash; recovers only after deliberate offline removal',
  () =>
    Effect.gen(function* () {
      const { config, fs, path } = yield* fixture
      yield* fs.makeDirectory(config.dataDir, { mode: 0o700 })
      const lock = path.join(config.dataDir, 'observer.lock')
      yield* fs.makeDirectory(lock, { mode: 0o700 })
      expect(
        (yield* Effect.result(Effect.void.pipe(Effect.provide(intentStoreLayer(config)))))._tag
      ).toBe('Failure')
      expect(yield* fs.exists(lock)).toBe(true)
      yield* fs.remove(lock, { recursive: true })
      yield* Effect.void.pipe(Effect.provide(intentStoreLayer(config)))
      expect(yield* fs.exists(lock)).toBe(false)
    }).pipe(Effect.provide(platform))
)

it.live('releases the cross-process lock when the owning scope is interrupted', () =>
  Effect.gen(function* () {
    const { fs, path, config } = yield* fixture
    const ready = yield* Deferred.make<void>()
    const fiber = yield* Effect.forkScoped(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(intentStoreLayer(config))
          yield* Deferred.succeed(ready, undefined)
          yield* Effect.never
        })
      )
    )
    yield* Deferred.await(ready)
    expect(yield* fs.exists(path.join(config.dataDir, 'observer.lock'))).toBe(true)
    yield* Fiber.interrupt(fiber)
    expect(yield* fs.exists(path.join(config.dataDir, 'observer.lock'))).toBe(false)
  }).pipe(Effect.provide(platform))
)
