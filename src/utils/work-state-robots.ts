import { Buffer } from 'node:buffer'
import zlib from 'node:zlib'

/**
 * Newer robots that the bundled ecovacs-deebot library does not list yet (seen
 * on a DEEBOT T90 MAX PRO OMNI, class u7ytef, firmware 1.78.6) speak a newer
 * set of commands than the library sends them:
 *
 * - they refuse getCleanInfo, getCleanInfo_V2, getMapSubSet and the old clean
 *   command with code 20003 'rcp not support'
 * - they report what they are doing in reply to getWorkState instead
 * - they list their rooms, with names, in one getMapSet_V2 reply, as a
 *   base64-encoded, zstd-compressed JSON array
 * - they pause, resume and stop with clean_V2, and clean rooms with the
 *   'freeClean' type (the 'spotArea' type is refused with 'unknown type')
 *
 * Such a robot is recognised by answering getWorkState, which is asked once
 * when an unlisted robot connects. These helpers turn its replies into what
 * the Matter accessory already works with.
 */

/** 'rcp not support' - the robot does not know the command */
export const UNSUPPORTED_COMMAND = 20003

/**
 * The room list in the form the freeClean clean type wants: '1,4;1,5;' for
 * rooms 4 and 5, each cleaned once (the format the ecovacs-deebot library
 * uses for the X2 series)
 */
export function freeCleanValue(areaCommand: string): string {
  return areaCommand
    .split(',')
    .map(id => id.trim())
    .filter(id => id !== '')
    .map(id => `1,${id};`)
    .join('')
}

/**
 * The rooms from a getMapSet_V2 reply - one entry per room, starting
 * [id, name, ...]. Returns undefined for a reply that is not a room list.
 */
export function decodeMapSetV2Rooms(data: any): { mapId: number, rooms: { id: number, name: string }[] } | undefined {
  if (data?.type !== 'ar' || data?.mid === undefined) {
    return undefined
  }
  const mapId = Number(data.mid)
  let subsets: any = data.subsets
  if (typeof subsets === 'string') {
    const zstdDecompressSync = (zlib as any).zstdDecompressSync
    if (typeof zstdDecompressSync !== 'function') {
      throw new TypeError('this Node.js version cannot decompress the room list (zstd needs Node.js 22.15 or newer)')
    }
    subsets = JSON.parse(zstdDecompressSync(Buffer.from(subsets, 'base64')).toString('utf8'))
  }
  if (!Array.isArray(subsets) || Number.isNaN(mapId)) {
    return undefined
  }
  const rooms: { id: number, name: string }[] = []
  for (const subset of subsets) {
    const id = Number(subset?.[0])
    if (Number.isNaN(id)) {
      continue
    }
    rooms.push({ id, name: String(subset?.[1] ?? '').trim() || `Area ${id}` })
  }
  return { mapId, rooms }
}

// Station states during which a run is held, but still under way
const STATION_BUSY = [
  'washing',
  'spindrying',
  'addwater',
  'emptying',
]

const headingHome = (value: string) => value.includes('return') || value.includes('gocharg') || value.includes('goback')

/**
 * A getWorkState reply as the clean report the accessory already understands.
 * Example reply:
 * {"paused":0,"robotState":{"cleanState":{"type":"freeClean"},"state":"cleaning"},"stationState":{"state":"idle"}}
 */
export function workStateCleanReport(data: any): 'returning' | 'pause' | 'clean' | 'idle' {
  const state = String(data?.robotState?.state ?? '').toLowerCase()
  const station = String(data?.stationState?.state ?? '').toLowerCase()
  // Heading home shows up as the station's state, and wins, as a run that is
  // being ended can still read 'cleaning'
  if (headingHome(station) || headingHome(state)) {
    return 'returning'
  }
  if (state.includes('clean')) {
    // A run held while the station washes the mop reads paused, but is under way
    if (Number(data?.paused) === 1 && !STATION_BUSY.some(value => station.includes(value))) {
      return 'pause'
    }
    return 'clean'
  }
  return 'idle'
}

