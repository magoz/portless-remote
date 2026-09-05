import { NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Layer, Path, Ref } from 'effect'
import { BoundaryError, emptyIntent, parseConfig } from '#app/model'
import type { Config, Intent } from '#app/model'
import { Files, Processes } from '#app/io'
import { DnsInventory } from '#app/dns'
import { IntentStore } from '#app/state'

export const sample = {
  namespace: 'dev.example.com',
  ownerId: 'test-observer',
  portlessStateDir: '/tmp/example-portless',
  dataDir: '/tmp/example-remote',
  gatewayAddress: '10.10.10.10',
  portlessCaFile: '/tmp/example-portless/ca.pem',
  pidMode: 'same-namespace',
  pollIntervalMs: 250
}
export const configEffect = parseConfig(JSON.stringify(sample))
export const route = (hostname = 'app.dev.example.com', pid = process.pid) => ({
  hostname,
  pid,
  port: 4321
})
export const platform = Layer.mergeAll(
  NodeServices.layer,
  Files.layer.pipe(Layer.provide(NodeServices.layer)),
  Processes.layer
)
export const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped({
    prefix: 'portless-remote-test-'
  })
  const config = yield* parseConfig(
    JSON.stringify({
      ...sample,
      portlessStateDir: path.join(root, 'portless'),
      dataDir: path.join(root, 'remote'),
      portlessCaFile: path.join(root, 'portless', 'ca.pem')
    })
  )
  yield* fs.makeDirectory(config.portlessStateDir)
  const registry = path.join(config.portlessStateDir, 'routes.json')
  return { fs, path, root, config, registry }
})

export const memoryServices = (config: Config) =>
  Effect.gen(function* () {
    const text = yield* Ref.make(JSON.stringify([route()]))
    const intent = yield* Ref.make<Intent>(emptyIntent(config))
    const saveCount = yield* Ref.make(0)
    const failSave = yield* Ref.make(false)
    const services = Layer.mergeAll(
      Layer.succeed(Files, { read: () => Ref.get(text) }),
      Layer.succeed(Processes, { probe: () => Effect.succeed('alive') }),
      Layer.succeed(DnsInventory, { read: Effect.succeed(undefined) }),
      Layer.succeed(IntentStore, {
        load: Ref.get(intent),
        save: next =>
          Effect.gen(function* () {
            if (yield* Ref.get(failSave))
              return yield* Effect.fail(new BoundaryError({ code: 'intent-save-failed' }))
            yield* Ref.set(intent, next)
            yield* Ref.update(saveCount, n => n + 1)
          })
      })
    )
    return { text, intent, saveCount, failSave, services }
  })
