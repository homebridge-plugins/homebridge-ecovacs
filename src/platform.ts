import type {
  API,
  DynamicPlatformPlugin,
  Logging,
  MatterAccessory,
  PlatformAccessory,
} from 'homebridge'

import type { EcovacsConfig } from './config.js'

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import process from 'node:process'

import { countries, EcoVacsAPI } from 'ecovacs-deebot'
import storage from 'node-persist'

import { EcovacsRoboticVacuumAccessory } from './devices/index.js'
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js'
import platformConsts from './utils/constants.js'
import platformChars from './utils/custom-chars.js'
import { matterPollInterval, parseError, sleep } from './utils/functions.js'
import platformLang from './utils/lang-en.js'
import { quietEcovacsEventLogging } from './utils/quiet-library-logging.js'

const require = createRequire(import.meta.url)
const plugin = require('../package.json')

interface AccessoryExtraProps {
  control: any
  log: any
  logDebug: any
  logDebugWarn: any
  logWarn: any
  cacheShownMotionLowBatt: boolean
}

const devicesInHB = new Map()

export class EcovacsPlatform implements DynamicPlatformPlugin {
  [key: string]: any;
  api: API

  declare cusChar: InstanceType<typeof platformChars>

  /** Cached Matter accessories restored at startup. */
  public readonly matterAccessories: Map<string, MatterAccessory> = new Map()

  /** Matter vacuum accessory instances keyed by device DID. */
  private readonly matterVacuumMap: Map<string, EcovacsRoboticVacuumAccessory>
    = new Map()

  constructor(log: Logging, config: EcovacsConfig, api: API) {
    this.api = api
    this.log = log

    if (!log || !api) {
      return
    }

    // Begin plugin initialization
    try {
      // Stop the ecovacs-deebot library printing every MQTT payload it receives
      // to the console. Must happen before any connection is created.
      if (!quietEcovacsEventLogging()) {
        this.log.debug('Could not quieten the ecovacs-deebot event logging - the library may have changed its logger, so expect extra output in the log.')
      }

      // Configuration objects for accessories
      this.deviceConf = {}
      this.ignoredDevices = []

      // Make sure user is running Homebridge v1.6 or above
      if (!api?.versionGreaterOrEqual('1.6.0')) {
        throw new Error(platformLang.hbVersionFail)
      }

      // Check the user has configured the plugin
      if (!config) {
        throw new Error(platformLang.pluginNotConf)
      }

      // Log some environment info for debugging
      this.log(
        '%s v%s | System %s | Node %s | HB v%s | HAPNodeJS v%s...',
        platformLang.initialising,
        plugin.version,
        process.platform,
        process.version,
        api.serverVersion,
        api.hap.HAPLibraryVersion(),
      )

      // Check the user has entered the required config fields
      if (!config.username || !config.password || !config.countryCode) {
        throw new Error(platformLang.missingCreds)
      }

      // Apply the user's configuration
      this.config = { ...platformConsts.defaultConfig }
      this.applyUserConfig(config)

      // Create further variables needed by the plugin
      this.hapErr = api.hap.HapStatusError
      this.hapChar = api.hap.Characteristic
      this.hapServ = api.hap.Service

      // Set up the Homebridge events
      this.api.on('didFinishLaunching', () => this.pluginSetup())
      this.api.on('shutdown', () => this.pluginShutdown())
    } catch (err) {
      // Catch any errors during initialization
      log.warn('***** %s. *****', platformLang.disabling)
      log.warn(
        '***** %s. *****',
        parseError(err, [
          platformLang.hbVersionFail,
          platformLang.pluginNotConf,
          platformLang.missingCreds,
          platformLang.invalidCCode,
          platformLang.invalidPassword,
          platformLang.invalidUsername,
        ]),
      )
    }
  }

  applyUserConfig(config: EcovacsConfig) {
    // These shorthand functions save line space during config parsing
    const logDefault = (k: string, def: string | number) => {
      this.log.warn(
        '%s [%s] %s %s.',
        platformLang.cfgItem,
        k,
        platformLang.cfgDef,
        def,
      )
    }
    const logDuplicate = (k: string) => {
      this.log.warn(
        '%s [%s] %s.',
        platformLang.cfgItem,
        k,
        platformLang.cfgDup,
      )
    }
    const logIgnore = (k: string) => {
      this.log.warn(
        '%s [%s] %s.',
        platformLang.cfgItem,
        k,
        platformLang.cfgIgn,
      )
    }
    const logIgnoreItem = (k: string) => {
      this.log.warn(
        '%s [%s] %s.',
        platformLang.cfgItem,
        k,
        platformLang.cfgIgnItem,
      )
    }
    const logIncrease = (k: string, min: number) => {
      this.log.warn(
        '%s [%s] %s %s.',
        platformLang.cfgItem,
        k,
        platformLang.cfgLow,
        min,
      )
    }
    const logDecrease = (k: string, max: number) => {
      this.log.warn(
        '%s [%s] %s %s.',
        platformLang.cfgItem,
        k,
        platformLang.cfgHigh,
        max,
      )
    }
    const logQuotes = (k: string) => {
      this.log.warn(
        '%s [%s] %s.',
        platformLang.cfgItem,
        k,
        platformLang.cfgQts,
      )
    }
    const logRemove = (k: string) => {
      this.log.warn(
        '%s [%s] %s.',
        platformLang.cfgItem,
        k,
        platformLang.cfgRmv,
      )
    }

    // Begin applying the user's config
    Object.entries(config).forEach((entry) => {
      const [key, val] = entry
      switch (key) {
        case 'countryCode':
          if (typeof val !== 'string' || val === '') {
            throw new Error(platformLang.invalidCCode)
          }
          this.config.countryCode = val.toUpperCase().replace(/[^A-Z]+/g, '')
          if (!Object.keys(countries).includes(this.config.countryCode)) {
            throw new Error(platformLang.invalidCCode)
          }
          break
        case 'devices':
          if (Array.isArray(val) && val.length > 0) {
            val.forEach((x) => {
              if (!x.deviceId) {
                logIgnoreItem(key)
                return
              }
              const id = x.deviceId.replace(/\s+/g, '')
              if (Object.keys(this.deviceConf).includes(id)) {
                logDuplicate(`${key}.${id}`)
                return
              }
              const entries = Object.entries(x)
              if (entries.length === 1) {
                logRemove(`${key}.${id}`)
                return
              }
              this.deviceConf[id] = { ...platformConsts.defaultDevice }
              entries.forEach((subEntry) => {
                const [k, v] = subEntry
                switch (k) {
                  case 'areaNote1':
                  case 'areaNote2':
                  case 'areaNote3':
                  case 'areaNote4':
                  case 'areaNote5':
                  case 'areaNote6':
                  case 'areaNote7':
                  case 'areaNote8':
                  case 'areaNote9':
                  case 'areaNote10':
                  case 'areaNote11':
                  case 'areaNote12':
                  case 'areaNote13':
                  case 'areaNote14':
                  case 'areaNote15':
                    // Just ignore the command notes as they are intended for user information during configuration only.
                    break
                  case 'areaType1':
                  case 'areaType2':
                  case 'areaType3':
                  case 'areaType4':
                  case 'areaType5':
                  case 'areaType6':
                  case 'areaType7':
                  case 'areaType8':
                  case 'areaType9':
                  case 'areaType10':
                  case 'areaType11':
                  case 'areaType12':
                  case 'areaType13':
                  case 'areaType14':
                  case 'areaType15':
                    if (typeof v !== 'string' || v === '') {
                      logIgnore(`${key}.${id}.${k}`)
                    } else {
                      // Just take over the command type as it comes from a string enumeration.
                      this.deviceConf[id][k] = v
                    }
                    break
                  case 'customAreaCoordinates1':
                  case 'customAreaCoordinates2':
                  case 'customAreaCoordinates3':
                  case 'customAreaCoordinates4':
                  case 'customAreaCoordinates5':
                  case 'customAreaCoordinates6':
                  case 'customAreaCoordinates7':
                  case 'customAreaCoordinates8':
                  case 'customAreaCoordinates9':
                  case 'customAreaCoordinates10':
                  case 'customAreaCoordinates11':
                  case 'customAreaCoordinates12':
                  case 'customAreaCoordinates13':
                  case 'customAreaCoordinates14':
                  case 'customAreaCoordinates15': {
                    if (typeof v !== 'string' || v === '') {
                      logIgnore(`${key}.${id}.${k}`)
                    } else {
                      // Strip off everything else than signs, figures, periods and commas.
                      const stripped = v.replace(/[^-\d.,]+/g, '')
                      if (stripped) {
                        this.deviceConf[id][k] = stripped
                      } else {
                        logIgnore(`${key}.${id}.${k}`)
                      }
                    }
                    break
                  }
                  case 'deviceId':
                  case 'label':
                    break
                  case 'hideMotionSensor':
                  case 'showBattHumidity':
                  case 'showMotionLowBatt':
                  case 'supportTrueDetect':
                    if (typeof v === 'string') {
                      logQuotes(`${key}.${id}.${k}`)
                    }
                    this.deviceConf[id][k] = v === 'false'
                      ? false
                      : !!v
                    break
                  case 'ignoreDevice':
                    if (typeof v === 'string') {
                      logQuotes(`${key}.${id}.${k}`)
                    }
                    if (!!v && v !== 'false') {
                      this.ignoredDevices.push(id)
                    }
                    break
                  case 'lowBattThreshold':
                  case 'motionDuration': {
                    if (typeof v === 'string') {
                      logQuotes(`${key}.${id}.${k}`)
                    }
                    const intVal = Number.parseInt(v as string, 10)
                    if (Number.isNaN(intVal)) {
                      logDefault(
                        `${key}.${id}.${k}`,
                        platformConsts.defaultValues[k],
                      )
                      this.deviceConf[id][k] = platformConsts.defaultValues[k]
                    } else if (intVal < platformConsts.minValues[k]) {
                      logIncrease(
                        `${key}.${id}.${k}`,
                        platformConsts.minValues[k],
                      )
                      this.deviceConf[id][k] = platformConsts.minValues[k]
                    } else if (platformConsts.maxValues[k] !== undefined && intVal > platformConsts.maxValues[k]) {
                      logDecrease(
                        `${key}.${id}.${k}`,
                        platformConsts.maxValues[k],
                      )
                      this.deviceConf[id][k] = platformConsts.maxValues[k]
                    } else {
                      this.deviceConf[id][k] = intVal
                    }
                    break
                  }
                  case 'pollInterval': {
                    if (typeof v === 'string') {
                      logQuotes(`${key}.${id}.${k}`)
                    }
                    const intVal = Number.parseInt(v as string, 10)
                    if (Number.isNaN(intVal)) {
                      logDefault(
                        `${key}.${id}.${k}`,
                        platformConsts.defaultValues[k],
                      )
                      this.deviceConf[id][k] = platformConsts.defaultValues[k]
                    } else if (intVal === 0) {
                      this.deviceConf[id][k] = intVal
                    } else if (intVal < platformConsts.minValues[k]) {
                      logIncrease(key, platformConsts.minValues[k])
                      this.deviceConf[id][k] = platformConsts.minValues[k]
                    } else if (intVal > platformConsts.maxValues[k]) {
                      logDecrease(key, platformConsts.maxValues[k])
                      this.deviceConf[id][k] = platformConsts.maxValues[k]
                    } else {
                      this.deviceConf[id][k] = intVal
                    }
                    break
                  }
                  case 'showAirDryingSwitch': {
                    const inSet = platformConsts.allowed[k].includes(
                      v as string,
                    )
                    if (typeof v !== 'string' || !inSet) {
                      logIgnore(`${key}.${id}.${k}`)
                    } else {
                      this.deviceConf[id][k] = inSet
                        ? v
                        : platformConsts.defaultValues[k]
                    }
                    break
                  }
                  case 'spotAreaIDs1':
                  case 'spotAreaIDs2':
                  case 'spotAreaIDs3':
                  case 'spotAreaIDs4':
                  case 'spotAreaIDs5':
                  case 'spotAreaIDs6':
                  case 'spotAreaIDs7':
                  case 'spotAreaIDs8':
                  case 'spotAreaIDs9':
                  case 'spotAreaIDs10':
                  case 'spotAreaIDs11':
                  case 'spotAreaIDs12':
                  case 'spotAreaIDs13':
                  case 'spotAreaIDs14':
                  case 'spotAreaIDs15': {
                    if (typeof v !== 'string' || v === '') {
                      logIgnore(`${key}.${id}.${k}`)
                    } else {
                      // Strip off everything else than figures and commas.
                      const stripped = v.replace(/[^\d,]+/g, '')
                      if (stripped) {
                        this.deviceConf[id][k] = stripped
                      } else {
                        logIgnore(`${key}.${id}.${k}`)
                      }
                    }
                    break
                  }
                  default:
                    logRemove(`${key}.${id}.${k}`)
                }
              })
            })
          } else {
            logIgnore(key)
          }
          break
        case 'disableDeviceLogging':
        case 'useYeedi':
          if (typeof val === 'string') {
            logQuotes(key)
          }
          this.config[key] = val === 'false'
            ? false
            : !!val
          break
        case 'library':
          // Retired setting (v8.1.0 only): the plugin always runs the stable
          // library now, borrowing the alpha internally for verification -
          // accept silently so existing configs don't warn
          break
        case 'name':
        case 'platform':
          break
        case 'password':
          if (typeof val !== 'string' || val === '') {
            throw new Error(platformLang.invalidPassword)
          }
          this.config.password = val
          break
        case 'username':
          if (typeof val !== 'string' || val === '') {
            throw new Error(platformLang.invalidUsername)
          }
          this.config.username = val.replace(/\s+/g, '')
          break
        case 'verificationCode':
          if (typeof val !== 'string' || val.trim() === '') {
            logIgnore(key)
          } else {
            this.config.verificationCode = val.trim()
          }
          break
        default:
          logRemove(key)
          break
      }
    })
  }

