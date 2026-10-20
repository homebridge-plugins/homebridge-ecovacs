/**
 * Ecovacs Robotic Vacuum Cleaner - Matter Accessory
 *
 * Bridges the Ecovacs/Yeedi vacbot device to the Matter RoboticVacuumCleaner
 * device type (Matter Spec § 12.1), enabling native Matter commissioning via
 * Apple Home and other Matter ecosystems.
 *
 * Cluster mapping:
 *   rvcRunMode ← CleanReport events (Idle / Cleaning / Mapping)
 *   rvcOperationalState ← ChargeState events (Stopped / Running / Paused /
 *                         SeekingCharger / Charging / Docked)
 *   rvcCleanMode ← CleanSpeed events (Vacuum / Max Clean)
 *   serviceArea ← configured spot-area IDs in plugin config
 *
 * Handler mapping (Matter → Ecovacs commands):
 *   rvcRunMode.changeToMode (1=Cleaning) → run('Clean' | 'Clean_V2')
 *   rvcRunMode.changeToMode (0=Idle) → run('Charge')
 *   rvcOperationalState.pause → run('Pause')
 *   rvcOperationalState.resume → run('Clean' | 'Clean_V2')
 *   rvcOperationalState.goHome → run('Charge')
 */

import type { API, Logger, MatterRequests } from 'homebridge'

import platformLang from '../utils/lang-en.js'
import { BaseMatterAccessory } from './BaseMatterAccessory.js'

/** Ecovacs clean-state values that indicate the vacuum is actively cleaning. */
const CLEANING_STATES = new Set([
  'auto',
  'clean',
  'edge',
  'spot',
  'spotarea',
  'customarea',
  'spotarea_v2',
  'customarea_v2',
  'mapping',
])

export interface EcovacsDeviceInfo {
  /** Unique device ID (used for UUID generation and serial number). */
  did: string
  /** Device display name / nickname. */
  nick: string
  /** Device manufacturer string. */
  company: string
  /** Device model string. */
  model: string
  /** Optional firmware version string. */
  fwVersion?: string
  /** Whether the device uses V2 commands (950-type). */
  isV2?: boolean
}

/**
 * Matter accessory for an Ecovacs robotic vacuum cleaner.
 *
 * Create one instance per physical device and call {@link connectControl}
 * once the vacbot `control` object is ready (after `control.connect()`).
 */
export class EcovacsRoboticVacuumAccessory extends BaseMatterAccessory {
  private control: any = null

  private readonly isV2?: boolean

  /** Tracked so we can guard handler state checks. */
  private currentOperationalState = 66 // start docked

  // The last ChargeState and battery level seen, which together decide the
  // battery's charge state - the part of the battery the Home app reads to
  // show it charging. Nothing set it before, so it stayed Unknown for good
  private lastChargeState?: 'returning' | 'charging' | 'idle'
  private lastBatteryPercent?: number

  /** Accumulated map data: mapId → mapName */
  private readonly mapsById = new Map<number, string>()
  /** Accumulated area data: areaId → { mapId, name } */
  private readonly areasById = new Map<number, { mapId: number, name: string }>()
  /** One-time note flag for the optional canvas module being unbuilt */
  private canvasNoteShown = false

  // The last device error reported, so a robot that is simply switched off does
  // not warn on every command the plugin sends. The HAP path already does this
  private lastReportedError = ''

