import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import { EcovacsRoboticVacuumAccessory } from './EcovacsRoboticVacuumAccessory.js'

// Enough of the Homebridge API for the vacuum to build itself and push state
function makeVacuum(isV2 = true, saved: Record<string, Record<string, unknown>> = {}, extra: Record<string, unknown> = {}) {
  // Matter keeps cluster state, and saves it over a restart
  const state: Record<string, Record<string, unknown>> = structuredClone(saved)
  const updateAccessoryState = vi.fn(async (_uuid: string, cluster: string, attributes: Record<string, unknown>) => {
    // Matter's own rule: no room without a map once maps are listed
    const maps = (attributes.supportedMaps ?? state[cluster]?.supportedMaps ?? []) as unknown[]
    const areas = (attributes.supportedAreas ?? []) as { mapId: number | null }[]
    if (cluster === 'serviceArea' && maps.length > 0 && areas.some(area => area.mapId === null)) {
      throw new Error('Areas must not have a null mapId when supportedMaps is defined')
    }
    state[cluster] = {
      ...state[cluster],
      ...attributes,
    }
  })
  const getAccessoryState = vi.fn(async (_uuid: string, cluster: string) => state[cluster])
  const api = {
    matter: {
      uuid: {
        generate: (id: string) => `uuid-${id}`,
      },
      deviceTypes: { RoboticVacuumCleaner: {} },
      updateAccessoryState,
      getAccessoryState,
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
    ...extra,
  } as any)
  const control = Object.assign(new EventEmitter(), {
    run: vi.fn(),
  })
  vacuum.connectControl(control)
  return {
    vacuum,
    control,
    log,
    updateAccessoryState,
    state,
  }
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

  it('gives every level a tag besides Vacuum, as Home leaves out a level without one', () => {
    const { vacuum } = makeVacuum()

    // Home showed Quiet, Max and Max+ but not Standard, the one level that
    // carried only the Vacuum tag
    expect(cleanModes(vacuum).every(mode => mode.modeTags.some(tag => tag.value !== 16385))).toBe(true)
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

// Two floors: map 1 (the robot is on it) and map 2, one room each
function twoFloors(control: EventEmitter & { is_ready?: boolean }) {
  control.is_ready = true
  control.emit('Maps', {
    maps: [
      { mapID: '1', mapName: 'Ground', mapIsCurrentMap: true },
      { mapID: '2', mapName: 'Upstairs', mapIsCurrentMap: false },
    ],
  })
  control.emit('MapSpotAreaInfo', { mapID: '1', mapSpotAreaID: '3', mapSpotAreaName: 'Kitchen' })
  control.emit('MapSpotAreaInfo', { mapID: '2', mapSpotAreaID: '3', mapSpotAreaName: 'Bedroom' })
}

// Pick rooms the way Home does: the plugin's handler runs, then Matter saves
// the selection
async function select(vacuum: any, state: Record<string, Record<string, unknown>>, newAreas: number[]) {
  await vacuum.handlers.serviceArea.selectAreas({ newAreas })
  state.serviceArea = { ...state.serviceArea, selectedAreas: newAreas }
}

// Start a run the way Home does, answering the robot's map check at once
async function startRun(vacuum: any, control: EventEmitter, currentMap = '1') {
  const run = vacuum.handlers.rvcRunMode.changeToMode({ newMode: 1 })
  await settle()
  control.emit('CurrentMapMID', currentMap)
  return run
}

describe('ecovacsRoboticVacuumAccessory room cleaning (#328)', () => {
  it('refuses a start when every picked room is on another floor', async () => {
    const { vacuum, control, state } = makeVacuum()
    twoFloors(control)
    await settle()
    await select(vacuum, state, [1003])

    await expect(startRun(vacuum, control)).rejects.toThrow('None of the selected areas')
    expect(control.run).not.toHaveBeenCalledWith('SpotArea_V2', expect.anything())
    expect(control.run).not.toHaveBeenCalledWith('Clean_V2')
  })

  it('cleans a picked room on the floor the robot is on', async () => {
    const { vacuum, control, state } = makeVacuum()
    twoFloors(control)
    await settle()
    await select(vacuum, state, [3])

    await startRun(vacuum, control)
    expect(control.run).toHaveBeenCalledWith('SpotArea_V2', '3')
  })

  it('still cleans the picked rooms after a restart', async () => {
    // Matter brought the selection back from storage; the plugin starts empty
    const { vacuum, control } = makeVacuum(true, {
      serviceArea: {
        selectedAreas: [3],
      },
    })
    twoFloors(control)
    await settle()

    await startRun(vacuum, control)
    expect(control.run).toHaveBeenCalledWith('SpotArea_V2', '3')
    expect(control.run).not.toHaveBeenCalledWith('Clean_V2')
  })

  it('leaves the selection to Matter, so a rejected pick changes nothing', async () => {
    const { vacuum, control, updateAccessoryState } = makeVacuum()
    await vacuum.markRegistered()
    twoFloors(control)
    await settle()
    updateAccessoryState.mockClear()

    await vacuum.handlers.serviceArea.selectAreas({
      newAreas: [3, 99],
    })
    await vacuum.handlers.serviceArea.skipArea({ skippedArea: 3 })
    expect(updateAccessoryState).not.toHaveBeenCalled()
  })
})

// The room list Matter was last sent: area ID → room name
async function roomList(state: Record<string, Record<string, unknown>>) {
  await settle()
  await settle()
  const areas = (state.serviceArea?.supportedAreas ?? []) as any[]
  return Object.fromEntries(areas.map(area => [area.areaId, area.areaInfo.locationInfo.locationName]))
}

describe('ecovacsRoboticVacuumAccessory room ids across map changes (#328)', () => {
  it('keeps each floor\'s room ids when a new map sorts before them', async () => {
    // Before the restart: map 2 had the plain ids, map 5 the 1000 block
    const { vacuum, control, state } = makeVacuum(true, {
      serviceArea: {
        supportedMaps: [
          { mapId: 2, name: 'Ground' },
          { mapId: 5, name: 'Upstairs' },
        ],
        supportedAreas: [
          {
            areaId: 3,
            mapId: 2,
            areaInfo: {
              locationInfo: { locationName: 'Kitchen' },
            },
          },
          {
            areaId: 1003,
            mapId: 5,
            areaInfo: {
              locationInfo: { locationName: 'Bedroom' },
            },
          },
        ],
      },
    })
    await vacuum.markRegistered()

    // Now a basement map with a lower id has been added
    control.emit('Maps', {
      maps: [
        { mapID: '1', mapName: 'Basement' },
        { mapID: '2', mapName: 'Ground' },
        { mapID: '5', mapName: 'Upstairs' },
      ],
    })
    control.emit('MapSpotAreaInfo', { mapID: '1', mapSpotAreaID: '3', mapSpotAreaName: 'Gym' })
    control.emit('MapSpotAreaInfo', { mapID: '2', mapSpotAreaID: '3', mapSpotAreaName: 'Kitchen' })
    control.emit('MapSpotAreaInfo', { mapID: '5', mapSpotAreaID: '3', mapSpotAreaName: 'Bedroom' })

    expect(await roomList(state)).toEqual({ 3: 'Kitchen', 1003: 'Bedroom', 2003: 'Gym' })
  })

  it('drops the rooms of a deleted map', async () => {
    const { vacuum, control, state } = makeVacuum()
    await vacuum.markRegistered()
    twoFloors(control)
    expect(await roomList(state)).toEqual({ 3: 'Kitchen', 1003: 'Bedroom' })

    control.emit('Maps', {
      maps: [
        { mapID: '1', mapName: 'Ground', mapIsCurrentMap: true },
      ],
    })
    expect(await roomList(state)).toEqual({ 3: 'Kitchen' })
    expect(state.serviceArea.supportedMaps).toEqual([
      { mapId: 1, name: 'Ground' },
    ])
  })

  it('lists a new map before it has any rooms', async () => {
    const { vacuum, control, state } = makeVacuum()
    await vacuum.markRegistered()
    control.emit('Maps', {
      maps: [
        { mapID: '1', mapName: 'Ground', mapIsCurrentMap: true },
      ],
    })
    await settle()
    await settle()
    expect(state.serviceArea?.supportedMaps).toEqual([
      { mapId: 1, name: 'Ground' },
    ])
  })

  it('drops a deleted room', async () => {
    const { vacuum, control, state } = makeVacuum()
    await vacuum.markRegistered()
    twoFloors(control)
    control.emit('MapSpotAreaInfo', { mapID: '1', mapSpotAreaID: '4', mapSpotAreaName: 'Hall' })
    expect(await roomList(state)).toEqual({ 3: 'Kitchen', 4: 'Hall', 1003: 'Bedroom' })

    control.emit('MapSpotAreas', {
      mapID: '1',
      mapSpotAreas: [
        { mapSpotAreaID: '3' },
      ],
    })
    expect(await roomList(state)).toEqual({ 3: 'Kitchen', 1003: 'Bedroom' })
  })
})

describe('ecovacsRoboticVacuumAccessory room list checks (#328)', () => {
  it('leaves out a room whose map is not known, so the list is not refused', async () => {
    const { vacuum, control, state, log } = makeVacuum()
    await vacuum.markRegistered()
    twoFloors(control)
    control.emit('MapSpotAreaInfo', { mapID: '9', mapSpotAreaID: '1', mapSpotAreaName: 'Shed' })

    expect(await roomList(state)).toEqual({ 3: 'Kitchen', 1003: 'Bedroom' })
    expect(log.error).not.toHaveBeenCalled()
  })

  it('sends the room list again after a failed update', async () => {
    const { vacuum, control, state, updateAccessoryState, log } = makeVacuum()
    await vacuum.markRegistered()
    // Matter refuses the first room list only
    const accept = updateAccessoryState.getMockImplementation()!
    let refuse = true
    updateAccessoryState.mockImplementation(async (uuid, cluster, attributes) => {
      if (cluster === 'serviceArea' && 'supportedMaps' in attributes && refuse) {
        refuse = false
        throw new Error('busy')
      }
      return accept(uuid, cluster, attributes)
    })
    control.emit('Maps', {
      maps: [
        { mapID: '1', mapName: 'Ground', mapIsCurrentMap: true },
      ],
    })
    await settle()
    await settle()
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('busy'))
    expect(state.serviceArea?.supportedMaps).toBeUndefined()

    // The robot reports the same map again: nothing new, but the list was never taken
    control.emit('Maps', {
      maps: [
        { mapID: '1', mapName: 'Ground', mapIsCurrentMap: true },
      ],
    })
    await settle()
    await settle()
    expect(state.serviceArea?.supportedMaps).toEqual([
      { mapId: 1, name: 'Ground' },
    ])
  })
})

describe('ecovacsRoboticVacuumAccessory unanswered status queries', () => {
  it('does not show a cleaning robot as faulty when a status query times out', async () => {
    const { vacuum, control, state } = makeVacuum()
    await vacuum.markRegistered()
    control.emit('CleanReport', 'auto')
    await settle()
    expect(state.rvcOperationalState?.operationalState).toBe(1) // Running
    control.emit('Error', 'Request Timeout (command \'getBattery\')')
    await settle()
    expect(state.rvcOperationalState?.operationalState).toBe(1) // still Running
  })

  it('still shows a real error', async () => {
    const { vacuum, control, state } = makeVacuum()
    await vacuum.markRegistered()
    control.emit('Error', 'RollAbnormal: Main Brush is tangled')
    await settle()
    expect(state.rvcOperationalState?.operationalState).toBe(3) // Error
  })
})

describe('ecovacsRoboticVacuumAccessory robots that report through getWorkState', () => {
  class Generic {
    constructor(public name: string, public args: any) {}
  }

  // An unlisted robot that has answered the getWorkState probe
  async function makeWorkStateVacuum() {
    const made = makeVacuum(true, {}, { probeWorkState: true })
    Object.assign(made.control, {
      sendCommand: vi.fn(),
      vacBotCommand: { Generic },
      is_ready: true,
    })
    await made.vacuum.markRegistered()
    made.control.emit('ready', true)
    made.control.emit('Maps', {
      maps: [
        { mapID: '209769737', mapName: 'EG', mapIsCurrentMap: true },
      ],
    })
    made.vacuum.applyWorkState({
      paused: 0,
      robotState: { state: 'idle' },
      stationState: { state: 'idle' },
    })
    await settle()
    return made
  }
  const sent = (control: any) => control.sendCommand.mock.calls.map(([cmd]: [Generic]) => cmd)

  it('waits for the probe, then reads the rooms with getMapSet_V2 instead of getMapSubSet', async () => {
    const { vacuum, control, state } = await makeWorkStateVacuum()
    expect(vacuum.usesWorkState).toBe(true)
    expect(sent(control).map((cmd: Generic) => cmd.name)).toEqual(['getWorkState', 'getMapSet_V2'])
    expect(control.run).not.toHaveBeenCalledWith('GetSpotAreas', expect.anything())
    vacuum.applyMapSetV2({
      mid: '209769737',
      type: 'ar',
      subsets: [
        ['0', 'Bad'],
        ['4', 'Küche'],
      ],
    })
    // An old-style spot area event from the library must not drop them
    control.emit('MapSpotAreas', {
      mapID: '209769737',
      mapSpotAreas: [
        { mapSpotAreaID: undefined },
      ],
    })
    await settle()
    expect(state.serviceArea?.supportedAreas).toHaveLength(2)
  })

  it('carries on the usual way when the robot refuses getWorkState', async () => {
    const { vacuum, control } = makeVacuum(true, {}, { probeWorkState: true })
    Object.assign(control, {
      sendCommand: vi.fn(),
      vacBotCommand: { Generic },
      is_ready: true,
    })
    control.emit('ready', true)
    control.emit('Maps', {
      maps: [
        { mapID: '1', mapName: 'EG', mapIsCurrentMap: true },
      ],
    })
    expect(control.run).not.toHaveBeenCalledWith('GetSpotAreas', '1')
    vacuum.workStateUnsupported()
    expect(vacuum.usesWorkState).toBe(false)
    expect(control.run).toHaveBeenCalledWith('GetSpotAreas', '1')
    expect(control.run).toHaveBeenCalledWith('GetCleanState_V2')
  })

  it('shows the state the robot reports', async () => {
    const { vacuum, state } = await makeWorkStateVacuum()
    vacuum.applyWorkState({
      paused: 0,
      robotState: {
        cleanState: { type: 'auto' },
        state: 'cleaning',
      },
      stationState: { state: 'idle' },
    })
    await settle()
    expect(state.rvcOperationalState?.operationalState).toBe(1) // Running
    vacuum.applyWorkState({
      paused: 1,
      robotState: {
        cleanState: { type: 'auto' },
        state: 'cleaning',
      },
      stationState: { state: 'idle' },
    })
    await settle()
    expect(state.rvcOperationalState?.operationalState).toBe(2) // Paused
    vacuum.applyWorkState({
      paused: 0,
      robotState: { state: 'idle' },
      stationState: { state: 'goCharging' },
    })
    await settle()
    expect(state.rvcOperationalState?.operationalState).toBe(64) // SeekingCharger
  })

  it('pauses and resumes with clean_V2', async () => {
    const { vacuum, control } = await makeWorkStateVacuum()
    await (vacuum as any).handlePause()
    await (vacuum as any).handleResume()
    expect(sent(control).slice(-2).map((cmd: Generic) => `${cmd.name}:${cmd.args.act}`)).toEqual(['clean_V2:pause', 'clean_V2:resume'])
    expect(control.run).not.toHaveBeenCalledWith('Pause')
  })

  it('ends the run before sending the robot home, so the next start is not blocked', async () => {
    const { vacuum, control } = await makeWorkStateVacuum()
    vi.useFakeTimers()
    try {
      const done = (vacuum as any).handleGoHome()
      await vi.advanceTimersByTimeAsync(2000)
      await done
    } finally {
      vi.useRealTimers()
    }
    expect(sent(control).at(-1)).toMatchObject({
      name: 'clean_V2',
      args: { act: 'stop' },
    })
    expect(control.run).toHaveBeenCalledWith('Charge')
  })

  it('cleans a room with the freeClean type', async () => {
    const { vacuum, control, state } = await makeWorkStateVacuum()
    vacuum.applyMapSetV2({
      mid: '209769737',
      type: 'ar',
      subsets: [
        ['4', 'Küche'],
      ],
    })
    await settle()
    await select(vacuum, state, [4])
    await startRun(vacuum, control, '209769737')
    expect(sent(control).at(-1)).toMatchObject({
      name: 'clean_V2',
      args: {
        act: 'start',
        content: { type: 'freeClean', value: '1,4;', count: 1 },
      },
    })
    expect(control.run).not.toHaveBeenCalledWith('SpotArea_V2', expect.anything())
  })

  it('does not show the robot as faulty for an unanswered status query or a codeless error', async () => {
    const { vacuum, control, state } = await makeWorkStateVacuum()
    vacuum.applyWorkState({
      paused: 0,
      robotState: { state: 'cleaning' },
      stationState: { state: 'idle' },
    })
    await settle()
    control.emit('Error', 'Request Timeout (command \'getBattery\')')
    control.emit('Error', 'unknown errorCode: ')
    control.emit('Error', 'Unhandled error. (undefined)')
    await settle()
    expect(state.rvcOperationalState?.operationalState).toBe(1) // still Running
  })
})
