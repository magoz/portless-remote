import { isIP } from 'node:net'
import { isAbsolute, relative } from 'node:path'
import { Effect, Schema } from 'effect'

// Error codes only: never retain raw file contents, OS errors, or provider responses.
export class BoundaryError extends Schema.TaggedError<BoundaryError>()('BoundaryError', {
  code: Schema.String
}) {}

export const decodeJson = <S extends Schema.Constraint>(schema: S, text: string, code: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema), {
    onExcessProperty: 'error'
  })(text).pipe(Effect.mapError(() => new BoundaryError({ code })))

export const validHostname = (name: string): boolean =>
  name.length <= 253 &&
  name === name.toLowerCase() &&
  isIP(name) === 0 &&
  name.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))

export const inNamespace = (hostname: string, namespace: string): boolean =>
  validHostname(hostname) && hostname.endsWith(`.${namespace}`)

export const isWithin = (parent: string, child: string): boolean => {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('../') && rel !== '..' && !isAbsolute(rel))
}

export const privateAddress = (address: string): boolean => {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number)
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    )
  }
  return isIP(address) === 6 && /^f[cd][0-9a-f]{2}:/i.test(address)
}

const ConfigSchema = Schema.Struct({
  namespace: Schema.String,
  ownerId: Schema.String,
  portlessStateDir: Schema.String,
  dataDir: Schema.String,
  gatewayAddress: Schema.String,
  portlessCaFile: Schema.String,
  pidMode: Schema.Literals(['same-namespace', 'unverified']),
  includePersistentAliases: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false))
  ),
  pollIntervalMs: Schema.Int.check(Schema.isBetween({ minimum: 250, maximum: 60_000 })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(5_000))
  ),
  maxHosts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(1_000))
  ),
  dnsInventoryFile: Schema.optionalKey(Schema.String)
})
export type Config = typeof ConfigSchema.Type

// Parent components are ambiguous when callers normalize before following symlinks.
// Reject them instead of silently assigning different input paths to different readers.
export const validConfigPaths = (config: Config): boolean =>
  [
    config.portlessStateDir,
    config.dataDir,
    config.portlessCaFile,
    ...(config.dnsInventoryFile === undefined ? [] : [config.dnsInventoryFile])
  ].every(name => isAbsolute(name) && !name.split('/').includes('..'))

export const parseConfig = (text: string) =>
  decodeJson(ConfigSchema, text, 'config-invalid').pipe(
    Effect.filterOrFail(
      c =>
        validHostname(c.namespace) &&
        c.namespace.includes('.') &&
        !/(?:^|\.)(localhost|local|internal|test|invalid|onion)$/.test(c.namespace) &&
        /^[a-z0-9][a-z0-9-]{0,62}$/.test(c.ownerId) &&
        validConfigPaths(c) &&
        !isWithin(c.portlessStateDir, c.dataDir) &&
        !isWithin(c.dataDir, c.portlessStateDir) &&
        privateAddress(c.gatewayAddress),
      () => new BoundaryError({ code: 'config-unsafe' })
    )
  )

export const RouteSchema = Schema.Struct({
  hostname: Schema.String,
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
  pid: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2_147_483_647 }))
})
export type Route = typeof RouteSchema.Type

export const sortedUnique = (names: readonly string[]): string[] => [...new Set(names)].sort()

export const IntentSchema = Schema.Struct({
  version: Schema.Literal(1),
  namespace: Schema.String,
  ownerId: Schema.String,
  retainedHosts: Schema.Array(Schema.String)
})
export type Intent = typeof IntentSchema.Type
export const emptyIntent = (config: Config): Intent => ({
  version: 1,
  namespace: config.namespace,
  ownerId: config.ownerId,
  retainedHosts: []
})

export const validateIntent = (config: Config, intent: Intent) =>
  intent.namespace === config.namespace &&
  intent.ownerId === config.ownerId &&
  intent.retainedHosts.length <= config.maxHosts &&
  intent.retainedHosts.every(name => inNamespace(name, config.namespace)) &&
  new Set(intent.retainedHosts).size === intent.retainedHosts.length