/** The parts of an ecovacs-deebot `tools` module used to look a model up */
export interface ModelList {
  isKnownDevice: (deviceClass: string) => boolean
  getDeviceProperty: (deviceClass: string, property: string, defaultValue?: unknown) => unknown
}

/**
 * Whether a robot the stable library does not list should be switched to the
 * V2 commands (and asked whether it answers getWorkState). Only robots on the
 * JSON/MQTT protocol qualify, and not those the newer alpha library lists as
 * V1 - such as the yeedi cube (6r6dbt) and the Yeedi Floor 3 Station (t6kipw,
 * u3bsxq), which take the old commands today and keep them
 */
export function treatAsUnlistedV2(loadedDevice: any, alphaModels?: ModelList): boolean {
  if (loadedDevice?.isKnownDevice?.() !== false || !loadedDevice.is950type?.()) {
    return false
  }
  const deviceClass = String(loadedDevice.deviceClass ?? '')
  if (alphaModels?.isKnownDevice(deviceClass) && alphaModels.getDeviceProperty(deviceClass, 'V2', false) !== true) {
    return false
  }
  return true
}

/** Lower than the plugin's 30-second minimum is not allowed */
const WORK_STATE_POLL_INTERVAL = 30

/**
 * How often to ask a robot that reports through getWorkState for its state,
 * in seconds. These robots push no state events, so a run would otherwise only
 * show up in Home at the next regular refresh. An explicit 0 (no polling) is
 * left alone, as is a setting that is already shorter
 *
 * @param pollInterval the interval in use, from matterPollInterval()
 */
export function workStatePollInterval(pollInterval: number): number {
  if (pollInterval <= 0) {
    return 0
  }
  return Math.min(pollInterval, WORK_STATE_POLL_INTERVAL)
}

/** What to do with the replies the library cannot handle */
export interface WorkStateReplyHandlers {
  onWorkState: (data: any) => void
  onWorkStateRefused: () => void
  onMapSetV2: (data: any) => void
  onRefused: (command: string) => void
}

/**
 * Hand the getWorkState and getMapSet_V2 replies of an unlisted robot to the
 * accessory instead of the library. The library has no handling for them, and
 * would read a getMapSet_V2 reply as an old getMapSet one - asking for every
 * room with getMapSubSet, which these robots refuse. A command the robot does
 * not know ('rcp not support') is reported once and dropped, so it does not
 * show the robot as faulty. Everything else goes on to the library.
 *
 * @param ecovacs the library's protocol object (`loadedDevice.ecovacs`)
 * @returns whether the replies could be routed
 */
export function routeWorkStateReplies(ecovacs: any, handlers: WorkStateReplyHandlers): boolean {
  if (!ecovacs || typeof ecovacs.handleMessage !== 'function') {
    return false
  }
  const refused = new Set<string>()
  const handleMessage = ecovacs.handleMessage.bind(ecovacs)
  ecovacs.handleMessage = (topic: string, message: any, type = 'incoming') => {
    if (type === 'response') {
      const name = String(topic)
      let parsed: any
      try {
        parsed = typeof message === 'string'
          ? JSON.parse(message)
          : message
      } catch {
        return handleMessage(topic, message, type)
      }
      const code = parsed?.body?.code
      if (code === UNSUPPORTED_COMMAND) {
        if (name === 'getWorkState') {
          handlers.onWorkStateRefused()
        }
        if (!refused.has(name)) {
          refused.add(name)
          handlers.onRefused(name)
        }
        return
      }
      if (code === 0 && name === 'getWorkState') {
        handlers.onWorkState(parsed.body.data)
        return
      }
      if (code === 0 && name === 'getMapSet_V2') {
        handlers.onMapSetV2(parsed.body.data)
        return
      }
    }
    return handleMessage(topic, message, type)
  }
  return true
}

/** Whether this Node.js can unpack a getMapSet_V2 room list (zstd, Node.js 22.15+) */
export function canReadRoomList(): boolean {
  return typeof (zlib as any).zstdDecompressSync === 'function'
}
