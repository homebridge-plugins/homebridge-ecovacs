import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import { EcovacsRoboticVacuumAccessory } from './EcovacsRoboticVacuumAccessory.js'

// Enough of the Homebridge API for the vacuum to build itself and push state
function makeVacuum() {
  const updateAccessoryState = vi.fn(async () => {})
  const api = {
    matter: {
      uuid: { generate: (id: string) => `uuid-${id}` },
      deviceTypes: { RoboticVacuumCleaner: {} },
      updateAccessoryState,
    },
  }
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const vacuum = new EcovacsRoboticVacuumAccessory(api as any, log as any, {
    did: 'abc-123',
    nick: 'Deebot',
    company: 'Ecovacs',
    deviceModel: 'X1 Plus',
    isV2: true,
  } as any)
  const control = Object.assign(new EventEmitter(), { run: vi.fn() })
  vacuum.connectControl(control)
  return { vacuum, control, updateAccessoryState }
}

// Lets the async event handlers run
const settle = () => new Promise(resolve => setImmediate(resolve))

// The last batChargeState the vacuum sent to Matter
function lastBatChargeState(updateAccessoryState: ReturnType<typeof vi.fn>): number | undefined {
  const sent = updateAccessoryState.mock.calls
    .filter(([, cluster, attributes]) => cluster === 'powerSource' && 'batChargeState' in attributes)
  return sent.at(-1)?.[2].batChargeState
}

describe('ecovacsRoboticVacuumAccessory battery charge state (#322)', () => {
  it('tells Matter the battery is charging, so the Home app can show it', async () => {
    const { vacuum, control, updateAccessoryState } = makeVacuum()
    await vacuum.markRegistered()

    control.emit('BatteryInfo', 60)
    control.emit('ChargeState', 'charging')
    await settle()
    expect(lastBatChargeState(updateAccessoryState)).toBe(1) // IsCharging

    control.emit('ChargeState', 'returning')
    await settle()
    expect(lastBatChargeState(updateAccessoryState)).toBe(3) // IsNotCharging
  })

  it('reports a full battery once charging has finished on the dock', async () => {
    const { vacuum, control, updateAccessoryState } = makeVacuum()
    await vacuum.markRegistered()

    control.emit('ChargeState', 'charging')
    control.emit('BatteryInfo', 100)
    control.emit('ChargeState', 'idle')
    await settle()
    expect(lastBatChargeState(updateAccessoryState)).toBe(2) // IsAtFullCharge
  })

  it('does not call a robot that is cleaning on a full battery fully charged', async () => {
    const { vacuum, control, updateAccessoryState } = makeVacuum()
    await vacuum.markRegistered()

    control.emit('BatteryInfo', 100)
    control.emit('CleanReport', 'auto')
    control.emit('ChargeState', 'idle')
    await settle()
    expect(lastBatChargeState(updateAccessoryState)).toBe(3) // IsNotCharging
  })

  it('keeps sending the battery level with each reading', async () => {
    const { vacuum, control, updateAccessoryState } = makeVacuum()
    await vacuum.markRegistered()

    control.emit('BatteryInfo', 40)
    control.emit('BatteryInfo', 41)
    await settle()
    const levels = updateAccessoryState.mock.calls
      .filter(([, cluster, attributes]) => cluster === 'powerSource' && 'batPercentRemaining' in attributes)
      .map(([, , attributes]) => attributes.batPercentRemaining)
    expect(levels).toEqual([80, 82]) // half-percent units
  })
})
