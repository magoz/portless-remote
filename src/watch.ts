import { Effect, FileSystem, Queue, Ref, Stream } from 'effect'
import type { Config } from '#app/model'
import type { Report } from '#app/reconciler'

export const watch = Effect.fn('Observer.watch')(function* <E, R>(
  config: Config,
  reconcile: Effect.Effect<Report, E, R>,
  emit: (report: Report) => Effect.Effect<void, E, R>
) {
  const fs = yield* FileSystem.FileSystem
  const pending = yield* Queue.sliding<void>(1)
  const lastOutput = yield* Ref.make('')
  const notify = Queue.offer(pending, undefined)
  yield* notify
  // Periodic reconciliation is authoritative even if notifications are lost.
  yield* Effect.forkScoped(
    Effect.forever(Effect.sleep(config.pollIntervalMs).pipe(Effect.andThen(notify)))
  )
  // Renew the scoped watcher each interval: fs.watch may silently keep watching
  // an unlinked inode after directory recreation. Errors fall back to polling.
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.scoped(
        fs.watch(config.portlessStateDir).pipe(
          Stream.runForEach(() => notify),
          Effect.timeoutOption(config.pollIntervalMs),
          Effect.catch(() => Effect.sleep(config.pollIntervalMs))
        )
      )
    )
  )
  yield* Effect.forever(
    Effect.gen(function* () {
      yield* Queue.take(pending)
      const report = yield* reconcile
      const encoded = JSON.stringify(report)
      if ((yield* Ref.get(lastOutput)) !== encoded) {
        yield* emit(report)
        yield* Ref.set(lastOutput, encoded)
      }
    })
  )
}, Effect.scoped)
