import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import { EcovacsRoboticVacuumAccessory } from './EcovacsRoboticVacuumAccessory.js'

// Enough of the Homebridge API for the vacuum to build itself and push state
function makeVacuum(isV2 = true) {
  const updateAccessoryState = vi.fn(async () => {})
  const api = {
    matter: {
      uuid: {
        generate: (id: string) => `uuid-${id}`,
      },
      deviceTypes: { RoboticVacuumCleaner: {} },
      updateAccessoryState,
    },
  }
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
  const vacuum = new EcovacsRoboticVacuumAccessory(api as any, log as any, {
    did: 'abc-123',
    nick: 'Deebot',
    company: 'Ecovacs',
    deviceModel: 'X1 Plus',
    isV2,
  } as any)
  const control = Object.assign(new EventEmitter(), {
    run: vi.fn(),
  })
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

// Every value of one attribute the vacuum sent to Matter, in order
function sent(updateAccessoryState: ReturnType<typeof vi.fn>, cluster: string, attribute: string): unknown[] {
  return updateAccessoryState.mock.calls
    .filter(([, c, attributes]) => c === cluster && attribute in attributes)
    .map(([, , attributes]) => attributes[attribute])
}

// The library sends a CleanReport and then its last ChargeState together,
// in the same tick, every time the robot reports its clean state
function cleanInfo(control: EventEmitter, cleanReport: string, chargeState: string) {
  control.emit('CleanReport', cleanReport)
  control.emit('ChargeState', chargeState)
}

describe('ecovacsRoboticVacuumAccessory cleaning state (#322)', () => {
  it('stays Running while cleaning, even though ChargeState says idle', async () => {
    const { vacuum, control, updateAccessoryState } = makeVacuum()
    await vacuum.markRegistered()

    // Sitting on the dock, full
    control.emit('BatteryInfo', 100)
    cleanInfo(control, 'idle', 'idle')
    await settle()
    updateAccessoryState.mockClear()

    // The reporter's log: cleaning starts while the library still has
    // 'charging' cached, then a lone ChargeState 'idle', then a poll
    cleanInfo(control, 'auto', 'charging')
    await settle()
    control.emit('ChargeState', 'idle')
    await settle()
    control.emit('ChargeState', 'idle')
    control.emit('CleanSpeed', 3)
    cleanInfo(control, 'auto', 'idle')
    control.emit('BatteryInfo', 99)
    await settle()

    // Never Docked or Charging, never "fully charged", and the run mode is Cleaning
    expect(sent(updateAccessoryState, 'rvcOperationalState', 'operationalState')).toEqual([1])
    expect(sent(updateAccessoryState, 'rvcRunMode', 'currentMode')).toEqual([1])
    expect(sent(updateAccessoryState, 'powerSource', 'batChargeState')).not.toContain(2)
    expect(lastBatChargeState(updateAccessoryState)).toBe(3) // IsNotCharging
    expect(sent(updateAccessoryState, 'powerSource', 'batPercentRemaining')).toEqual([198])
  })

  it('follows the robot home, onto the charger and to a full battery', async () => {
    const { vacuum, control, updateAccessoryState } = makeVacuum()
    await vacuum.markRegistered()

    control.emit('BatteryInfo', 80)
    cleanInfo(control, 'auto', 'idle')
    await settle()

    control.emit('CleanReport', 'pause')
    await settle()
    expect(sent(updateAccessoryState, 'rvcOperationalState', 'operationalState').at(-1)).toBe(2) // Paused
    expect(sent(updateAccessoryState, 'rvcRunMode', 'currentMode').at(-1)).toBe(1) // still Cleaning

    cleanInfo(control, 'returning', 'returning')
    await settle()
    expect(sent(updateAccessoryState, 'rvcOperationalState', 'operationalState').at(-1)).toBe(64) // SeekingCharger
    expect(sent(updateAccessoryState, 'rvcRunMode', 'currentMode').at(-1)).toBe(0) // Idle

    control.emit('ChargeState', 'charging')
    cleanInfo(control, 'idle', 'charging')
    await settle()
    expect(sent(updateAccessoryState, 'rvcOperationalState', 'operationalState').at(-1)).toBe(65) // Charging
    expect(lastBatChargeState(updateAccessoryState)).toBe(1) // IsCharging

    control.emit('BatteryInfo', 100)
    control.emit('ChargeState', 'idle')
    await settle()
    expect(sent(updateAccessoryState, 'rvcOperationalState', 'operationalState').at(-1)).toBe(66) // Docked
    expect(lastBatChargeState(updateAccessoryState)).toBe(2) // IsAtFullCharge
  })
})

describe('ecovacsRoboticVacuumAccessory area cleaning', () => {
  it('shows an area clean reported as spotArea_V2 as Running', async () => {
    const { vacuum, control, updateAccessoryState } = makeVacuum()
    await vacuum.markRegistered()

    // The report is lower-cased with everything but letters and digits
    // removed, so the list has to hold 'spotareav2', not 'spotarea_v2'
    cleanInfo(control, 'spotArea_V2', 'idle')
    await settle()

    expect(sent(updateAccessoryState, 'rvcOperationalState', 'operationalState').at(-1)).toBe(1)
  })
})

describe('ecovacsRoboticVacuumAccessory suction levels (#322)', () => {
  function cleanModes(vacuum: unknown): { label: string, mode: number, modeTags: { value: number }[] }[] {
    return (vacuum as any).clusters.rvcCleanMode.supportedModes
  }

  it('offers all four suction levels on a newer robot, not just Max', () => {
    const { vacuum } = makeVacuum()

    expect(cleanModes(vacuum).map(mode => mode.label)).toEqual(['Quiet', 'Standard', 'Max', 'Max+'])
  })

  it('keeps every level a vacuum mode with its own set of tags, as Matter requires', () => {
    const { vacuum } = makeVacuum()
    const tagSets = cleanModes(vacuum).map(mode => mode.modeTags.map(tag => tag.value).sort().join(','))

    expect(new Set(tagSets).size).toBe(tagSets.length)
    expect(cleanModes(vacuum).every(mode => mode.modeTags.some(tag => tag.value === 16385))).toBe(true)
  })

  it('shows the speed the robot reports as the matching level', async () => {
    const { vacuum, control, updateAccessoryState } = makeVacuum()
    await vacuum.markRegistered()

    control.emit('CleanSpeed', 1)
    await settle()
    control.emit('CleanSpeed', 4)
    await settle()
    control.emit('CleanSpeed', 2)
    await settle()

    expect(sent(updateAccessoryState, 'rvcCleanMode', 'currentMode')).toEqual([1, 4, 0])
  })

  it('sends the matching speed when a level is chosen in Home', async () => {
    const { vacuum, control } = makeVacuum()
    await vacuum.markRegistered()
    Object.assign(control, { is_ready: true })
    const changeToMode = (vacuum as any).handlers.rvcCleanMode.changeToMode

    await changeToMode({ newMode: 1 })
    await changeToMode({ newMode: 4 })

    expect(control.run).toHaveBeenCalledWith('SetCleanSpeed', 1)
    expect(control.run).toHaveBeenCalledWith('SetCleanSpeed', 4)
  })

  it('keeps the two levels it always had on an older robot', async () => {
    const { vacuum, control, updateAccessoryState } = makeVacuum(false)
    await vacuum.markRegistered()

    control.emit('CleanSpeed', 4)
    await settle()

    expect(cleanModes(vacuum).map(mode => mode.label)).toEqual(['Vacuum', 'Max Clean'])
    expect(sent(updateAccessoryState, 'rvcCleanMode', 'currentMode')).toEqual([3])
  })
})
