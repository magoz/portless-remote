import { isIP } from 'node:net'
import { Context, Effect, Layer, Schema } from 'effect'
import { BoundaryError, decodeJson, inNamespace, sortedUnique } from '#app/model'
import type { Config } from '#app/model'
import { Files } from '#app/io'

// DNS owner names (TXT/SRV/ACME, etc.) are broader than HTTP hostnames.
const validDnsOwner = (name: string) =>
  name.length <= 253 &&
  name === name.toLowerCase() &&
  (name.startsWith('*.') ? name.slice(2) : name)
    .split('.')
    .every(label => /^[a-z0-9_-]{1,63}$/.test(label))

const RRsetSchema = Schema.Struct({
  name: Schema.String,
  type: Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9]{0,15}$/)),
  values: Schema.Array(Schema.String),
  ownerId: Schema.optionalKey(Schema.String)
})
const InventorySchema = Schema.Struct({
  version: Schema.Literal(1),
  namespace: Schema.String,
  records: Schema.Array(RRsetSchema)
})
export type Inventory = typeof InventorySchema.Type
export interface DesiredRecord {
  readonly name: string
  readonly type: 'A' | 'AAAA'
  readonly values: readonly string[]
  readonly ownerId: string
}
export interface DnsChange {
  readonly record: DesiredRecord
  readonly action:
    | 'ensure-unverified'
    | 'create'
    | 'update-owned'
    | 'unchanged'
    | 'satisfied-unmanaged'
    | 'blocked'
  readonly reason?: string
}

export class DnsInventory extends Context.Service<
  DnsInventory,
  {
    // This boundary deliberately offers no mutation capability.
    readonly read: Effect.Effect<Inventory | undefined, BoundaryError>
  }
>()('portless-remote/DnsInventory') {}

export const parseInventory = (config: Config, text: string) =>
  decodeJson(InventorySchema, text, 'dns-inventory-invalid').pipe(
    Effect.filterOrFail(
      inventory => {
        const keys = inventory.records.map(r => `${r.name}/${r.type}`)
        return (
          inventory.namespace === config.namespace &&
          inventory.records.length <= 50_000 &&
          new Set(keys).size === keys.length &&
          inventory.records.every(r => validDnsOwner(r.name) && r.values.length > 0)
        )
      },
      () => new BoundaryError({ code: 'dns-inventory-invalid' })
    )
  )

export const dnsInventoryLayer = (config: Config) =>
  Layer.effect(
    DnsInventory,
    Effect.gen(function* () {
      const files = yield* Files
      const path = config.dnsInventoryFile
      return {
        read:
          path === undefined
            ? Effect.succeed(undefined)
            : files.read(path).pipe(Effect.flatMap(text => parseInventory(config, text)))
      }
    })
  )

// Registry names do not identify app-vs-branch. Group by immediate parent below
// the namespace, with exact + one-label wildcard subjects for each group.
export const certificateGroups = (hosts: readonly string[], namespace: string) => {
  const bases = sortedUnique(
    hosts.map(host => {
      const relativeLabels = host.slice(0, -(namespace.length + 1)).split('.')
      return relativeLabels.length === 1 ? host : host.slice(host.indexOf('.') + 1)
    })
  )
  return bases.map(base => ({
    subjects: base.length <= 251 ? [base, `*.${base}`] : [base],
    challenge: 'dns-01' as const
  }))
}

export const desiredDns = (config: Config, hosts: readonly string[]): DesiredRecord[] => {
  const names = sortedUnique([
    ...hosts,
    ...certificateGroups(hosts, config.namespace).flatMap(g => g.subjects)
  ])
  return names.map(name => ({
    name,
    type: isIP(config.gatewayAddress) === 4 ? 'A' : 'AAAA',
    values: [config.gatewayAddress],
    ownerId: config.ownerId
  }))
}

export const diffDns = (
  config: Config,
  desired: readonly DesiredRecord[],
  inventory?: Inventory
): DnsChange[] =>
  desired.map(record => {
    const plain = record.name.startsWith('*.') ? record.name.slice(2) : record.name
    if (!inNamespace(plain, config.namespace))
      return { record, action: 'blocked', reason: 'outside-namespace' }
    if (inventory === undefined) return { record, action: 'ensure-unverified' }
    if (
      inventory.records.some(
        r =>
          r.type === 'NS' &&
          r.name !== config.namespace &&
          (plain === r.name || plain.endsWith(`.${r.name}`))
      )
    ) {
      return { record, action: 'blocked', reason: 'delegated-subzone' }
    }
    if (inventory.records.some(r => r.type === 'DNAME' && record.name.endsWith(`.${r.name}`))) {
      return {
        record,
        action: 'blocked',
        reason: 'ancestor-dname-redirection'
      }
    }
    const atName = inventory.records.filter(r => r.name === record.name)
    if (
      atName.some(
        r => r.type === 'CNAME' || ((r.type === 'A' || r.type === 'AAAA') && r.type !== record.type)
      )
    ) {
      return {
        record,
        action: 'blocked',
        reason: 'conflicting-address-or-cname'
      }
    }
    const existing = atName.find(r => r.type === record.type)
    if (!existing) return { record, action: 'create' }
    const same = JSON.stringify(sortedUnique(existing.values)) === JSON.stringify(record.values)
    const owned = existing.ownerId === config.ownerId
    if (same) return { record, action: owned ? 'unchanged' : 'satisfied-unmanaged' }
    if (owned) return { record, action: 'update-owned' }
    return { record, action: 'blocked', reason: 'unmanaged-record-conflict' }
  })