  constructor(api: API, log: Logger, device: EcovacsDeviceInfo) {
    const serialNumber = device.did
    const isV2 = device.isV2 ?? false
    const manufacturer = device.company || 'Ecovacs'
    const rawModel = device.model || 'Deebot'

    if (!api.matter) {
      return
    }

    // Matter spec: productLabel (defaults to productName/model) must not include vendorName
    const escapedMfr = manufacturer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const model = rawModel.replace(new RegExp(escapedMfr, 'i'), '').trim() || rawModel

    // Matter caps serial numbers at 32 characters and UUID-style DIDs are 36,
    // so drop the dashes (leaving exactly 32 hex characters) rather than let
    // the core truncate with a warning on every load. The accessory UUID
    // still derives from the full DID so existing pairings are unaffected.
    const matterSerial = serialNumber.replace(/-/g, '').substring(0, 32)

    super(api, log, {
      UUID: api.matter.uuid.generate(`ecovacs-${serialNumber}`),
      displayName: device.nick || device.did,
      deviceType: api.matter.deviceTypes.RoboticVacuumCleaner,
      serialNumber: matterSerial,
      manufacturer,
      model,
      firmwareRevision: device.fwVersion || '1.0.0',
      hardwareRevision: '1.0.0',
      context: { ecoDeviceId: device.did },

      clusters: {
        // ── Run Mode ──────────────────────────────────────────────────
        rvcRunMode: {
          supportedModes: [
            { label: 'Idle', mode: 0, modeTags: [{ value: 16384 }] },
            { label: 'Cleaning', mode: 1, modeTags: [{ value: 16385 }] },
            { label: 'Mapping', mode: 2, modeTags: [{ value: 16386 }] },
          ],
          currentMode: 0,
        },

        // ── Clean Mode ────────────────────────────────────────────────
        // Only Vacuum (standard) and Max Clean (high power) are currently
        // driven by Ecovacs CleanSpeed events. The device does not yet report
        // Mop / Vacuum & Mop modes, so omitted to avoid a stale state.
        rvcCleanMode: {
          supportedModes: [
            { label: 'Vacuum', mode: 0, modeTags: [{ value: 16385 }] },
            { label: 'Max Clean', mode: 3, modeTags: [{ value: 7 }, { value: 16385 }] },
          ],
          currentMode: 0,
        },

        // ── Operational State ─────────────────────────────────────────
        rvcOperationalState: {
          operationalStateList: [
            { operationalStateId: 0 }, // Stopped
            { operationalStateId: 1 }, // Running
            { operationalStateId: 2 }, // Paused
            { operationalStateId: 3 }, // Error
            { operationalStateId: 64 }, // SeekingCharger
            { operationalStateId: 65 }, // Charging
            { operationalStateId: 66 }, // Docked
          ],
          operationalState: 66, // start docked
        },

        // ── Power Source (battery) ────────────────────────────────────
        powerSource: {
          status: 0, // unknown until first BatteryInfo event
          order: 0,
          description: 'Battery',
          batPercentRemaining: 0, // half-percent units (0-200)
          batChargeLevel: 0, // 0 = OK, 1 = Warning, 2 = Critical
        },

        // ── Service Area (populated from device config if available) ──
        serviceArea: {
          supportedMaps: [],
          supportedAreas: [],
          selectedAreas: [],
        },
      },

      handlers: {
        rvcRunMode: {
          changeToMode: async (request: MatterRequests.ChangeToMode) =>
            this.handleChangeRunMode(request),
        },
        rvcCleanMode: {
          changeToMode: async (request: MatterRequests.ChangeToMode) =>
            this.handleChangeCleanMode(request),
        },
        rvcOperationalState: {
          pause: async () => this.handlePause(),
          resume: async () => this.handleResume(),
          goHome: async () => this.handleGoHome(),
        },
        serviceArea: {
          selectAreas: async (request: MatterRequests.SelectAreas) =>
            this.handleSelectAreas(request),
          skipArea: async (request: MatterRequests.SkipArea) =>
            this.handleSkipArea(request),
        },
      },
    })

    this.isV2 = isV2
    this.logInfo('Matter accessory initialized (waiting for device connection).')
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Device connection
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Attach to the live vacbot control object and start listening for events.
   * Call this after `loadedDevice.connect()` in the platform's initialiseDevice.
   */
  public connectControl(control: any): void {
    this.control = control

    // ── Device ready: fetch initial state ────────────────────────────
    control.on('ready', (event: boolean) => {
      if (!event) {
        return
      }
      this.logDebug('Device ready — requesting initial state.')
      control.run('GetBatteryState')
      control.run('GetChargeState')
      control.run(this.isV2 ? 'GetCleanState_V2' : 'GetCleanState')
      control.run('GetCleanSpeed')
      control.run('GetMaps')
    })

    control.on('CleanReport', (newVal: string) => void this.onCleanReport(newVal))
    control.on('ChargeState', (newVal: string) => void this.onChargeState(newVal))
    control.on('BatteryInfo', (newVal: number) => void this.onBatteryInfo(newVal))
    control.on('CleanSpeed', (newVal: number) => void this.onCleanSpeed(newVal))

    // ── Error / offline detection ──────────────────────────────────
    control.on('Error', (err: string) => {
      if (err === 'NoError: Robot is operational') {
        return
      }
      // The optional canvas module only draws map images, which HomeKit
      // never sees - it is commonly unbuilt on user systems (npm 12 blocks
      // its build script), so note it once quietly rather than warn per
      // map event
      if (String(err).includes('canvas.node')) {
        if (!this.canvasNoteShown) {
          this.canvasNoteShown = true
          this.logDebug(platformLang.canvasMissing)
        }
        return
      }
      if (this.lastReportedError !== String(err)) {
        this.lastReportedError = String(err)
        this.logWarn(`Device error: ${err}`)
        if (err === 'Recipient unavailable') {
          this.logWarn('Device appears to be offline.')
        }
      }
      void this.updateOperationalState(3) // Error
    })

    // ── Service area discovery ──────────────────────────────────────
    control.on('Maps', (data: any) => {
      if (!data?.maps) {
        return
      }
      // Register each map and request its spot areas
      Object.values(data.maps).forEach((m: any) => {
        const mapId = Number(m.mapID)
        if (Number.isNaN(mapId)) {
          this.logWarn(`Ignoring map with invalid ID: ${m.mapID}`)
          return
        }
        this.mapsById.set(mapId, m.mapName || `Map ${m.mapID}`)
        control.run('GetSpotAreas', m.mapID)
      })
    })

    control.on('MapSpotAreas', (data: any) => {
      if (!data?.mapSpotAreas) {
        return
      }
      // Request full info for each area
      Object.values(data.mapSpotAreas).forEach((area: any) => {
        control.run('GetSpotAreaInfo', data.mapID, area.mapSpotAreaID)
      })
    })

    control.on('MapSpotAreaInfo', (area: any) => {
      if (!area?.mapSpotAreaID) {
        return
      }
      const areaId = Number(area.mapSpotAreaID)
      const mapId = Number(area.mapID)
      if (Number.isNaN(areaId) || Number.isNaN(mapId)) {
        this.logWarn(`Ignoring area with invalid IDs: area=${area.mapSpotAreaID}, map=${area.mapID}`)
        return
      }
      const name = area.mapSpotAreaName || `Area ${area.mapSpotAreaID}`
      this.areasById.set(areaId, { mapId, name })
      void this.flushServiceAreas()
    })

    // Trigger map discovery after connecting
    control.run('GetMaps')

    this.logInfo('Connected to device control — Matter state updates active.')
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Event handlers: Ecovacs → Matter state
  // ──────────────────────────────────────────────────────────────────────────

  /** Maps Ecovacs CleanReport values to Matter rvcRunMode + rvcOperationalState. */
  private async onCleanReport(newVal: string): Promise<void> {
    if (!newVal) {
      this.logDebug('CleanReport received with empty value, ignoring')
      return
    }
    const normalized = newVal.toLowerCase().replace(/[^a-z0-9]+/g, '')
    if (CLEANING_STATES.has(normalized)) {
      await this.updateRunMode(1) // Cleaning
      await this.updateOperationalState(1) // Running
    } else {
      // idle / stop – operational state is driven by ChargeState going forward
      await this.updateRunMode(0) // Idle
      if (this.currentOperationalState === 1) {
        await this.updateOperationalState(0) // Stopped (only if it was running)
      }
    }
  }

  /** Maps Ecovacs ChargeState values to Matter rvcOperationalState. */
  private async onChargeState(newVal: string): Promise<void> {
    if (!newVal) {
      this.logDebug('ChargeState received with empty value, ignoring')
      return
    }
    switch (newVal.toLowerCase()) {
      case 'returning':
        await this.updateRunMode(0) // Idle
        await this.updateOperationalState(64) // SeekingCharger
        break
      case 'charging':
        await this.updateOperationalState(65) // Charging
        break
      case 'idle':
      // Docked & charged
        await this.updateOperationalState(66) // Docked
        break
      default:
        this.logDebug(`unrecognised ChargeState: ${newVal}`)
        return
    }
    this.lastChargeState = newVal.toLowerCase() as 'returning' | 'charging' | 'idle'
    await this.updateState('powerSource', { batChargeState: this.batChargeState() })
  }

  /** The battery's PowerSource.BatChargeState for the last ChargeState and level seen. */
  private batChargeState(): number {
    if (!this.lastChargeState) {
      return 0 // Unknown
    }
    if (this.lastChargeState === 'charging') {
      return 1 // IsCharging
    }
    // 'idle' also arrives while cleaning, so only a full robot that isn't
    // running counts as topped up
    if (this.lastChargeState === 'idle' && this.lastBatteryPercent === 100 && this.currentOperationalState !== 1) {
      return 2 // IsAtFullCharge
    }
    return 3 // IsNotCharging
  }

  private async onBatteryInfo(newVal: number): Promise<void> {
    if (newVal == null || newVal < 0 || newVal > 100) {
      this.logDebug(`BatteryInfo received with invalid value: ${newVal}`)
      return
    }
    // batPercentRemaining uses half-percent units (0-200)
    const batPercentRemaining = newVal * 2
    // batChargeLevel: 0 = OK, 1 = Warning, 2 = Critical
    const batChargeLevel = newVal <= 10 ? 2 : newVal <= 20 ? 1 : 0
    this.lastBatteryPercent = newVal
    await this.updateState('powerSource', {
      status: 1, // active
      batPercentRemaining,
      batChargeLevel,
      batChargeState: this.batChargeState(),
    })
  }

  /** Maps Ecovacs CleanSpeed to Matter rvcCleanMode. */
  private async onCleanSpeed(newVal: number): Promise<void> {
    // Speed 3 or 4 → Max Clean (mode 3); else → Vacuum (mode 0)
    const cleanMode = [3, 4].includes(newVal) ? 3 : 0
    await this.updateState('rvcCleanMode', { currentMode: cleanMode })
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Matter handlers: Matter → Ecovacs commands
  // ──────────────────────────────────────────────────────────────────────────

  private async handleChangeRunMode(request: MatterRequests.ChangeToMode): Promise<void> {
    this.logInfo(`rvcRunMode.changeToMode → ${request.newMode}`)
    if (!this.isDeviceReady()) {
      return
    }
    switch (request.newMode) {
      case 0: // Idle → go home
        this.control.run('Charge')
        break
      case 1: // Cleaning → start auto clean
        this.control.run(this.isV2 ? 'Clean_V2' : 'Clean')
        break
      case 2: // Mapping (not all devices support this – send auto clean as fallback)
        this.control.run(this.isV2 ? 'Clean_V2' : 'Clean')
        break
      default:
        this.logWarn(`unsupported run mode: ${request.newMode}`)
    }
  }

  private async handleChangeCleanMode(request: MatterRequests.ChangeToMode): Promise<void> {
    this.logInfo(`rvcCleanMode.changeToMode → ${request.newMode}`)
    if (!this.isDeviceReady()) {
      return
    }
    switch (request.newMode) {
      case 0: // Vacuum (standard) → speed 2
        this.control.run('SetCleanSpeed', 2)
        break
      case 3: // Max Clean → speed 3
        this.control.run('SetCleanSpeed', 3)
        break
      default:
        this.logWarn(`unsupported clean mode: ${request.newMode}`)
    }
  }

  private async handlePause(): Promise<void> {
    this.logInfo('rvcOperationalState.pause')
    if (!this.isDeviceReady()) {
      return
    }
    this.control.run('Pause')
    await this.updateOperationalState(2) // Paused
  }

  private async handleResume(): Promise<void> {
    this.logInfo('rvcOperationalState.resume')
    if (!this.isDeviceReady()) {
      return
    }
    this.control.run('Resume')
    await this.updateRunMode(1) // Cleaning
    await this.updateOperationalState(1) // Running
  }

  private async handleGoHome(): Promise<void> {
    this.logInfo('rvcOperationalState.goHome')
    if (!this.isDeviceReady()) {
      return
    }
    this.control.run('Charge')
    await this.updateRunMode(0) // Idle
    await this.updateOperationalState(64) // SeekingCharger
  }

  private async handleSelectAreas(request: MatterRequests.SelectAreas): Promise<void> {
    this.logInfo(`serviceArea.selectAreas → ${JSON.stringify(request.newAreas)}`)
    if (!this.isDeviceReady()) {
      return
    }

    // Empty array means clean everywhere (no area constraint)
    if (!request.newAreas || request.newAreas.length === 0) {
      this.logDebug('No areas selected — starting full auto clean.')
      this.control.run(this.isV2 ? 'Clean_V2' : 'Clean')
      await this.updateState('serviceArea', { selectedAreas: [] })
      await this.updateRunMode(1) // Cleaning
      await this.updateOperationalState(1) // Running
      return
    }

    // Validate that all requested areas are known
    const validAreas: number[] = []
    for (const areaId of request.newAreas) {
      if (this.areasById.has(areaId)) {
        validAreas.push(areaId)
      } else {
        this.logWarn(`selectAreas: unknown area ID ${areaId}, skipping`)
      }
    }

    if (validAreas.length === 0) {
      this.logWarn('selectAreas: no valid areas to clean')
      return
    }

    // Send SpotArea command with comma-separated area IDs
    const areaCommand = validAreas.join(',')
    this.logDebug(`Sending SpotArea command: ${areaCommand}`)
    if (this.isV2) {
      this.control.run('SpotArea_V2', areaCommand)
    } else {
      this.control.run('SpotArea', 'start', areaCommand)
    }

    await this.updateState('serviceArea', { selectedAreas: validAreas })
    await this.updateRunMode(1) // Cleaning
    await this.updateOperationalState(1) // Running
  }

  private async handleSkipArea(request: MatterRequests.SkipArea): Promise<void> {
    this.logInfo(`serviceArea.skipArea → area ${request.skippedArea}`)
    if (!this.isDeviceReady()) {
      return
    }

    if (!this.areasById.has(request.skippedArea)) {
      this.logWarn(`skipArea: unknown area ID ${request.skippedArea}`)
      return
    }

    // Read the current selected areas and remove the skipped one
    const currentState = await this.readState('serviceArea')
    const currentAreas: number[] = (currentState as any)?.selectedAreas ?? []
    const remaining = currentAreas.filter(id => id !== request.skippedArea)

    this.logDebug(`Skipping area ${request.skippedArea}, remaining: [${remaining.join(', ')}]`)
    await this.updateState('serviceArea', { selectedAreas: remaining })
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Public update helpers (callable from the platform for immediate sync)
  // ──────────────────────────────────────────────────────────────────────────

  public async updateOperationalState(state: number): Promise<void> {
    this.currentOperationalState = state
    await this.updateState('rvcOperationalState', { operationalState: state })
  }

  public async updateRunMode(mode: number): Promise<void> {
    await this.updateState('rvcRunMode', { currentMode: mode })
  }

  /** Push the current map/area data into the Matter serviceArea cluster. */
  private async flushServiceAreas(): Promise<void> {
    const supportedMaps = Array.from(this.mapsById.entries(), ([mapId, name]) => ({ mapId, name }))
    const supportedAreas = Array.from(this.areasById.entries(), ([areaId, { mapId, name }]) => ({
      areaId,
      mapId: this.mapsById.size > 0 ? mapId : null,
      areaInfo: {
        locationInfo: { locationName: name },
      },
    }))
    await this.updateState('serviceArea', { supportedMaps, supportedAreas })
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────────────────────────────────

  /** Disconnect the underlying device control (called during plugin shutdown). */
  public disconnect(): void {
    if (this.control?.is_ready) {
      this.control.disconnect()
    }
  }

  private isDeviceReady(): boolean {
    if (!this.control) {
      this.logWarn('command ignored – device not yet connected')
      return false
    }
    if (!this.control.is_ready) {
      this.logWarn('command ignored – device not ready')
      return false
    }
    return true
  }
}
