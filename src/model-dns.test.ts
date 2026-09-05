import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { certificateGroups, desiredDns, diffDns, parseInventory } from '#app/dns'
import type { Inventory } from '#app/dns'
import { inNamespace, parseConfig, privateAddress } from '#app/model'
import { configEffect, sample } from '#app/testing/fixtures'

it.effect('config defaults are credential-free and safe', () =>
  Effect.gen(function* () {
    const config = yield* configEffect
    expect(config.includePersistentAliases).toBe(false)
    expect(config.maxHosts).toBe(1000)
  })
)

for (const patch of [
  { namespace: 'localhost' },
  { namespace: 'dev.localhost' },
  { namespace: '*.example.com' },
  { namespace: 'dev.example.com.' },
  { gatewayAddress: '8.8.8.8' },
  { gatewayAddress: '127.0.0.1' },
  { gatewayAddress: '::1' },
  { dataDir: sample.portlessStateDir },
  { dataDir: `${sample.portlessStateDir}/remote` },
  { portlessStateDir: 'relative' },
  { portlessStateDir: '/tmp/alias/../portless' },
  { portlessCaFile: '/tmp/alias/../ca.pem' },
  { dnsInventoryFile: '/tmp/alias/../inventory.json' },
  { dataDir: '/tmp/alias/../state' },
  { dnsToken: 'secret-canary' },
  { maxHosts: 0 },
  { pollIntervalMs: 0 }
])
  it.effect(`rejects unsafe configuration: ${JSON.stringify(patch)}`, () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(parseConfig(JSON.stringify({ ...sample, ...patch })))
      expect(result._tag).toBe('Failure')
      expect(JSON.stringify(result)).not.toContain('secret-canary')
    })
  )

it('validates private IPv4, CGNAT and IPv6 ULA addresses', () => {
  for (const address of ['10.1.2.3', '172.16.0.1', '192.168.1.1', '100.64.0.1', 'fd12:3456::1'])
    expect(privateAddress(address)).toBe(true)
  for (const address of [
    '172.32.0.1',
    '100.128.0.1',
    'fe80::1',
    '::ffff:10.1.2.3',
    'https://example.com'
  ])
    expect(privateAddress(address)).toBe(false)
})

it('rejects namespace confusion, arbitrary names and malformed DNS labels', () => {
  for (const name of [
    'dev.example.com',
    'app.dev.example.com.attacker.com',
    'evildev.example.com',
    'app.localhost',
    '*.app.dev.example.com',
    'A.dev.example.com',
    'x..dev.example.com',
    '-x.dev.example.com',
    'x_.dev.example.com',
    'a\n.dev.example.com',
    `${'x'.repeat(64)}.dev.example.com`,
    `${'a.'.repeat(125)}dev.example.com`
  ]) {
    expect(inNamespace(name, 'dev.example.com')).toBe(false)
  }
  expect(inNamespace('feat.app.dev.example.com', 'dev.example.com')).toBe(true)
})

it.effect('groups parallel worktrees and dotted names without flattening or overbroad TLS', () =>
  Effect.gen(function* () {
    const config = yield* configEffect
    const hosts = [
      'app.dev.example.com',
      'feat.app.dev.example.com',
      'fix.app.dev.example.com',
      'deep.feat.app.dev.example.com',
      'new.dev.example.com'
    ]
    expect(certificateGroups(hosts, config.namespace)).toEqual([
      {
        subjects: ['app.dev.example.com', '*.app.dev.example.com'],
        challenge: 'dns-01'
      },
      {
        subjects: ['feat.app.dev.example.com', '*.feat.app.dev.example.com'],
        challenge: 'dns-01'
      },
      {
        subjects: ['new.dev.example.com', '*.new.dev.example.com'],
        challenge: 'dns-01'
      }
    ])
    const names = desiredDns(config, hosts).map(r => r.name)
    expect(names).toContain('feat.app.dev.example.com')
    expect(names).toContain('*.feat.app.dev.example.com')
    expect(names).not.toContain('*.dev.example.com')
    expect(desiredDns(config, [...hosts].reverse())).toEqual(desiredDns(config, hosts))
  })
)

it.effect('unconfigured DNS is unknown, never an empty authoritative inventory', () =>
  Effect.gen(function* () {
    const config = yield* configEffect
    const desired = desiredDns(config, ['app.dev.example.com'])
    expect(diffDns(config, desired).every(c => c.action === 'ensure-unverified')).toBe(true)
  })
)