  async pluginSetup() {
    // Plugin has finished initializing so now onto setup
    try {
      // Log that the plugin initialization has been successful
      this.log('%s.', platformLang.initialised)

      // Homebridge already decides whether debug lines are shown, and it gets it
      // right in a child bridge too. This used to work it out for itself by
      // looking for `-D` in the plugin's own process arguments, which a child
      // bridge does not receive unless that bridge has its own debug setting
      // turned on - so debug logging silently disappeared for anyone running the
      // plugin in a child bridge with debug enabled globally.
      //
      // `debugWarn` has no equivalent on Homebridge's logger, so it goes out as
      // a debug line too rather than being invented here.
      this.log.debugWarn = (...args: any[]) => this.log.debug(args[0], ...args.slice(1))

      // Require any libraries that the accessory instances use
      this.cusChar = new platformChars(this.api)

      // Set up the session cache storage (shared cache folder used by my
      // other plugins) so a working login session can be reused across
      // restarts instead of logging in freshly every time
      try {
        const cachePath = join(this.api.user.storagePath(), '/bwp91_cache')
        if (!existsSync(cachePath)) {
          mkdirSync(cachePath)
        }
        this.storageData = storage.create({
          dir: cachePath,
          forgiveParseErrors: true,
        })
        await this.storageData.init()
        this.storageClientData = true
      } catch (err) {
        this.log.debugWarn('%s %s.', platformLang.storageSetupErr, parseError(err))
      }

      // Connect to Ecovacs/Yeedi
      this.ecovacsAPI = new EcoVacsAPI(
        EcoVacsAPI.getDeviceId(
          this.api.hap.uuid.generate(this.config.username),
        ),
        this.config.countryCode,
        countries[this.config.countryCode].continent,
        this.config.useYeedi ? 'yeedi.com' : 'ecovacs.com',
      )

      // Display version of the ecovacs-deebot library in the log
      this.log(
        '%s v%s.',
        platformLang.ecovacsLibVersion,
        this.ecovacsAPI.getVersion(),
      )

      // Reuse a saved login session when one is available and unexpired -
      // fresh logins are what trigger Ecovacs' device-verification emails,
      // so the fewer of those the better
      let usedCachedSession = false
      const cachedSession = await this.loadSessionCache()
      if (cachedSession) {
        this.ecovacsAPI.uid = cachedSession.uid
        this.ecovacsAPI.user_access_token = cachedSession.token
        usedCachedSession = true
        this.log('%s.', platformLang.sessionCached)
        this.scheduleSessionRefresh(cachedSession.expiresAt)
      } else {
        await this.performLogin()
      }

      // Get a device list from Ecovacs/Yeedi. When reusing a saved session the
      // list is retried before concluding anything about the session: a cloud
      // blip or a network still coming up at boot looks identical to a stale
      // token here, and giving the session up over one costs the owner a fresh
      // login and with it, on some accounts, an emailed verification code. A
      // genuinely dead session just fails all three quick attempts (#306)
      let deviceList = await this.getDeviceListSafe(usedCachedSession ? 3 : 1)
      if (!Array.isArray(deviceList) && usedCachedSession) {
        this.log.warn('%s.', platformLang.sessionStale)
        // The saved session is left in place, not cleared: if this fresh login
        // fails too (network down, cloud outage) the next restart should try
        // the saved session again rather than jump straight to a verification
        // code. A successful login below overwrites or clears it instead
        this.sessionSavedByLogin = false
        await this.performLogin()
        deviceList = await this.getDeviceListSafe(2)
        if (Array.isArray(deviceList) && !this.sessionSavedByLogin) {
          // The fresh login worked but came via the stable path, which has no
          // session to save - drop the rejected session so the next restart
          // does not retry a known-dead token
          await this.clearSessionCache()
        }
      }

      // Check the request for device list was successful
      if (!Array.isArray(deviceList)) {
        throw new TypeError(platformLang.deviceListFail)
      }

      // Start the polling intervals for device state refresh, each device may have a different refresh time
      // We add a refresh interval per device later in initialiseDevice()
      this.refreshIntervals = {}

      // Initialize each device into Homebridge
      this.log(
        '[%s] %s.',
        deviceList.length,
        platformLang.deviceCount(this.config.useYeedi ? 'Yeedi' : 'Ecovacs'),
      )
      // A device id in the config that matches nothing on the account is
      // silently ignored, so a wrong or stale one looks exactly like the
      // setting not working (#309). Say so, and name the ids that do exist.
      this.warnAboutUnmatchedDeviceConfig(deviceList)

      for (let i = 0; i < deviceList.length; i += 1) {
        this.initialiseDevice(deviceList[i])
      }

      // ── Matter: register all RoboticVacuumCleaner accessories ───────────
      if (this.api.isMatterAvailable?.() && this.api.isMatterEnabled?.()) {
        const matterAccList = Array.from(
          this.matterVacuumMap.values(),
          a => a.toAccessory(),
        )

        if (matterAccList.length > 0) {
          this.log(
            '[Matter] Registering %s robotic vacuum device(s) via Matter.',
            matterAccList.length,
          )

          await this.api.matter?.registerPlatformAccessories(
            PLUGIN_NAME,
            PLATFORM_NAME,
            matterAccList,
          )

          // Mark each accessory as registered and flush any queued state updates
          for (const vacuum of this.matterVacuumMap.values()) {
            await vacuum.markRegistered()
          }

          this.log('[Matter] Registration complete.')
        }
      } else {
        this.log.debug(
          '[Matter] Skipping Matter registration (useMatter is disabled, or Matter is not available/enabled).',
        )
      }

      // Setup successful
      this.log('%s.', platformLang.complete)
    } catch (err) {
      // Catch any errors during setup
      this.log.warn('***** %s. *****', platformLang.disabling)
      this.log.warn(
        '***** %s. *****',
        parseError(err, [
          platformLang.deviceListFail,
          platformLang.verifyCodeSent,
          platformLang.verifyCodeInvalid,
          platformLang.verifyStableFail,
        ]),
      )
      this.pluginShutdown()
    }
  }

  pluginShutdown() {
    // A function that is called when the plugin fails to load or Homebridge restarts
    try {
      // Stop the refresh intervals
      Object.keys(this.refreshIntervals || {}).forEach((id) => {
        clearInterval(this.refreshIntervals[id])
      })

      // Stop any pending session renewal
      if (this.sessionRefreshTimer) {
        clearTimeout(this.sessionRefreshTimer)
        this.sessionRefreshTimer = undefined
      }

      // Disconnect from each Ecovacs/Yeedi HAP device
      devicesInHB.forEach((accessory) => {
        if (accessory.control?.is_ready) {
          accessory.control.disconnect()
        }
      })

      // Disconnect from each Matter device
      this.matterVacuumMap.forEach((vacuum) => {
        vacuum.disconnect()
      })
    } catch (err) {
      // No need to show errors at this point
    }
  }

