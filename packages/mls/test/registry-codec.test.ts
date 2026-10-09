import { createInception, createReset, didFromInception, digestOf } from '@kokuin/controller'
import { describe, expect, test } from 'vitest'

import { createGroup } from '../src/group-create.js'
import {
  type DeviceRegistry,
  DeviceRegistryCodecError,
  decodeClientState,
  decodeDeviceRegistry,
  encodeClientState,
  encodeDeviceRegistry,
  parseMLSCredentialIdentity,
  registrySeed,
} from '../src/index.js'
import {
  agent,
  bindingFor,
  controllerID,
  controllerSeed,
  inception,
  trustedGrant,
} from './fixtures/lifecycle-ledger.js'

function populatedRegistry(): DeviceRegistry {
  const reset = createReset(controllerSeed, 0, 1)
  const other = createInception(new Uint8Array(32).fill(44), 0)
  return {
    devices: new Map([
      [agent(41).id, { controller: controllerID, status: 'active', label: 'Laptop 組合' }],
      [agent(42).id, { controller: controllerID, status: 'active' }],
      [agent(43).id, { controller: controllerID, status: 'active', label: 'Chained device' }],
      [
        agent(45).id,
        {
          controller: controllerID,
          status: 'revoked',
          label: '',
          logPosition: 0,
          reason: 'reset',
          cascadedFrom: agent(42).id,
        },
      ],
    ]),
    controllers: new Map([
      [
        controllerID,
        {
          recordedLog: [inception, reset],
          genFloor: 1,
          timeFloor: 1750000000,
          beacon: { logLength: 2, headDigest: digestOf(reset.event) },
        },
      ],
      [didFromInception(other.event), { recordedLog: [], genFloor: 0, timeFloor: 0 }],
    ]),
  }
}

describe('device registry codec', () => {
  test('round-trips an empty registry', () => {
    const registry = registrySeed()
    const bytes = encodeDeviceRegistry(registry)

    expect(bytes[0]).toBe(1)
    expect(decodeDeviceRegistry(bytes)).toEqual(registry)
  })

  test('round-trips every device and controller field', () => {
    const registry = populatedRegistry()
    const decoded = decodeDeviceRegistry(encodeDeviceRegistry(registry))

    expect(decoded).toEqual(registry)
    expect(decoded.devices).toBeInstanceOf(Map)
    expect(decoded.controllers).toBeInstanceOf(Map)
  })

  test('encodes deterministically and re-encodes decoded bytes exactly', () => {
    const registry = populatedRegistry()
    const bytes = encodeDeviceRegistry(registry)

    expect(encodeDeviceRegistry(registry)).toEqual(bytes)
    expect(encodeDeviceRegistry(decodeDeviceRegistry(bytes))).toEqual(bytes)
    expect(
      encodeDeviceRegistry({
        devices: new Map([...registry.devices].reverse()),
        controllers: new Map([...registry.controllers].reverse()),
      }),
    ).toEqual(bytes)
  })

  test('preserves chained leaf holder evidence alongside the registry', async () => {
    const holder = agent(42)
    const device = agent(43)
    const controller = await bindingFor(device, [inception], {
      identity: holder,
      parent: await trustedGrant(holder),
    })
    expect(controller.holderGrant).toBeDefined()
    const { group } = await createGroup(device, 'registry-holder-evidence', { controller })
    const registry = populatedRegistry()
    const decoded = decodeClientState(encodeClientState(group.state))
    const leaf = decoded?.ratchetTree.find((node) => node != null && 'leaf' in node)
    if (leaf == null || !('leaf' in leaf) || !('identity' in leaf.leaf.credential)) {
      throw new Error('Missing decoded leaf credential')
    }

    expect(parseMLSCredentialIdentity(leaf.leaf.credential.identity).controller).toEqual(controller)
    expect(decodeDeviceRegistry(encodeDeviceRegistry(registry))).toEqual(registry)
  })

  test('rejects every truncated prefix with a typed codec error', () => {
    const bytes = encodeDeviceRegistry(populatedRegistry())

    for (let length = 0; length < bytes.length; length++) {
      expect(() => decodeDeviceRegistry(bytes.subarray(0, length))).toThrow(
        DeviceRegistryCodecError,
      )
    }
  })

  test('rejects an unknown version before decoding the body', () => {
    const bytes = encodeDeviceRegistry(populatedRegistry())
    bytes[0] = 2

    expect(() => decodeDeviceRegistry(bytes)).toThrow(DeviceRegistryCodecError)
    expect(() => decodeDeviceRegistry(bytes)).toThrow('unsupported device-registry version 2')
  })

  test.each(['devices', 'controllers'] as const)('rejects duplicate %s keys', (field) => {
    const registry = populatedRegistry()
    const devices = [...registry.devices]
    const controllers = [...registry.controllers]
    const body = {
      devices: field === 'devices' ? [...devices, ...devices.slice(0, 1)] : devices,
      controllers:
        field === 'controllers' ? [...controllers, ...controllers.slice(0, 1)] : controllers,
    }
    const encoded = new TextEncoder().encode(JSON.stringify(body))
    const bytes = new Uint8Array(encoded.length + 1)
    bytes[0] = 1
    bytes.set(encoded, 1)

    expect(() => decodeDeviceRegistry(bytes)).toThrow(DeviceRegistryCodecError)
  })

  test.each([
    null,
    {},
    { devices: {}, controllers: [] },
    { devices: [['device', { controller: controllerID, status: 'unknown' }]], controllers: [] },
    {
      devices: [],
      controllers: [[controllerID, { recordedLog: [], genFloor: 0 }]],
    },
    {
      devices: [],
      controllers: [[controllerID, { recordedLog: [null], genFloor: 0, timeFloor: 0 }]],
    },
  ])('rejects a malformed registry body: %j', (value) => {
    const body = new TextEncoder().encode(JSON.stringify(value))
    const bytes = new Uint8Array(body.length + 1)
    bytes[0] = 1
    bytes.set(body, 1)

    expect(() => decodeDeviceRegistry(bytes)).toThrow(DeviceRegistryCodecError)
  })
})
