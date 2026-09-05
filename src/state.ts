import { Context, Effect, FileSystem, Layer, Option, Path } from 'effect'
import type { PlatformError } from 'effect/PlatformError'
import {
  BoundaryError,
  decodeJson,
  emptyIntent,
  IntentSchema,
  isWithin,
  validateIntent
} from '#app/model'
import type { Config, Intent } from '#app/model'
import { Files, MAX_FILE_BYTES } from '#app/io'

export class IntentStore extends Context.Service<
  IntentStore,
  {
    readonly load: Effect.Effect<Intent, BoundaryError>
    readonly save: (intent: Intent) => Effect.Effect<void, BoundaryError>
  }
>()('portless-remote/IntentStore') {}

export const intentStoreLayer = (config: Config) =>
  Layer.effect(
    IntentStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const files = yield* Files
      // Resolve existing symlink ancestors, including when Portless has not started.
      const canonicalPath = (name: string): Effect.Effect<string, PlatformError | BoundaryError> =>
        fs.realPath(name).pipe(
          Effect.catchIf(
            error => error.reason._tag === 'NotFound' && path.dirname(name) !== name,
            () =>
              Effect.gen(function* () {
                // realPath cannot distinguish absence from a dangling symlink.
                // Reject links at every missing ancestor before creating dataDir;
                // otherwise creating its target could turn a safe-looking lexical
                // path into an alias of the Portless input directory.
                const link = yield* Effect.result(fs.readLink(name))
                if (link._tag === 'Success') {
                  return yield* Effect.fail(
                    new BoundaryError({
                      code: 'data-directory-dangling-symlink'
                    })
                  )
                }
                if (link.failure.reason._tag !== 'NotFound') return yield* Effect.fail(link.failure)
                const parent = yield* canonicalPath(path.dirname(name))
                return path.join(parent, path.basename(name))
              })
          )
        )
      const data = yield* Effect.gen(function* () {
        const portless = yield* canonicalPath(path.resolve(config.portlessStateDir))
        const data = yield* canonicalPath(path.resolve(config.dataDir))
        const caFile = yield* canonicalPath(path.resolve(config.portlessCaFile))
        const inventoryFile =
          config.dnsInventoryFile === undefined
            ? undefined
            : yield* canonicalPath(path.resolve(config.dnsInventoryFile))
        if (
          isWithin(portless, data) ||
          isWithin(data, portless) ||
          isWithin(data, caFile) ||
          (inventoryFile !== undefined && isWithin(data, inventoryFile))
        ) {
          return yield* Effect.fail(new BoundaryError({ code: 'data-directory-overlaps-input' }))
        }
        yield* fs.makeDirectory(data, { recursive: true, mode: 0o700 })
        const stat = yield* fs.stat(data)
        if (
          (stat.mode & 0o077) !== 0 ||
          (process.getuid && Option.getOrUndefined(stat.uid) !== process.getuid())
        ) {
          return yield* Effect.fail(new BoundaryError({ code: 'data-directory-not-private' }))
        }
        return data
      }).pipe(
        Effect.catchTag('PlatformError', () =>
          Effect.fail(new BoundaryError({ code: 'data-directory-unavailable' }))
        )
      )

      const lockPath = path.join(data, 'observer.lock')
      yield* Effect.acquireRelease(
        fs
          .makeDirectory(lockPath, { mode: 0o700 })
          .pipe(Effect.mapError(() => new BoundaryError({ code: 'intent-lock-unavailable' }))),
        () =>
          fs.remove(lockPath, { recursive: true }).pipe(
            Effect.mapError(() => new BoundaryError({ code: 'intent-lock-release-failed' })),
            Effect.orDie
          )
      )
      const statePath = path.join(data, 'intent.json')
      const load = files.read(statePath, true).pipe(
        Effect.flatMap(text => decodeJson(IntentSchema, text, 'intent-invalid')),
        Effect.catchIf(
          error => error.code === 'file-missing',
          () => Effect.succeed(emptyIntent(config))
        ),
        Effect.filterOrFail(
          intent => validateIntent(config, intent),
          () => new BoundaryError({ code: 'intent-mismatch-or-unsafe' })
        )
      )
      const save = Effect.fn('IntentStore.save')(
        function* (intent: Intent) {
          if (!validateIntent(config, intent))
            return yield* Effect.fail(new BoundaryError({ code: 'intent-mismatch-or-unsafe' }))
          const encoded = new TextEncoder().encode(`${JSON.stringify(intent, null, 2)}\n`)
          if (encoded.length > MAX_FILE_BYTES)
            return yield* Effect.fail(new BoundaryError({ code: 'intent-size-limit' }))
          // A same-filesystem temporary file, flushed before atomic rename. Caddy owns
          // certificate storage; this file contains desired names, never issuance claims.
          const temporaryDir = yield* fs.makeTempDirectoryScoped({
            directory: data,
            prefix: '.intent-'
          })
          const temporary = path.join(temporaryDir, 'intent.json')
          yield* Effect.scoped(
            Effect.gen(function* () {
              const file = yield* fs.open(temporary, {
                flag: 'wx',
                mode: 0o600
              })
              yield* file.writeAll(encoded)
              yield* file.sync
            })
          )
          yield* fs.rename(temporary, statePath)
          const directory = yield* fs.open(data, { flag: 'r' })
          yield* directory.sync
        },
        Effect.scoped,
        Effect.uninterruptible,
        Effect.catchTag('PlatformError', () =>
          Effect.fail(new BoundaryError({ code: 'intent-save-failed' }))
        )
      )
      return IntentStore.of({ load, save })
    })
  )