  /**
   * Attempt to log in to Ecovacs/Yeedi. Transient failures (e.g. a temporary
   * 'connect to it server' error, code 1300) are retried with a short backoff
   * so a passing cloud blip doesn't disable the whole plugin until the next
   * restart.
   */
  async performLogin(): Promise<void> {
    const maxLoginAttempts = 3
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.ecovacsAPI.connect(
          this.config.username,
          EcoVacsAPI.md5(this.config.password),
        )
        return
      } catch (err) {
        // Code 1013: Ecovacs refuses the stable library's login for this
        // account - either it wants the device verified (a code emailed to
        // the account address) or it is version-gating the old login client
        // outright ('please update to the latest version'). Both are handled
        // by logging in with a borrowed alpha api instance (the only library
        // version the endpoints accept) and handing its session to this
        // stable instance, which happily uses it for the device list and
        // device connections.
        if (err.message?.includes('1013')) {
          await this.loginViaAlphaLibrary()
          return
        }
        // A 1010 error means the password needs base64 decoding; transform it
        // and retry once (this is not a transient failure).
        if (err.message?.includes('1010')) {
          this.config.password = Buffer.from(this.config.password, 'base64')
            .toString('utf8')
            .replace(/\r\n|\n|\r/g, '')
            .trim()
          await this.ecovacsAPI.connect(
            this.config.username,
            EcoVacsAPI.md5(this.config.password),
          )
          return
        }
        // Out of attempts - let the outer handler disable the plugin.
        if (attempt >= maxLoginAttempts) {
          throw err
        }
        // Otherwise wait with a simple linear backoff and try again.
        const delay = attempt * 15
        this.log.warn(
          'Ecovacs login attempt %s/%s failed, retrying in %ss: %s',
          attempt,
          maxLoginAttempts,
          delay,
          parseError(err),
        )
        await sleep(delay)
      }
    }
  }

  /**
   * Fetch the device list, returning undefined instead of throwing so the
   * caller can decide whether a stale cached session was to blame. Attempts
   * beyond the first wait a short moment first, so a passing cloud blip or a
   * network that is still coming up at boot gets a second chance before the
   * caller concludes the session itself is dead.
   */
  async getDeviceListSafe(attempts = 1): Promise<any[] | undefined> {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (attempt > 1) {
        await sleep(attempt * 5)
      }
      try {
        const deviceList = await this.ecovacsAPI.devices()
        if (Array.isArray(deviceList)) {
          return deviceList
        }
        this.log.debugWarn('%s (attempt %s/%s).', platformLang.deviceListFail, attempt, attempts)
      } catch (err) {
        this.log.debugWarn('%s (attempt %s/%s) %s.', platformLang.deviceListFail, attempt, attempts, parseError(err))
      }
    }
    return undefined
  }

  /**
   * The saved session is keyed to the account details, so a change of
   * username, country or Yeedi mode invalidates it naturally.
   */
  sessionAccountKey(): string {
    return createHash('md5')
      .update(`${this.config.username}|${this.config.countryCode}|${this.config.useYeedi ? 'yeedi' : 'ecovacs'}`)
      .digest('hex')
  }

  async loadSessionCache(): Promise<{ uid: string, token: string, expiresAt: number } | undefined> {
    if (!this.storageClientData) {
      return undefined
    }
    try {
      const saved = await this.storageData.getItem('ecovacs_session')
      if (
        !saved
        || saved.account !== this.sessionAccountKey()
        || !saved.uid
        || !saved.token
        // Treat sessions within an hour of expiry (or with no known expiry)
        // as expired so a device connection never starts on a dying token
        || !saved.expiresAt
        || saved.expiresAt < Date.now() + 60 * 60 * 1000
      ) {
        return undefined
      }
      return saved
    } catch (err) {
      this.log.debugWarn('%s %s.', platformLang.storageSetupErr, parseError(err))
      return undefined
    }
  }

  async saveSessionCache(uid: string, token: string, expiresAt: number | undefined, usedCode: string | undefined): Promise<void> {
    this.sessionSavedByLogin = true
    if (!this.storageClientData) {
      return
    }
    try {
      await this.storageData.setItem('ecovacs_session', {
        account: this.sessionAccountKey(),
        uid,
        token,
        expiresAt,
        usedCode,
      })
      this.scheduleSessionRefresh(expiresAt)
    } catch (err) {
      this.log.debugWarn('%s %s.', platformLang.storageSetupErr, parseError(err))
    }
  }

  /**
   * Renew the login session shortly before its token expires, quietly.
   *
   * The token Ecovacs issues lasts about seven days, and before this existed
   * that was the whole story: the saved session aged out, and the next restart
   * had to log in freshly - which on many accounts means an emailed
   * verification code and a manual restart. Owners saw that as "the plugin
   * randomly signs me out every few days" (#306), which is exactly what it was.
   *
   * So while Homebridge is running, the session is re-earned in the background
   * a day before it would die, and the renewed one is saved. As long as
   * Homebridge is restarted at least once a week, no session should ever be
   * old enough to need a code again.
   *
   * Quietly means exactly that: if Ecovacs demands a verification code for the
   * renewal, this gives up and says nothing to the cloud - requesting a code
   * emails the owner, and a background timer has no business doing that. The
   * current session keeps working, and nothing is lost by having asked.
   */
  scheduleSessionRefresh(expiresAt: number | undefined): void {
    if (this.sessionRefreshTimer) {
      clearTimeout(this.sessionRefreshTimer)
      this.sessionRefreshTimer = undefined
    }
    if (!expiresAt) {
      return
    }
    // A day before expiry, but never sooner than an hour from now, so a
    // session loaded already-near-expiry does not refresh in a tight loop
    // Also capped at what a Node timer can hold, because past 2147483647 ms a
    // timer quietly becomes 1 ms - so an expiry far enough in the future would
    // refresh the session in a tight loop, the very thing the lower bound guards
    const delay = Math.min(
      Math.max(expiresAt - Date.now() - 24 * 60 * 60 * 1000, 60 * 60 * 1000),
      2147483647,
    )
    this.sessionRefreshTimer = setTimeout(() => this.quietSessionRefresh(), delay)
    // A pending refresh must not hold the process open on shutdown
    this.sessionRefreshTimer.unref?.()
  }

  async quietSessionRefresh(): Promise<void> {
    try {
      const alphaLib: any = await import('ecovacs-deebot-alpha')
      const verifier = new alphaLib.EcoVacsAPI(
        alphaLib.EcoVacsAPI.getDeviceId(
          this.api.hap.uuid.generate(this.config.username),
        ),
        this.config.countryCode,
        countries[this.config.countryCode].continent,
        this.config.useYeedi ? 'yeedi.com' : 'ecovacs.com',
      )
      await verifier.connect(
        this.config.username,
        alphaLib.EcoVacsAPI.md5(this.config.password),
      )
      if (!verifier.uid || !verifier.user_access_token) {
        throw new Error(platformLang.verifyStableFail)
      }
      // Adopt the renewed session for anything created from here on, and save
      // it so the next restart starts from a fresh session, not a dying one.
      // Device connections already running keep their own established sessions
      this.ecovacsAPI.uid = verifier.uid
      this.ecovacsAPI.user_access_token = verifier.user_access_token
      const credentials = verifier.getCredentials?.() ?? {}
      await this.saveSessionCache(
        verifier.uid,
        verifier.user_access_token,
        credentials.expiresAt ?? undefined,
        undefined,
      )
      this.log('%s.', platformLang.sessionRenewed)
    } catch (err) {
      // Renewal is best-effort - the current session is untouched and keeps
      // working until its own expiry, so failing here costs nothing. Try again
      // in twelve hours; even an attempt after expiry is worth making, since a
      // success then still spares the next restart the verification dance
      this.log.debug('%s %s.', platformLang.sessionRenewFail, parseError(err))
      this.sessionRefreshTimer = setTimeout(() => this.quietSessionRefresh(), 12 * 60 * 60 * 1000)
      this.sessionRefreshTimer.unref?.()
    }
  }

  async clearSessionCache(): Promise<void> {
    if (!this.storageClientData) {
      return
    }
    try {
      const saved = await this.storageData.getItem('ecovacs_session')
      // Keep the record of the last used code so a stale code left in the
      // config is still recognised as spent
      await this.storageData.setItem('ecovacs_session', {
        account: this.sessionAccountKey(),
        usedCode: saved?.account === this.sessionAccountKey()
          ? saved?.usedCode
          : undefined,
      })
    } catch (err) {
      this.log.debugWarn('%s %s.', platformLang.storageSetupErr, parseError(err))
    }
  }

  /**
   * Log in with a throwaway instance of the alpha library - the only library
   * version whose login Ecovacs still accepts for accounts that return code
   * 1013 - completing the emailed device-verification step if the account
   * asks for it, then hand the session (uid + access token) to the stable
   * library instance. The token is a plain account token that the stable
   * library's device-list and device-connection calls accept as-is. Throws
   * with user instructions when a code still needs to be emailed or entered.
   */
  async loginViaAlphaLibrary(): Promise<void> {
    // The alpha's bundled type definitions predate the verification api, so
    // treat the module loosely like the rest of the library usage
    const alphaLib: any = await import('ecovacs-deebot-alpha')
    const verifier = new alphaLib.EcoVacsAPI(
      alphaLib.EcoVacsAPI.getDeviceId(
        this.api.hap.uuid.generate(this.config.username),
      ),
      this.config.countryCode,
      countries[this.config.countryCode].continent,
      this.config.useYeedi ? 'yeedi.com' : 'ecovacs.com',
    )
    // A code from the config that was already spent on a previous successful
    // verification must not be submitted again - Ecovacs codes are one-time,
    // so resubmitting burns a request just to learn it is invalid
    let spentCode: string | undefined
    if (this.storageClientData) {
      try {
        const saved = await this.storageData.getItem('ecovacs_session')
        if (saved?.account === this.sessionAccountKey()) {
          spentCode = saved.usedCode
        }
      } catch {
        // Treat as no spent code on any storage error
      }
    }
    let codeUsed: string | undefined
    try {
      await verifier.connect(
        this.config.username,
        alphaLib.EcoVacsAPI.md5(this.config.password),
      )
    } catch (err) {
      if (!(err instanceof alphaLib.DeviceVerificationRequired)) {
        throw err
      }
      if (!this.config.verificationCode || this.config.verificationCode === spentCode) {
        await verifier.requestDeviceVerificationCode()
        throw new Error(platformLang.verifyCodeSent)
      }
      try {
        await verifier.verifyDevice(this.config.verificationCode)
        codeUsed = this.config.verificationCode
        this.log('%s.', platformLang.verifySuccess)
      } catch (verifyErr) {
        if (verifyErr instanceof alphaLib.InvalidVerificationCode) {
          await verifier.requestDeviceVerificationCode()
          throw new Error(platformLang.verifyCodeInvalid)
        }
        throw verifyErr
      }
    }
    if (!verifier.uid || !verifier.user_access_token) {
      throw new Error(platformLang.verifyStableFail)
    }
    this.ecovacsAPI.uid = verifier.uid
    this.ecovacsAPI.user_access_token = verifier.user_access_token
    this.log('%s.', platformLang.loginBorrowed)

    // Save the session so future restarts skip the login (and with it any
    // repeat of the verification dance) until the token nears expiry
    const credentials = verifier.getCredentials?.() ?? {}
    await this.saveSessionCache(
      verifier.uid,
      verifier.user_access_token,
      credentials.expiresAt ?? undefined,
      codeUsed ?? spentCode,
    )
  }

  deviceClientResource(device): string {
    // Every device connection must use the LOGIN resource: Ecovacs binds
    // authorisation to the resource the access token was issued for, on BOTH
    // protocols. A per-device resource (tried for #81) is refused with 'Not
    // authorized' on MQTT and 'XMPP authentication failure' on XMPP - proven
    // in the field on v8.0.3 and v8.1.2 respectively. If #81's multi-vacuum
    // status mix-up resurfaces, the real fix is a separate login (and
    // therefore token) per vacuum, not a changed resource.
    void device
    return this.ecovacsAPI.resource
  }

  /**
   * Warn about any `devices` entry whose id matches no device on the account.
   *
   * Every per-device setting is looked up by `did`, so an id that matches
   * nothing means all of that entry's settings are quietly ignored - with no
   * log line to say why.
   */
  warnAboutUnmatchedDeviceConfig(deviceList) {
    const configured = Object.keys(this.deviceConf || {})
    if (configured.length === 0) {
      return
    }
    const known = new Set((deviceList || []).map(device => device.did))
    const unmatched = configured.filter(id => !known.has(id))
    if (unmatched.length === 0) {
      return
    }
    this.log.warn(
      '%s [%s]. %s [%s].',
      platformLang.devConfNoMatch,
      unmatched.join(', '),
      platformLang.devConfIdsAre,
      [...known].join(', '),
    )
  }

  initialiseDevice(device) {
    try {
      // Generate the Homebridge UUID from the device id
      const uuid = this.api.hap.uuid.generate(device.did)

      // If the accessory is in the ignored devices list then remove it
      if (this.ignoredDevices.includes(device.did)) {
        if (devicesInHB.has(uuid)) {
          this.removeAccessory(devicesInHB.get(uuid))
        }
        return
      }

      // In Matter-only mode, skip HAP registration entirely
      if (this.api.isMatterEnabled?.()) {
        return this.initialiseMatterOnlyDevice(device)
      }

      // Load the device control information from Ecovacs/Yeedi
      const loadedDevice = this.ecovacsAPI.getVacBot(
        this.ecovacsAPI.uid,
        EcoVacsAPI.REALM,
        this.deviceClientResource(device),
        this.ecovacsAPI.user_access_token,
        device,
        countries[this.config.countryCode].continent,
      )

      // Get the cached accessory or add to Homebridge if it doesn't exist
      const accessory
        = devicesInHB.get(uuid) || this.addAccessory(loadedDevice)

      // Final check the accessory now exists in Homebridge
      if (!accessory) {
        throw new Error(platformLang.accNotFound)
      }

      accessory.context.rawConfig = this.deviceConf?.[device.did] || platformConsts.defaultDevice

      // Debug lines always go to Homebridge's debug logger, which prints them
      // only when debug is on - so there is nothing to decide here. Working it
      // out from the process arguments instead is what lost debug logging
      // entirely for anyone running the plugin in a child bridge.
      accessory.logDebug = msg =>
        this.log.debug('[%s] %s.', accessory.displayName, msg)
      accessory.logDebugWarn = accessory.logDebug

      if (this.config.disableDeviceLogging) {
        accessory.log = () => {}
        accessory.logWarn = () => {}
      } else {
        accessory.log = msg =>
          this.log('[%s] %s.', accessory.displayName, msg)
        accessory.logWarn = msg =>
          this.log.warn('[%s] %s.', accessory.displayName, msg)
      }

      // Initially set the device online value to false (to be updated later)
      accessory.context.isOnline = false
      accessory.context.lastMsg = ''

      // Add the 'clean' switch service if it doesn't already exist
      const cleanService
        = accessory.getService('Clean')
          || accessory.addService(this.hapServ.Switch, 'Clean', 'clean')
      if (!cleanService.testCharacteristic(this.hapChar.ConfiguredName)) {
        cleanService.addCharacteristic(this.hapChar.ConfiguredName)
        cleanService.updateCharacteristic(this.hapChar.ConfiguredName, 'Clean')
      }
      if (!cleanService.testCharacteristic(this.hapChar.ServiceLabelIndex)) {
        cleanService.addCharacteristic(this.hapChar.ServiceLabelIndex)
        cleanService.updateCharacteristic(this.hapChar.ServiceLabelIndex, 1)
      }

      // Add the 'charge' switch service if it doesn't already exist
      const chargeService
        = accessory.getService('Go Charge')
          || accessory.addService(this.hapServ.Switch, 'Go Charge', 'gocharge')
      if (!chargeService.testCharacteristic(this.hapChar.ConfiguredName)) {
        chargeService.addCharacteristic(this.hapChar.ConfiguredName)
        chargeService.updateCharacteristic(
          this.hapChar.ConfiguredName,
          'Go Charge',
        )
      }
      if (!chargeService.testCharacteristic(this.hapChar.ServiceLabelIndex)) {
        chargeService.addCharacteristic(this.hapChar.ServiceLabelIndex)
        chargeService.updateCharacteristic(this.hapChar.ServiceLabelIndex, 2)
      }

      // Check if the speed characteristic has been added
      if (!cleanService.testCharacteristic(this.cusChar.MaxSpeed)) {
        cleanService.addCharacteristic(this.cusChar.MaxSpeed)
      }

      // Add the Eve characteristic for custom commands if any exist
      if (accessory.context.rawConfig.areaType1) {
        if (!cleanService.testCharacteristic(this.cusChar.PredefinedArea)) {
          cleanService.addCharacteristic(this.cusChar.PredefinedArea)
        }

        // Add the set characteristic
        cleanService
          .getCharacteristic(this.cusChar.PredefinedArea)
          .onSet(async value =>
            this.internalPredefinedAreaUpdate(accessory, value),
          )
      } else if (cleanService.testCharacteristic(this.cusChar.PredefinedArea)) {
        cleanService.removeCharacteristic(
          cleanService.getCharacteristic(this.cusChar.PredefinedArea),
        )
      }

      // Add the set handler to the 'clean' switch on/off characteristic
      cleanService
        .getCharacteristic(this.hapChar.On)
        .updateValue(accessory.context.cacheClean === 'auto')
        .removeOnSet()
        .onSet(async (value: boolean) => this.internalCleanUpdate(accessory, value))

      // Add the set handler to the 'max speed' switch on/off characteristic
      cleanService
        .getCharacteristic(this.cusChar.MaxSpeed)
        .onSet(async value => this.internalSpeedUpdate(accessory, value))

      // Add the set handler to the 'charge' switch on/off characteristic
      chargeService
        .getCharacteristic(this.hapChar.On)
        .updateValue(accessory.context.cacheCharge === 'charging')
        .removeOnSet()
        .onSet(async value => this.internalChargeUpdate(accessory, value))

      // Add the 'attention' motion service if it doesn't already exist
      if (
        !accessory.getService('Attention')
        && !accessory.context.rawConfig.hideMotionSensor
      ) {
        accessory.addService(
          this.hapServ.MotionSensor,
          'Attention',
          'attention',
        )
      }

      // Remove the 'attention' motion service if it exists and user doesn't want it
      if (
        accessory.getService('Attention')
        && accessory.context.rawConfig.hideMotionSensor
      ) {
        accessory.removeService(accessory.getService('Attention'))
      }

      // Set the motion sensor off if exists when the plugin initially loads
      if (accessory.getService('Attention')) {
        accessory
          .getService('Attention')
          .updateCharacteristic(this.hapChar.MotionDetected, false)
      }

      // Add the battery service if it doesn't already exist
      if (!accessory.getService(this.hapServ.Battery)) {
        accessory.addService(this.hapServ.Battery)
      }

      // Add the 'battery' humidity service if it doesn't already exist and user wants it
      if (
        !accessory.getService('Battery Level')
        && accessory.context.rawConfig.showBattHumidity
      ) {
        accessory.addService(
          this.hapServ.HumiditySensor,
          'Battery Level',
          'batterylevel',
        )
      }

      // Remove the 'battery' humidity service if it exists and user doesn't want it
      if (
        accessory.getService('Battery Level')
        && !accessory.context.rawConfig.showBattHumidity
      ) {
        accessory.removeService(accessory.getService('Battery Level'))
      }

      // Add or remove the 'air drying' switch service according to the configuration
      // (if it doesn't already exist) and add the set handler to the on/off characteristic
      if (
        accessory.context.rawConfig.showAirDryingSwitch === 'yes'
        || (accessory.context.rawConfig.showAirDryingSwitch === 'presetting'
          && loadedDevice.hasAirDrying())
      ) {
        const dryingService
          = accessory.getService('Air Drying')
            || accessory.addService(this.hapServ.Switch, 'Air Drying', 'airdrying')
        if (!dryingService.testCharacteristic(this.hapChar.ConfiguredName)) {
          dryingService.addCharacteristic(this.hapChar.ConfiguredName)
          dryingService.updateCharacteristic(
            this.hapChar.ConfiguredName,
            'Air Drying',
          )
        }
        if (!dryingService.testCharacteristic(this.hapChar.ServiceLabelIndex)) {
          dryingService.addCharacteristic(this.hapChar.ServiceLabelIndex)
          dryingService.updateCharacteristic(this.hapChar.ServiceLabelIndex, 3)
        }

        dryingService
          .getCharacteristic(this.hapChar.On)
          .updateValue(accessory.context.cacheAirDrying === 'airdrying')
          .removeOnSet()
          .onSet(async value =>
            this.internalAirDryingUpdate(accessory, value),
          )
      } else if (accessory.getService('Air Drying')) {
        accessory.removeService(accessory.getService('Air Drying'))
        accessory.logDebug('air drying service removed')
      } else {
        accessory.logDebug('no air drying available or not configured')
      }

      // Remove the existing cache values from the context now that services have been updated
      const cacheKeys = [
        'cacheClean',
        'cacheCharge',
        'cacheAirDrying',
        'cacheSpeed',
        'cacheBattery',
      ]
      cacheKeys.forEach(key => delete accessory.context[key])

      // TrueDetect service
      if (accessory.context.rawConfig.supportTrueDetect) {
        // Custom Eve characteristic like MaxSpeed
        if (!cleanService.testCharacteristic(this.cusChar.TrueDetect)) {
          cleanService.addCharacteristic(this.cusChar.TrueDetect)
        }

        // Add the set handler to the 'true detect' switch on/off characteristic
        cleanService
          .getCharacteristic(this.cusChar.TrueDetect)
          .onSet(async value =>
            this.internalTrueDetectUpdate(accessory, value),
          )
      } else if (cleanService.testCharacteristic(this.cusChar.TrueDetect)) {
        // TrueDetect is a characteristic on the Clean switch, not a service of its
        // own, so looking for a service named 'TrueDetect' never found anything.
        // The toggle stayed in Eve after the setting was turned off, restored from
        // the accessory cache, with no handler behind it - so it did nothing and
        // never reflected the robot. This mirrors how PredefinedArea is removed.
        cleanService.removeCharacteristic(
          cleanService.getCharacteristic(this.cusChar.TrueDetect),
        )
      }

      // Save the device control information to the accessory
      accessory.control = loadedDevice

      // Some models can use a V2 for supported commands
      accessory.context.commandSuffix = accessory.control.is950type_V2()
        ? '_V2'
        : ''

      // Set up a listener for the device 'ready' event
      accessory.control.on('ready', (event) => {
        if (event) {
          this.externalReadyUpdate(accessory)
        }
      })

      // Set up a listener for the device 'CleanReport' event
      accessory.control.on('CleanReport', (newVal) => {
        this.externalCleanUpdate(accessory, newVal)
      })

      // Set up a listener for the device 'CurrentCustomAreaValues' event
      accessory.control.on('CurrentCustomAreaValues', (newVal) => {
        accessory.logDebug(
          `CurrentCustomAreaValues: ${JSON.stringify(newVal)}`,
        )
      })

      // Set up a listener for the device 'CleanSpeed' event
      accessory.control.on('CleanSpeed', (newVal) => {
        this.externalSpeedUpdate(accessory, newVal)
      })

      // Set up a listener for the device 'BatteryInfo' event
      accessory.control.on('BatteryInfo', async (newVal) => {
        await this.externalBatteryUpdate(accessory, newVal)
      })

      // Set up a listener for the device 'AirDryingState' event
      // Only if the service exists
      if (accessory.getService('Air Drying')) {
        accessory.control.on('AirDryingState', (newVal) => {
          this.externalAirDryingUpdate(accessory, newVal)
        })
      }

      // Set up a listener for the device 'ChargeState' event
      accessory.control.on('ChargeState', (newVal) => {
        this.externalChargeUpdate(accessory, newVal)
      })

      // Set up a listener for the device 'NetInfoIP' event
      accessory.control.on('NetInfoIP', (newVal) => {
        this.externalIPUpdate(accessory, newVal)
      })

      // Set up a listener for the device 'NetInfoMAC' event
      accessory.control.on('NetInfoMAC', (newVal) => {
        this.externalMacUpdate(accessory, newVal)
      })

      if (accessory.context.rawConfig.supportTrueDetect) {
        // Set up a listener for the device 'TrueDetect' event
        accessory.control.on('TrueDetect', (newVal) => {
          this.externalTrueDetectUpdate(accessory, newVal)
        })
      }

      // There was a listener for a 'message' event here. The library never emits
      // one, so it did nothing. The nearest real event, 'messageReceived', fires
      // for every routine mqtt frame the robot sends, so wiring it up would keep
      // the Attention sensor permanently triggered. The alerts worth surfacing
      // arrive on 'Error' and through the low battery path, both of which are
      // already handled.

      // Set up a listener for the device 'Error' event
      accessory.control.on('Error', async (err) => {
        if (err) {
          await this.externalErrorUpdate(accessory, err)
        }
      })

      // Set up listeners for map data if accessory debug logging is on
      accessory.control.on('Maps', (maps) => {
        if (maps) {
          accessory.logDebug(`Maps: ${JSON.stringify(maps)}`)
          Object.keys(maps.maps).forEach((key) => {
            accessory.control.run('GetSpotAreas', maps.maps[key].mapID)
            accessory.control.run('GetVirtualBoundaries', maps.maps[key].mapID)
          })
        }
      })

      accessory.control.on('MapSpotAreas', (spotAreas) => {
        if (spotAreas) {
          accessory.logDebug(`MapSpotAreas: ${JSON.stringify(spotAreas)}`)
          Object.keys(spotAreas.mapSpotAreas).forEach((key) => {
            accessory.control.run(
              'GetSpotAreaInfo',
              spotAreas.mapID,
              spotAreas.mapSpotAreas[key].mapSpotAreaID,
            )
          })
        }
      })

      accessory.control.on('MapSpotAreaInfo', (area) => {
        if (area) {
          accessory.logDebug(`MapSpotAreaInfo: ${JSON.stringify(area)}`)
        }
      })

      accessory.control.on('MapVirtualBoundaries', (vbs) => {
        if (vbs) {
          accessory.logDebug(`MapVirtualBoundaries: ${JSON.stringify(vbs)}`)
          const vbsCombined = [
            ...vbs.mapVirtualWalls,
            ...vbs.mapNoMopZones,
          ]
          const virtualBoundaryArray: any[] = []
          Object.keys(vbsCombined).forEach((key) => {
            virtualBoundaryArray[vbsCombined[key].mapVirtualBoundaryID]
              = vbsCombined[key]
          })
          Object.keys(virtualBoundaryArray).forEach((key) => {
            accessory.control.run(
              'GetVirtualBoundaryInfo',
              vbs.mapID,
              virtualBoundaryArray[key].mapVirtualBoundaryID,
              virtualBoundaryArray[key].mapVirtualBoundaryType,
            )
          })
        }
      })

      accessory.control.on('MapVirtualBoundaryInfo', (vb) => {
        if (vb) {
          accessory.logDebug(`MapVirtualBoundaryInfo: ${JSON.stringify(vb)}`)
        }
      })

      // Connect to the device
      accessory.control.connect()

      // Refresh the current state of all the accessories
      this.refreshAccessory(accessory)
      const { pollInterval } = accessory.context.rawConfig || platformConsts.defaultValues

      if (pollInterval > 0) {
        // This used to call `control.refresh()`, which the ecovacs-deebot VacBot
        // class does not have - so every tick threw inside the timer, where
        // nothing could catch it, and Homebridge restarted the bridge. The method
        // that actually asks the robot for its state is refreshAccessory(), which
        // was otherwise only ever called once at startup, so polling did nothing
        // even when it was not crashing the bridge.
        this.refreshIntervals[device.did] = setInterval(() => {
          const polled = devicesInHB.get(this.api.hap.uuid.generate(device.did))
          if (polled?.control) {
            this.refreshAccessory(polled)
          }
        }, pollInterval * 1000)
      }

      // Update any changes to the accessory to the platform
      this.api.updatePlatformAccessories([accessory])
      devicesInHB.set(accessory.UUID, accessory)

      // Log configuration and device initialisation
      this.log(
        '[%s] %s: %s.',
        accessory.displayName,
        platformLang.devInitOpts,
        JSON.stringify(accessory.context.rawConfig),
      )
      this.log(
        '[%s] %s [%s] %s %s.',
        accessory.displayName,
        platformLang.devInit,
        device.did,
        platformLang.addInfo,
        JSON.stringify(device),
      )

      // If after five seconds the device hasn't responded then mark as offline
      setTimeout(() => {
        if (!accessory.context.isOnline) {
          accessory.logWarn(platformLang.repOffline)
        }
      }, 5000)
    } catch (err) {
      const dName = device.nick || device.did
      this.log.warn(
        '[%s] %s %s.',
        dName,
        platformLang.devNotInit,
        parseError(err, [platformLang.accNotFound]),
      )
      this.log.warn(err)
    }
  }

  refreshAccessory(accessory) {
    try {
      // Check the device has initialised already
      if (!accessory.control) {
        return
      }

      // Set up a flag to check later if we have had a response
      accessory.context.hadResponse = false

      // Run the commands to get the state of the device
      accessory.logDebug(`${platformLang.sendCmd} [GetBatteryState]`)
      accessory.control.run('GetBatteryState')

      accessory.logDebug(`${platformLang.sendCmd} [GetChargeState]`)
      accessory.control.run('GetChargeState')

      if (accessory.getService('Air Drying')) {
        accessory.logDebug(`${platformLang.sendCmd} [GetAirDrying]`)
        accessory.control.run('GetAirDrying')
      }

      accessory.logDebug(
        `${platformLang.sendCmd} [GetCleanState${accessory.context.commandSuffix}]`,
      )
      accessory.control.run(`GetCleanState${accessory.context.commandSuffix}`)

      accessory.logDebug(`${platformLang.sendCmd} [GetCleanSpeed]`)
      accessory.control.run('GetCleanSpeed')

      accessory.logDebug(`${platformLang.sendCmd} [GetNetInfo]`)
      accessory.control.run('GetNetInfo')

      // TrueDetect if the accessory supports it
      if (accessory.context.rawConfig.supportTrueDetect) {
        accessory.logDebug(`${platformLang.sendCmd} [GetTrueDetect]`)
        accessory.control.run('GetTrueDetect')
      }

      setTimeout(() => {
        if (!accessory.context.isOnline && accessory.context.hadResponse) {
          accessory.logDebug(platformLang.repOnline)
          accessory.context.isOnline = true
          this.api.updatePlatformAccessories([accessory])
          devicesInHB.set(accessory.UUID, accessory)
        }
        if (accessory.context.isOnline && !accessory.context.hadResponse) {
          accessory.logDebug(platformLang.repOffline)
          accessory.context.isOnline = false
          this.api.updatePlatformAccessories([accessory])
          devicesInHB.set(accessory.UUID, accessory)
        }
      }, 5000)
    } catch (err) {
      // Catch any errors in the refresh process
      accessory.logWarn(`${platformLang.devNotRef} ${parseError(err)}`)
    }
  }

  /** Initialise a device using the Matter path only (no HAP accessory). */
  initialiseMatterOnlyDevice(device) {
    const dName = device.nick || device.did
    try {
      // Remove any existing HAP accessory for this device to avoid duplicates
      const uuid = this.api.hap.uuid.generate(device.did)
      if (devicesInHB.has(uuid)) {
        this.removeAccessory(devicesInHB.get(uuid))
      }

      // Load the device control object from Ecovacs/Yeedi
      const loadedDevice = this.ecovacsAPI.getVacBot(
        this.ecovacsAPI.uid,
        EcoVacsAPI.REALM,
        this.deviceClientResource(device),
        this.ecovacsAPI.user_access_token,
        device,
        countries[this.config.countryCode].continent,
      )

      // Create and store the Matter accessory
      const matterVacuum = new EcovacsRoboticVacuumAccessory(
        this.api,
        this.log,
        {
          did: device.did,
          nick: loadedDevice.getNickname?.() || device.nick || device.did,
          company: device.company,
          model: device.deviceModel,
          isV2: loadedDevice.is950type_V2(),
        },
      )
      this.matterVacuumMap.set(device.did, matterVacuum)

      // Connect to the device and attach Matter event listeners
      loadedDevice.connect()
      matterVacuum.connectControl(loadedDevice)

      // State refresh. Unlike the HAP accessories this is on by default - see
      // matterPollInterval for why a Matter vacuum cannot rely on push alone.
      const deviceConf
        = this.deviceConf?.[device.did] || platformConsts.defaultDevice
      const pollInterval = matterPollInterval(deviceConf.pollInterval)
      // The HAP path prints the settings it resolved for a device; this one did
      // not, so "my pollInterval is being ignored" had nothing to check (#309)
      this.log(
        '[%s] [Matter] %s: %s.',
        dName,
        platformLang.devInitOpts,
        JSON.stringify({ ...deviceConf, pollInterval }),
      )
      if (pollInterval > 0) {
        this.refreshIntervals[device.did] = setInterval(() => {
          loadedDevice.run?.('GetBatteryState')
          loadedDevice.run?.('GetChargeState')
          loadedDevice.run?.(
            `GetCleanState${loadedDevice.is950type_V2()
              ? '_V2'
              : ''}`,
          )
          loadedDevice.run?.('GetCleanSpeed')
        }, pollInterval * 1000)
      }

      this.log('[%s] [Matter] %s.', dName, platformLang.devInit)
    } catch (err) {
      this.log.warn(
        '[%s] %s %s.',
        dName,
        platformLang.devNotInit,
        parseError(err, [platformLang.accNotFound]),
      )
    }
  }

  addAccessory(device): PlatformAccessory | false {
    let displayName = 'Unknown'

    try {
      displayName = device.vacuum.nick || device.vacuum.did
      const accessory = new this.api.platformAccessory(
        displayName,
        this.api.hap.uuid.generate(device.vacuum.did),
      )
      accessory
        .getService(this.hapServ.AccessoryInformation)!
        .setCharacteristic(this.hapChar.Name, displayName)
        .setCharacteristic(this.hapChar.ConfiguredName, displayName)
        .setCharacteristic(this.hapChar.SerialNumber, device.vacuum.did)
        .setCharacteristic(this.hapChar.Manufacturer, device.vacuum.company)
        .setCharacteristic(this.hapChar.Model, device.deviceModel)
        .setCharacteristic(this.hapChar.Identify, true)

      // Add context information for Homebridge plugin-ui
      accessory.context.ecoDeviceId = device.vacuum.did
      accessory.context.ecoCompany = device.vacuum.company
      accessory.context.ecoModel = device.deviceModel
      accessory.context.ecoClass = device.vacuum.class
      accessory.context.ecoResource = device.vacuum.resource
      accessory.context.ecoImage = device.deviceImageURL

      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
        accessory,
      ])

      devicesInHB.set(accessory.UUID, accessory)

      this.log('[%s] %s.', displayName, platformLang.devAdd)

      return accessory
    } catch (err) {
      // Catch any errors during adding
      this.log.warn(
        '[%s] %s %s.',
        displayName,
        platformLang.devNotAdd,
        parseError(err),
      )

      return false
    }
  }

  /**
   * Called by Homebridge when a cached Matter accessory is restored from disk.
   */
  configureMatterAccessory(accessory: MatterAccessory): void {
    this.log.debug('Loading cached Matter accessory:', accessory.displayName)
    this.matterAccessories.set(accessory.UUID, accessory)
  }

  configureAccessory(accessory: PlatformAccessory): void {
    // Add the configured accessory to our global map
    devicesInHB.set(accessory.UUID, accessory)

    accessory
      .getService('Clean')
      ?.getCharacteristic(this.api.hap.Characteristic.On)
      ?.onSet(() => {
        this.log.warn(
          '[%s] %s.',
          accessory.displayName,
          platformLang.accNotReady,
        )
        throw new this.api.hap.HapStatusError(-70402)
      })
      ?.updateValue(new this.api.hap.HapStatusError(-70402))

    accessory
      .getService('Go Charge')
      ?.getCharacteristic(this.api.hap.Characteristic.On)
      ?.onSet(() => {
        this.log.warn(
          '[%s] %s.',
          accessory.displayName,
          platformLang.accNotReady,
        )
        throw new this.api.hap.HapStatusError(-70402)
      })
      ?.updateValue(new this.api.hap.HapStatusError(-70402))
  }

  removeAccessory(accessory: PlatformAccessory) {
    // Remove an accessory from Homebridge
    try {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
        accessory,
      ])

      devicesInHB.delete(accessory.UUID)

      this.log('[%s] %s.', accessory.displayName, platformLang.devRemove)
    } catch (err) {
      // Catch any errors during remove
      this.log.warn(
        '[%s] %s %s.',
        accessory.displayName,
        platformLang.devNotRemove,
        parseError(err),
      )
    }
  }

  async internalCleanUpdate(accessory: PlatformAccessory & AccessoryExtraProps, value: boolean) {
    try {
      // Don't continue if we can't send commands to the device
      if (!accessory.control) {
        throw new Error(platformLang.errNotInit)
      }
      if (!accessory.control.is_ready) {
        throw new Error(platformLang.errNotReady)
      }

      // A one-second delay seems to make turning off the 'charge' switch more responsive
      await sleep(1)

      // Turn the 'charge' switch off since we have commanded the 'clean' switch
      accessory
        .getService('Go Charge')
        ?.updateCharacteristic(this.hapChar.On, false)

      // Select the correct command to run, either start or stop cleaning
      const order = value
        ? `Clean${accessory.context.commandSuffix}`
        : 'Stop'

      // Log the update
      accessory.log(`${platformLang.curCleaning} [${value ? platformLang.cleaning : platformLang.stop}]`)

      // Send the command
      accessory.logDebug(`${platformLang.sendCmd} [${order}]`)
      accessory.control.run(order)
    } catch (err) {
      // Catch any errors during the process
      accessory.logWarn(
        `${platformLang.cleanFail} ${parseError(err, [platformLang.errNotInit, platformLang.errNotReady])}`,
      )

      // Throw a 'no response' error and set a timeout to revert this after 2 seconds
      setTimeout(() => {
        accessory
          .getService('Clean')
          ?.updateCharacteristic(
            this.hapChar.On,
            accessory.context.cacheClean === 'auto',
          )
      }, 2000)
      throw new this.hapErr(-70402)
    }
  }

  async internalSpeedUpdate(accessory: PlatformAccessory & AccessoryExtraProps, value: boolean) {
    try {
      // Don't continue if we can't send commands to the device
      if (!accessory.control) {
        throw new Error(platformLang.errNotInit)
      }
      if (!accessory.control.is_ready) {
        throw new Error(platformLang.errNotReady)
      }

      // Set speed to max (3) if value is true, otherwise set to standard (2)
      const command = value ? 3 : 2

      // Log the update
      accessory.log(
        `${platformLang.curSpeed} [${platformConsts.speed2Label[command]}]`,
      )

      // Send the command
      accessory.logDebug(`${platformLang.sendCmd} [SetCleanSpeed: ${command}]`)
      accessory.control.run('SetCleanSpeed', command)
    } catch (err) {
      // Catch any errors during the process
      accessory.logWarn(
        `${platformLang.speedFail} ${parseError(err, [platformLang.errNotInit, platformLang.errNotReady])}`,
      )

      // Throw a 'no response' error and set a timeout to revert this after 2 seconds
      setTimeout(() => {
        accessory
          .getService('Clean')
          ?.updateCharacteristic(
            this.cusChar.MaxSpeed,
            [3, 4].includes(accessory.context.cacheSpeed),
          )
      }, 2000)
      throw new this.hapErr(-70402)
    }
  }

  async internalPredefinedAreaUpdate(accessory: PlatformAccessory & AccessoryExtraProps, value: number) {
    try {
      // Don't continue if we can't send commands to the device
      if (!accessory.control) {
        throw new Error(platformLang.errNotInit)
      }
      if (!accessory.control.is_ready) {
        throw new Error(platformLang.errNotReady)
      }

      // Eve app, for some reason, still sends values with decimal places
      value = Math.round(value)

      // A value of 0 doesn't do anything
      if (value === 0) {
        accessory.logDebugWarn(platformLang.returningAsValueNull)
        return
      }

      // Avoid quick switching with this function
      const updateKey = Math.random().toString(36).slice(2, 10)
      accessory.context.lastCommandKey = updateKey
      await sleep(1)
      if (updateKey !== accessory.context.lastCommandKey) {
        accessory.logWarn(platformLang.skippingValue)
        return
      }

      // Get the area type from the device config
      const areaType = accessory.context.rawConfig[`areaType${value}`]

      // Don't continue if no command type for this number has been configured
      if (!areaType) {
        throw new Error(`${platformLang.noTypeForArea}: ${value}`)
      }

      accessory.log(`${platformLang.typeForArea} ${value}: ${areaType}`)

      // Get the command from the device config
      const command
        = accessory.context.rawConfig[
          areaType === 'spotArea'
            ? `spotAreaIDs${value}`
            : `customAreaCoordinates${value}`
        ]

      // Don't continue if no command for this number has been configured
      if (!command) {
        throw new Error(`${platformLang.noCommandForArea}: ${value}`)
      }

      accessory.log(`${platformLang.commandForArea} ${value}: ${command}`)

      // Send the command
      switch (areaType) {
        case 'spotArea':
          accessory.logDebug(
            `${platformLang.sendCmd} [SpotArea${accessory.context.commandSuffix}: ${command}]`,
          )

          if (accessory.context.commandSuffix === '_V2') {
            accessory.control.run('SpotArea_V2', command)
          } else {
            accessory.control.run('SpotArea', 'start', command)
          }
          break

        case 'customArea':
          accessory.logDebug(
            `${platformLang.sendCmd} [CustomArea${accessory.context.commandSuffix}: ${command}]`,
          )

          if (accessory.context.commandSuffix === '_V2') {
            accessory.control.run('CustomArea_V2', command)
          } else {
            accessory.control.run('CustomArea', 'start', command)
          }
          break

        default:
          throw new Error(
            `${areaType}: ${platformLang.unknownCommandTypeForArea}`,
          )
      }

      accessory.log(platformLang.commandSent)

      // Set the value back to 0 after two seconds and turn the main ON switch on
      setTimeout(() => {
        accessory
          .getService('Clean')
          ?.updateCharacteristic(this.cusChar.PredefinedArea, 0)

        accessory
          .getService('Clean')
          ?.updateCharacteristic(this.hapChar.On, true)
        accessory.log(platformLang.characteristicsReset)
      }, 2000)
    } catch (err) {
      // Catch any errors during the process
      accessory.logWarn(`${platformLang.cleanFail} ${parseError(err, [platformLang.errNotInit, platformLang.errNotReady])}`)

      // Throw a 'no response' error and set a timeout to revert this after 2 seconds
      setTimeout(() => {
        accessory
          .getService('Clean')
          ?.updateCharacteristic(this.cusChar.PredefinedArea, 0)
      }, 2000)

      throw new this.hapErr(-70402)
    }
  }

  async internalChargeUpdate(accessory: PlatformAccessory & AccessoryExtraProps, value: boolean) {
    try {
      // Don't continue if we can't send commands to the device
      if (!accessory.control) {
        throw new Error(platformLang.errNotInit)
      }
      if (!accessory.control.is_ready) {
        throw new Error(platformLang.errNotReady)
      }

      // A one-second delay seems to make everything more responsive
      await sleep(1)

      // Don't continue if the device is already charging. Put the switch back
      // first: without this it stayed on whatever the owner had just set, and
      // nothing corrected it afterwards, because the external update only pushes
      // a change when the reported charge state changes - and it does not.
      const battService = accessory.getService(this.hapServ.Battery)
      if (
        battService?.getCharacteristic(this.hapChar.ChargingState).value !== 0
      ) {
        setTimeout(() => {
          accessory
            .getService('Go Charge')
            ?.updateCharacteristic(
              this.hapChar.On,
              accessory.context.cacheCharge === 'returning',
            )
        }, 2000)
        return
      }

      // Select the correct command to run, either start or stop going to charge
      const order = value ? 'Charge' : 'Stop'

      // Log the update
      accessory.log(
        `${platformLang.curCharging} [${value ? platformLang.returning : platformLang.stop}]`,
      )

      // Send the command
      accessory.logDebug(`${platformLang.sendCmd} [${order}]`)
      accessory.control.run(order)
    } catch (err) {
      // Catch any errors during the process
      accessory.logWarn(
        `${platformLang.chargeFail} ${parseError(err, [platformLang.errNotInit, platformLang.errNotReady])}`,
      )

      // Throw a 'no response' error and set a timeout to revert this after 2 seconds
      setTimeout(() => {
        accessory
          .getService('Go Charge')
          ?.updateCharacteristic(
            this.hapChar.On,
            accessory.context.cacheCharge === 'returning',
          )
      }, 2000)
      throw new this.hapErr(-70402)
    }
  }

  async internalAirDryingUpdate(accessory: PlatformAccessory & AccessoryExtraProps, value: boolean) {
    try {
      // Don't continue if we can't send commands to the device
      if (!accessory.control) {
        throw new Error(platformLang.errNotInit)
      }
      if (!accessory.control.is_ready) {
        throw new Error(platformLang.errNotReady)
      }

      // A one-second delay seems to make everything more responsive
      await sleep(1)

      // Select the correct command to run, either start or stop air drying.
      const order = value ? 'AirDryingStart' : 'AirDryingStop'

      // Send the command
      accessory.logDebug(`${platformLang.sendCmd} [${order}]`)
      accessory.control.run(order)
    } catch (err) {
      // Catch any errors during the process
      accessory.logWarn(
        `${platformLang.airDryingFail} ${parseError(err, [platformLang.errNotInit, platformLang.errNotReady])}`,
      )

      // Throw a 'no response' error and set a timeout to revert this after 2 seconds
      setTimeout(() => {
        accessory
          .getService('Air Drying')
          ?.updateCharacteristic(
            this.hapChar.On,
            accessory.context.cacheAirDrying === 'airdrying',
          )
      }, 2000)

      throw new this.hapErr(-70402)
    }
  }

  async internalTrueDetectUpdate(accessory: PlatformAccessory & AccessoryExtraProps, value: boolean) {
    try {
      // Don't continue if we can't send commands to the device
      if (!accessory.control) {
        throw new Error(platformLang.errNotInit)
      }
      if (!accessory.control.is_ready) {
        throw new Error(platformLang.errNotReady)
      }

      // Select the correct command to run, either enable or disable TrueDetect.
      const command = value ? 'EnableTrueDetect' : 'DisableTrueDetect'

      // Log the update
      accessory.log(`${platformLang.curTrueDetect} [${value ? 'yes' : 'no'}]`)

      // Send the command
      accessory.logDebug(`${platformLang.sendCmd} [${command}]`)
      accessory.control.run(command)
    } catch (err) {
      // Catch any errors during the process
      accessory.logWarn(
        `${platformLang.cleanFail} ${parseError(err, [platformLang.errNotInit, platformLang.errNotReady])}`,
      )

      // Throw a 'no response' error and set a timeout to revert this after 2 seconds
      setTimeout(() => {
        accessory
          .getService('Clean')
          ?.updateCharacteristic(this.cusChar.TrueDetect, false)
      }, 2000)

      throw new this.hapErr(-70402)
    }
  }

  externalReadyUpdate(accessory: PlatformAccessory & AccessoryExtraProps) {
    try {
      // Called on the 'ready' event sent by the device so request update for states
      accessory.logDebug(`${platformLang.sendCmd} [GetBatteryState]`)
      accessory.control.run('GetBatteryState')

      accessory.logDebug(`${platformLang.sendCmd} [GetChargeState]`)
      accessory.control.run('GetChargeState')

      accessory.logDebug(
        `${platformLang.sendCmd} [GetCleanState${accessory.context.commandSuffix}]`,
      )
      accessory.control.run(`GetCleanState${accessory.context.commandSuffix}`)

      accessory.logDebug(`${platformLang.sendCmd} [GetCleanSpeed]`)
      accessory.control.run('GetCleanSpeed')

      accessory.logDebug(`${platformLang.sendCmd} [GetNetInfo]`)
      accessory.control.run('GetNetInfo')

      accessory.logDebug(`${platformLang.sendCmd} [GetMaps]`)
      accessory.control.run('GetMaps')
    } catch (err) {
      // Catch any errors during the process
      accessory.logWarn(`${platformLang.inRdyFail} ${parseError(err)}`)
    }
  }

  externalCleanUpdate(accessory: PlatformAccessory & AccessoryExtraProps, newVal: string) {
    try {
      // Log the received update
      accessory.logDebug(`${platformLang.receiveCmd} [CleanReport: ${newVal}]`)

      // Check if the new cleaning state is different from the cached state
      if (accessory.context.cacheClean !== newVal) {
        // State is different so update service
        accessory
          .getService('Clean')
          ?.updateCharacteristic(
            this.hapChar.On,
            [
              'auto',
              'clean',
              'edge',
              'spot',
              'spotarea',
              'customarea',
              'spotareav2',
              'customareav2',
              'mapping',
            ].includes(newVal.toLowerCase().replace(/[^a-z0-9]+/g, '')),
          )

        // Log the change
        accessory.log(`${platformLang.curCleaning} [${newVal}]`)
      }

      // Always update the cache with the new cleaning status
      accessory.context.cacheClean = newVal
    } catch (err) {
      // Catch any errors during the process
      accessory.logWarn(`${platformLang.inClnFail} ${parseError(err)}`)
    }
  }

  externalSpeedUpdate(accessory: PlatformAccessory & AccessoryExtraProps, newVal: number) {
    try {
      // Log the received update
      accessory.logDebug(`${platformLang.receiveCmd} [CleanSpeed: ${newVal}]`)

      // Check if the new cleaning state is different from the cached state
      if (accessory.context.cacheSpeed !== newVal) {
        // State is different so update service
        accessory
          .getService('Clean')
          ?.updateCharacteristic(this.cusChar.MaxSpeed, [3, 4].includes(newVal))

        // Log the change
        accessory.log(
          `${platformLang.curSpeed} [${platformConsts.speed2Label[newVal]}]`,
        )
      }

      // Always update the cache with the new speed status
      accessory.context.cacheSpeed = newVal
    } catch (err) {
      // Catch any errors during the process
      accessory.logWarn(`${platformLang.inSpdFail} ${parseError(err)}`)
    }
  }

  externalAirDryingUpdate(accessory: PlatformAccessory & AccessoryExtraProps, newVal: string) {
    try {
      // Log the received update
      accessory.logDebug(
        `${platformLang.receiveCmd} [AirDryingState: ${newVal}]`,
      )

      // Check if the new drying state is different from the cached state
      if (accessory.context.cacheAirDrying !== newVal) {
        // State is different so update service
        accessory
          .getService('Air Drying')
          ?.updateCharacteristic(this.hapChar.On, newVal === 'airdrying')

        // Log the change
        accessory.log(`${platformLang.curAirDrying} [${newVal}]`)
      }

      // Always update the cache with the new drying status
      accessory.context.cacheAirDrying = newVal
    } catch (err) {
      // Catch any errors during the process
      accessory.logWarn(`${platformLang.inAirFail} ${parseError(err)}`)
    }
  }

  externalTrueDetectUpdate(accessory: PlatformAccessory & AccessoryExtraProps, newVal: number) {
    try {
      // Log the received update
      accessory.logDebug(`${platformLang.receiveCmd} [TrueDetect: ${newVal}]`)

      // Check if the new charging state is different from the cached state
      if (accessory.context.trueDetect !== newVal) {
        // State is different so update service
        accessory
          .getService('Clean')
          ?.updateCharacteristic(this.cusChar.TrueDetect, newVal === 1)

        // Log the change
        accessory.log(
          `${platformLang.curTrueDetect} [${newVal === 1
            ? 'enabled'
            : 'disabled'}]`,
        )
      }

      // Always update the cache with the new charging status
      accessory.context.trueDetect = newVal
    } catch (err) {
      // Catch any errors during the process
      accessory.logWarn(`${platformLang.inTrDFail} ${parseError(err)}`)
    }
  }

  externalChargeUpdate(accessory: PlatformAccessory & AccessoryExtraProps, newVal: string) {
    try {
      // Log the received update
      accessory.logDebug(`${platformLang.receiveCmd} [ChargeState: ${newVal}]`)

      // Check if the new charging state is different from the cached state
      if (accessory.context.cacheCharge !== newVal) {
        // State is different so update service
        accessory
          .getService('Go Charge')
          ?.updateCharacteristic(this.hapChar.On, newVal === 'returning')

        const chargeState = newVal === 'charging'
          ? 1
          : 0
        accessory
          .getService(this.hapServ.Battery)
          ?.updateCharacteristic(this.hapChar.ChargingState, chargeState)

        // Log the change
        accessory.log(`${platformLang.curCharging} [${newVal}]`)
      }

      // Always update the cache with the new charging status
      accessory.context.cacheCharge = newVal
    } catch (err) {
      // Catch any errors during the process
      accessory.logWarn(`${platformLang.inChgFail} ${parseError(err)}`)
    }
  }

  externalIPUpdate(accessory: PlatformAccessory & AccessoryExtraProps, newVal: string) {
    try {
      // Log the received update
      accessory.logDebug(`${platformLang.receiveCmd} [NetInfoIP: ${newVal}]`)

      // Check if the new IP is different from the cached IP
      if (accessory.context.ipAddress !== newVal) {
        // IP is different, so update context info
        accessory.context.ipAddress = newVal

        // Update the changes to the accessory to the platform
        this.api.updatePlatformAccessories([accessory])
        devicesInHB.set(accessory.UUID, accessory)
      }
    } catch (err) {
      // Catch any errors during the process
    }
  }

  externalMacUpdate(accessory: PlatformAccessory & AccessoryExtraProps, newVal: string) {
    try {
      // Log the received update
      accessory.logDebug(`${platformLang.receiveCmd} [NetInfoMAC: ${newVal}]`)

      // Check if the new MAC is different from the cached MAC
      if (accessory.context.macAddress !== newVal) {
        // MAC is different so update context info
        accessory.context.macAddress = newVal

        // Update the changes to the accessory to the platform
        this.api.updatePlatformAccessories([accessory])
        devicesInHB.set(accessory.UUID, accessory)
      }
    } catch (err) {
      // Catch any errors during the process
    }
  }

  async externalBatteryUpdate(accessory: PlatformAccessory & AccessoryExtraProps, newVal: number) {
    try {
      // Mark the device as online if it was offline before
      accessory.context.hadResponse = true

      // Log the received update
      accessory.logDebug(`${platformLang.receiveCmd} [BatteryInfo: ${newVal}]`)

      // Check the value given is between 0 and 100
      newVal = Math.min(Math.max(Math.round(newVal), 0), 100)

      // Check if the new battery value is different from the cached state
      if (accessory.context.cacheBattery !== newVal) {
        // Value is different so update services
        const threshold = accessory.context.rawConfig.lowBattThreshold
        const lowBattStatus = newVal <= threshold
          ? 1
          : 0
        accessory
          .getService(this.hapServ.Battery)
          ?.updateCharacteristic(this.hapChar.BatteryLevel, newVal)
        accessory
          .getService(this.hapServ.Battery)
          ?.updateCharacteristic(this.hapChar.StatusLowBattery, lowBattStatus)

        // Also update the 'battery' humidity service if it exists
        if (accessory.context.rawConfig.showBattHumidity) {
          accessory
            .getService('Battery Level')
            ?.updateCharacteristic(this.hapChar.CurrentRelativeHumidity, newVal)
        }

        // Log the change
        accessory.log(`${platformLang.curBatt} [${newVal}%]`)

        // If the user wants a message and a buzz from the motion sensor then do it
        if (
          accessory.context.rawConfig.showMotionLowBatt
          && newVal <= accessory.context.rawConfig.lowBattThreshold
          && !accessory.cacheShownMotionLowBatt
        ) {
          await this.externalMessageUpdate(
            accessory,
            `${platformLang.lowBattMsg + newVal}%`,
          )
          accessory.cacheShownMotionLowBatt = true
        }

        // Revert the cache to false once the device has charged above the threshold
        if (newVal > accessory.context.rawConfig.lowBattThreshold) {
          accessory.cacheShownMotionLowBatt = false
        }
      }

      // Always update the cache with the new battery value
      accessory.context.cacheBattery = newVal
    } catch (err) {
      // Catch any errors during the process
      accessory.logWarn(`${platformLang.inBattFail} ${parseError(err)}`)
    }
  }

  async externalMessageUpdate(accessory, msg) {
    try {
      // Don't bother logging the same message as before
      if (accessory.context.lastMsg === msg) {
        return
      }
      accessory.context.lastMsg = msg

      // Check if it's a no error message
      if (msg === 'NoError: Robot is operational') {
        return
      }

      // Check to see if the motion sensor is already in use
      if (accessory.cacheInUse) {
        return
      }
      accessory.cacheInUse = true

      // Log the message sent from the device
      accessory.log(`${platformLang.sentMsg} [${msg}]`)

      // Update the motion sensor to motion detected if it exists
      if (accessory.getService('Attention')) {
        accessory
          .getService('Attention')
          .updateCharacteristic(this.hapChar.MotionDetected, true)
      }

      // The motion sensor stays on for the time configured by the user, so we wait
      setTimeout(() => {
        // Reset the motion sensor after waiting for the time above if it exists
        if (accessory.getService('Attention')) {
          accessory
            .getService('Attention')
            .updateCharacteristic(this.hapChar.MotionDetected, false)
        }

        // Update the inUse cache to false as we are complete here
        accessory.cacheInUse = false
      }, accessory.context.rawConfig.motionDuration * 1000)
    } catch (err) {
      // Catch any errors in the process
      accessory.logWarn(`${platformLang.inMsgFail} ${parseError(err)}`)
    }
  }

  async externalErrorUpdate(accessory, err) {
    try {
      // Check if it's an offline notification but device was online
      if (err === 'Recipient unavailable' && accessory.context.isOnline) {
        accessory.log(platformLang.repOffline)
        accessory.context.isOnline = false
        this.api.updatePlatformAccessories([accessory])
        devicesInHB.set(accessory.UUID, accessory)
      }

      // Check if it's a no error message
      if (err === 'NoError: Robot is operational') {
        return
      }

      // The optional canvas module only draws map images, which HomeKit
      // never sees - it is commonly unbuilt on user systems (npm 12 blocks
      // its build script), so note it once quietly rather than warn per
      // map event
      if (String(err).includes('canvas.node')) {
        if (!accessory.context.canvasNoteShown) {
          accessory.context.canvasNoteShown = true
          accessory.logDebug(platformLang.canvasMissing)
        }
        return
      }

      // Don't bother logging the same message as before
      if (accessory.context.lastMsg === err) {
        return
      }
      accessory.context.lastMsg = err

      // Log the message sent from the device
      accessory.logWarn(`${platformLang.sentErr} [${err}]`)

      // Check to see if the motion sensor is already in use
      if (accessory.cacheInUse) {
        return
      }
      accessory.cacheInUse = true

      // Update the motion sensor to motion detected if it exists
      if (accessory.getService('Attention')) {
        accessory
          .getService('Attention')
          .updateCharacteristic(this.hapChar.MotionDetected, true)
      }

      // The device has an error so turn both 'clean' and 'charge' switches off
      accessory
        .getService('Clean')
        .updateCharacteristic(this.hapChar.On, false)
      accessory
        .getService('Go Charge')
        .updateCharacteristic(this.hapChar.On, false)

      // The motion sensor stays on for the time configured by the user, so we wait
      setTimeout(() => {
        // Reset the motion sensor after waiting for the time above if it exists
        if (accessory.getService('Attention')) {
          accessory
            .getService('Attention')
            .updateCharacteristic(this.hapChar.MotionDetected, false)
        }

        // Update the inUse cache to false as we are complete here
        accessory.cacheInUse = false
      }, accessory.context.rawConfig.motionDuration * 1000)
    } catch (error) {
      // Catch any errors in the process
      accessory.logWarn(`${platformLang.inErrFail} ${parseError(error)}`)
    }
  }
}
