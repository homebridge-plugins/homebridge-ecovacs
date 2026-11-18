import { describe, expect, it, vi } from 'vitest'

import { decodeMapSetV2Rooms, freeCleanValue, routeWorkStateReplies, treatAsUnlistedV2, workStateCleanReport, workStatePollInterval } from './work-state-robots.js'

// Real getMapSet_V2 reply of a DEEBOT T90 MAX PRO OMNI (zstd, base64)
const T90_SUBSETS = 'KLUv/WCYAAUGAFLKHySAp0kHPSOMMqLChugeYQW6RRzaUwnZ/g76L+RvQvYznWUk5PTL0o6ldUcIOu55mMg0Aw3R4s5UJpX3hA/jOAULBw1Ccl+KIbuz+0qX1B3vjhzGo2CQuCMi1j3x2j3bHSBRKF1W/e7GHZNKx/Ke7Q7vhztBgACTADFEyF2tKAEZAGAA+KewzDg2b4UpBooLdCAWBKkCKE2GcJwSOKgaRppog13sZJkijAUqwRnC9YBQQXAmpmhdXVVpkrkFDw=='

describe('decodeMapSetV2Rooms', () => {
  it('reads the rooms of a T90 MAX PRO OMNI', () => {
    const decoded = decodeMapSetV2Rooms({
      mid: '209769737',
      msid: '1307802407',
      type: 'ar',
      subsets: T90_SUBSETS,
    })
    expect(decoded?.mapId).toBe(209769737)
    expect(decoded?.rooms.map(room => room.id)).toEqual([0, 1, 2, 3, 4, 5])
    expect(decoded?.rooms.map(room => room.name)).toEqual(
      expect.arrayContaining([
        'HWR',
        'Flur EG',
        'Wohnzimmer',
        'Küche',
        'Esszimmer',
      ]),
    )
  })

  it('takes an already unpacked list too', () => {
    expect(decodeMapSetV2Rooms({
      mid: '5',
      type: 'ar',
      subsets: [
        ['0', 'Bad '],
        ['1', ''],
      ],
    })?.rooms).toEqual([
      { id: 0, name: 'Bad' },
      { id: 1, name: 'Area 1' },
    ])
  })

  it('ignores replies that are not a room list', () => {
    expect(decodeMapSetV2Rooms({ mid: '5', type: 'vw', subsets: [] })).toBeUndefined()
  })
})

describe('freeCleanValue', () => {
  it('lists each room as count,id;', () => {
    expect(freeCleanValue('4')).toBe('1,4;')
    expect(freeCleanValue('2, 4,')).toBe('1,2;1,4;')
  })
})

describe('workStateCleanReport', () => {
  // Real T90 MAX PRO OMNI replies
  it('reads a run, a pause and a mop wash', () => {
    expect(workStateCleanReport({
      paused: 0,
      robotState: {
        cleanState: { type: 'freeClean' },
        state: 'cleaning',
      },
      stationState: { state: 'idle' },
    })).toBe('clean')
    expect(workStateCleanReport({
      paused: 1,
      robotState: {
        cleanState: { type: 'auto' },
        state: 'cleaning',
      },
      stationState: { state: 'idle' },
    })).toBe('pause')
    expect(workStateCleanReport({
      paused: 1,
      robotState: {
        cleanState: { type: 'freeClean' },
        state: 'cleaning',
      },
      stationState: { state: 'washing' },
    })).toBe('clean')
  })

  it('reads heading home from the station, even while the run still reads cleaning', () => {
    expect(workStateCleanReport({
      paused: 0,
      robotState: { state: 'idle' },
      stationState: { state: 'goCharging' },
    })).toBe('returning')
    expect(workStateCleanReport({
      paused: 0,
      robotState: { state: 'cleaning' },
      stationState: { state: 'goCharging' },
    })).toBe('returning')
  })

  it('reads a robot at rest as idle', () => {
    expect(workStateCleanReport({
      paused: 0,
      robotState: { state: 'idle' },
      stationState: { state: 'emptying' },
    })).toBe('idle')
  })
})

describe('treatAsUnlistedV2', () => {
  const alphaModels = {
    isKnownDevice: (deviceClass: string) => ['t6kipw', 'twunby'].includes(deviceClass),
    getDeviceProperty: (deviceClass: string, property: string, defaultValue?: unknown) =>
      deviceClass === 'twunby' && property === 'V2'
        ? true
        : defaultValue,
  }
  const device = (deviceClass: string, known = false, is950type = true) => ({
    deviceClass,
    isKnownDevice: () => known,
    is950type: () => is950type,
  })

  it('switches an unlisted JSON/MQTT robot', () => {
    expect(treatAsUnlistedV2(device('u7ytef'), alphaModels)).toBe(true)
    expect(treatAsUnlistedV2(device('twunby'), alphaModels)).toBe(true)
    expect(treatAsUnlistedV2(device('u7ytef'))).toBe(true)
  })

  it('leaves listed, non-JSON and alpha-listed V1 robots alone', () => {
    expect(treatAsUnlistedV2(device('ls1ok3', true), alphaModels)).toBe(false)
    expect(treatAsUnlistedV2(device('u7ytef', false, false), alphaModels)).toBe(false)
    expect(treatAsUnlistedV2(device('t6kipw'), alphaModels)).toBe(false)
  })
})

describe('workStatePollInterval', () => {
  it('asks every 30 s at most, and leaves no polling alone', () => {
    expect(workStatePollInterval(120)).toBe(30)
    expect(workStatePollInterval(45)).toBe(30)
    expect(workStatePollInterval(30)).toBe(30)
    expect(workStatePollInterval(0)).toBe(0)
  })
})

describe('routeWorkStateReplies', () => {
  function route() {
    const original = vi.fn()
    const ecovacs = { handleMessage: original }
    const handlers = {
      onWorkState: vi.fn(),
      onWorkStateRefused: vi.fn(),
      onMapSetV2: vi.fn(),
      onRefused: vi.fn(),
    }
    routeWorkStateReplies(ecovacs, handlers)
    const send = (name: string, code: number, data: unknown = {}, type = 'response') =>
      ecovacs.handleMessage(name, JSON.stringify({
        body: { code, data },
      }), type)
    return { original, handlers, send }
  }

  it('hands the replies the library cannot handle to the accessory', () => {
    const { original, handlers, send } = route()
    send('getWorkState', 0, { paused: 0 })
    send('getMapSet_V2', 0, { mid: '1' })
    expect(handlers.onWorkState).toHaveBeenCalledWith({ paused: 0 })
    expect(handlers.onMapSetV2).toHaveBeenCalledWith({ mid: '1' })
    expect(original).not.toHaveBeenCalled()
  })

  it('drops commands the robot does not know, reporting each once', () => {
    const { original, handlers, send } = route()
    send('getCleanInfo_V2', 20003)
    send('getCleanInfo_V2', 20003)
    send('getWorkState', 20003)
    expect(handlers.onRefused).toHaveBeenCalledTimes(2)
    expect(handlers.onWorkStateRefused).toHaveBeenCalledTimes(1)
    expect(original).not.toHaveBeenCalled()
  })

  it('passes everything else on to the library', () => {
    const { original, send } = route()
    send('getBattery', 0, { value: 50 })
    send('onBattery', 0, {}, 'incoming')
    expect(original).toHaveBeenCalledTimes(2)
  })
})
