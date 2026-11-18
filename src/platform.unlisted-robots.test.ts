import { EventEmitter } from 'node:events'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { EcovacsPlatform } from './platform.js'

class Generic {
  constructor(public name: string, public args: any) {}
}

// A robot as the stable library hands it over
function makeDevice(deviceClass = 'u7ytef', known = false) {
  const ecovacs = {
    handleMessage: vi.fn(),
  }
  return Object.assign(new EventEmitter(), {
    deviceClass,
    deviceModel: 'DEEBOT T90 MAX PRO OMNI',
    isKnownDevice: () => known,
    is950type: () => true,
    is950type_V2: () => known,
    run: vi.fn(),
    connect: vi.fn(),
    sendCommand: vi.fn(),
    vacBotCommand: { Generic },
    ecovacs,
    is_ready: true,
  })
}

function makePlatform(device: any, pollInterval?: number) {
  const platform: any = Object.create(EcovacsPlatform.prototype)
  platform.log = Object.assign(vi.fn(), {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })
  platform.config = { countryCode: 'DE' }
  platform.deviceConf = pollInterval === undefined
    ? {}
    : {
        abc: { pollInterval },
      }
  platform.refreshIntervals = {}
  platform.matterVacuumMap = new Map()
  platform.ecovacsAPI = {
    getVacBot: () => device,
  }
  platform.api = {
    hap: {
      uuid: {
        generate: (id: string) => `uuid-${id}`,
      },
    },
    matter: {
      uuid: {
        generate: (id: string) => `uuid-${id}`,
      },
      deviceTypes: { RoboticVacuumCleaner: {} },
      updateAccessoryState: vi.fn(async () => {}),
      getAccessoryState: vi.fn(async () => undefined),
    },
  }
  platform.initialiseMatterOnlyDevice({
    did: 'abc',
    nick: 'T90',
    company: 'eco',
    deviceModel: device.deviceModel,
  })
  expect(platform.log.warn).not.toHaveBeenCalled()
  return platform
}

// The robot's reply to a command, as the library hands it on
function reply(device: any, command: string, code: number, data: unknown = {}) {
  device.ecovacs.handleMessage(command, {
    body: { code, data },
  }, 'response')
}

const sentNames = (device: any) => device.sendCommand.mock.calls.map(([cmd]: [Generic]) => cmd.name)

describe('unlisted robots', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('switches an unlisted robot to V2, but not one the alpha library lists as V1', () => {
    const t90 = makeDevice('u7ytef')
    makePlatform(t90)
    expect(t90.is950type_V2()).toBe(true)

    // Yeedi Floor 3 Station: the alpha library lists it as V1
    const yeedi = makeDevice('t6kipw')
    makePlatform(yeedi)
    expect(yeedi.is950type_V2()).toBe(false)
  })

  it('routes the getWorkState and getMapSet_V2 replies to the accessory, not the library', () => {
    const device = makeDevice()
    const original = device.ecovacs.handleMessage
    const platform = makePlatform(device)
    const vacuum = platform.matterVacuumMap.get('abc')
    const applyWorkState = vi.spyOn(vacuum, 'applyWorkState')
    const applyMapSetV2 = vi.spyOn(vacuum, 'applyMapSetV2')

    reply(device, 'getWorkState', 0, {
      robotState: { state: 'idle' },
    })
    reply(device, 'getMapSet_V2', 0, { mid: '1', type: 'ar', subsets: [] })
    reply(device, 'getCleanInfo_V2', 20003)
    expect(applyWorkState).toHaveBeenCalledTimes(1)
    expect(applyMapSetV2).toHaveBeenCalledTimes(1)
    expect(original).not.toHaveBeenCalled()

    reply(device, 'getBattery', 0, { value: 80 })
    expect(original).toHaveBeenCalledTimes(1)
  })

  it('polls every 30 s once the robot has answered getWorkState', async () => {
    vi.useFakeTimers()
    const device = makeDevice()
    makePlatform(device)
    device.emit('ready', true)
    reply(device, 'getWorkState', 0, {
      robotState: { state: 'idle' },
    })
    device.sendCommand.mockClear()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(sentNames(device)).toContain('getWorkState')
  })

  it('keeps the usual interval for an unlisted robot that refuses getWorkState', async () => {
    vi.useFakeTimers()
    const device = makeDevice()
    makePlatform(device)
    device.emit('ready', true)
    reply(device, 'getWorkState', 20003)
    device.sendCommand.mockClear()
    device.run.mockClear()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(device.run).not.toHaveBeenCalledWith('GetBatteryState')
    await vi.advanceTimersByTimeAsync(90_000)
    expect(device.run).toHaveBeenCalledWith('GetCleanState_V2')
    expect(sentNames(device)).not.toContain('getWorkState')
  })

  it('leaves polling off when pollInterval is 0', async () => {
    vi.useFakeTimers()
    const device = makeDevice()
    makePlatform(device, 0)
    device.emit('ready', true)
    reply(device, 'getWorkState', 0, {
      robotState: { state: 'idle' },
    })
    device.sendCommand.mockClear()
    device.run.mockClear()

    await vi.advanceTimersByTimeAsync(300_000)
    expect(device.run).not.toHaveBeenCalledWith('GetBatteryState')
    expect(sentNames(device)).not.toContain('getWorkState')
  })
})