it.effect(
  'DNS diff is additive, idempotent, ownership-scoped and preserves unmanaged records',
  () =>
    Effect.gen(function* () {
      const config = yield* configEffect
      const desired = desiredDns(config, ['app.dev.example.com'])
      const empty: Inventory = {
        version: 1,
        namespace: config.namespace,
        records: []
      }
      expect(diffDns(config, desired, empty).every(c => c.action === 'create')).toBe(true)
      const owned: Inventory = { ...empty, records: desired }
      expect(diffDns(config, desired, owned).every(c => c.action === 'unchanged')).toBe(true)
      const unmanaged: Inventory = {
        ...empty,
        records: desired.map(({ ownerId: _, ...r }) => r)
      }
      const before = JSON.stringify(unmanaged)
      expect(
        diffDns(config, desired, unmanaged).every(c => c.action === 'satisfied-unmanaged')
      ).toBe(true)
      expect(JSON.stringify(unmanaged)).toBe(before)
      const conflicts: Inventory = {
        ...empty,
        records: unmanaged.records.map(r => ({
          ...r,
          values: ['10.0.0.99']
        }))
      }
      expect(diffDns(config, desired, conflicts).every(c => c.action === 'blocked')).toBe(true)
      const update: Inventory = {
        ...empty,
        records: conflicts.records.map(r => ({
          ...r,
          ownerId: config.ownerId
        }))
      }
      expect(diffDns(config, desired, update).every(c => c.action === 'update-owned')).toBe(true)
      expect(diffDns(config, [], owned)).toEqual([]) // no deletion of even owned records
    })
)

it.effect('blocks CNAME, opposite-family address conflicts and delegated subzones', () =>
  Effect.gen(function* () {
    const config = yield* configEffect
    const desired = desiredDns(config, ['app.dev.example.com'])
    for (const type of ['CNAME', 'AAAA', 'NS']) {
      const inventory: Inventory = {
        version: 1,
        namespace: config.namespace,
        records: [
          {
            name: 'app.dev.example.com',
            type,
            values: ['not-printed-secret-canary']
          }
        ]
      }
      const result = diffDns(config, desired, inventory)
      expect(result.find(c => c.record.name === 'app.dev.example.com')?.action).toBe('blocked')
      expect(JSON.stringify(result)).not.toContain('secret-canary')
    }
  })
)

it.effect('accepts real DNS owner grammar without admitting those names as HTTP routes', () =>
  Effect.gen(function* () {
    const config = yield* configEffect
    const records = [
      {
        name: '_acme-challenge.app.dev.example.com',
        type: 'TXT',
        values: ['challenge']
      },
      {
        name: '_http._tcp.app.dev.example.com',
        type: 'SRV',
        values: ['0 0 443 app.dev.example.com']
      }
    ]
    const inventory = yield* parseInventory(
      config,
      JSON.stringify({ version: 1, namespace: config.namespace, records })
    )
    expect(inventory.records).toEqual(records)
    for (const record of records) expect(inNamespace(record.name, config.namespace)).toBe(false)
    expect(
      diffDns(config, desiredDns(config, ['app.dev.example.com']), inventory).every(
        c => c.action === 'create'
      )
    ).toBe(true)
  })
)

it.effect(
  'blocks DNAME descendants, including wildcard owners, but not the DNAME owner itself',
  () =>
    Effect.gen(function* () {
      const config = yield* configEffect
      const desired = desiredDns(config, ['feat.app.dev.example.com'])
      const changes = diffDns(config, desired, {
        version: 1,
        namespace: config.namespace,
        records: [
          {
            name: 'app.dev.example.com',
            type: 'DNAME',
            values: ['other.example.com']
          }
        ]
      })
      expect(changes.filter(c => c.action === 'blocked').map(c => c.record.name)).toEqual([
        '*.app.dev.example.com',
        'feat.app.dev.example.com'
      ])
      expect(changes.find(c => c.record.name === 'app.dev.example.com')?.action).toBe('create')
    })
)

it.effect('uses exact-only certificates where a wildcard would exceed 253 characters', () =>
  Effect.gen(function* () {
    const namespace = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(58)}`
    const config = yield* parseConfig(JSON.stringify({ ...sample, namespace }))
    for (const label of ['x', 'xx']) {
      const host = `${label}.${namespace}`
      expect(host.length).toBeGreaterThanOrEqual(252)
      expect(inNamespace(host, namespace)).toBe(true)
      expect(certificateGroups([host], namespace)[0]?.subjects).toEqual([host])
      expect(desiredDns(config, [host]).map(r => r.name)).toEqual([host])
    }
  })
)

it.effect('rejects malformed or wrong-zone inventory rather than inventing changes', () =>
  Effect.gen(function* () {
    const config = yield* configEffect
    const records = [{ name: 'app.dev.example.com', type: 'A', values: ['10.1.2.3'] }]
    for (const value of [
      '{secret-canary',
      JSON.stringify({ version: 1, namespace: 'example.net', records }),
      JSON.stringify({
        version: 1,
        namespace: config.namespace,
        records: [...records, ...records]
      })
    ]) {
      const result = yield* Effect.result(parseInventory(config, value))
      expect(result._tag).toBe('Failure')
      expect(JSON.stringify(result)).not.toContain('secret-canary')
    }
  })
)
