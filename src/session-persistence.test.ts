import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EcovacsPlatform } from './platform.js'

/**
 * The behaviour that keeps verification emails rare (#306).
 *
 * Ecovacs sends some accounts an emailed verification code on every fresh
 * login, so the plugin's job is to log in freshly as close to never as it can:
 * a saved session must not be given up over one failed request, and it must be
 * renewed in the background before its roughly-seven-day token dies.
 *
 * These tests drive the two pieces of that directly on the platform's methods,
 * with the platform object built bare - the real constructor wants the whole
 * of Homebridge, and none of it is needed here.
 */

vi.mock('./utils/functions.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./utils/functions.js')>()
  return {
    ...original,
    sleep: vi.fn(async () => {}),
  }
})

function makePlatform(): any {
  const platform: any = Object.create(EcovacsPlatform.prototype)
  platform.log = Object.assign(vi.fn(), {
    warn: vi.fn(),
    debug: vi.fn(),
    debugWarn: vi.fn(),
  })
  return platform
}

describe('fetching the device list on a saved session', () => {
  it('tries again after a failure, because a blip is not a dead session', async () => {
    const platform = makePlatform()
    let calls = 0
    platform.ecovacsAPI = {
      devices: vi.fn(async () => {
        calls += 1
        if (calls < 3) {
          throw new Error('ETIMEDOUT')
        }
        return [
          { did: 'robot-1' },
        ]
      }),
    }

    const list = await platform.getDeviceListSafe(3)

    expect(list).toEqual([
      { did: 'robot-1' },
    ])
    expect(calls).toBe(3)
  })

  it('gives up only after every attempt has failed', async () => {
    const platform = makePlatform()
    platform.ecovacsAPI = {
      devices: vi.fn(async () => Promise.reject(new Error('dead token'))),
    }

    const list = await platform.getDeviceListSafe(3)

    expect(list).toBeUndefined()
    expect(platform.ecovacsAPI.devices).toHaveBeenCalledTimes(3)
  })

  it('asks once when told to ask once', async () => {
    // the fresh-login path has no session to protect, so it gets no retries
    const platform = makePlatform()
    platform.ecovacsAPI = {
      devices: vi.fn(async () => Promise.reject(new Error('nope'))),
    }

    await platform.getDeviceListSafe(1)

    expect(platform.ecovacsAPI.devices).toHaveBeenCalledTimes(1)
  })
})

describe('renewing the session before it expires', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('schedules the renewal a day before the token dies', () => {
    const platform = makePlatform()
    const week = 7 * 24 * 60 * 60 * 1000
    const spy = vi.spyOn(platform, 'quietSessionRefresh').mockResolvedValue(undefined)

    platform.scheduleSessionRefresh(Date.now() + week)

    vi.advanceTimersByTime(week - 25 * 60 * 60 * 1000)
    expect(spy).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2 * 60 * 60 * 1000)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('never fires sooner than an hour, even for a session already near death', () => {
    // a nearly-expired session must not turn the timer into a tight loop
    const platform = makePlatform()
    const spy = vi.spyOn(platform, 'quietSessionRefresh').mockResolvedValue(undefined)

    platform.scheduleSessionRefresh(Date.now() + 1000)

    vi.advanceTimersByTime(59 * 60 * 1000)
    expect(spy).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2 * 60 * 1000)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the session has no known expiry', () => {
    const platform = makePlatform()
    const spy = vi.spyOn(platform, 'quietSessionRefresh').mockResolvedValue(undefined)

    platform.scheduleSessionRefresh(undefined)

    vi.advanceTimersByTime(30 * 24 * 60 * 60 * 1000)
    expect(spy).not.toHaveBeenCalled()
  })

  it('replaces a pending renewal rather than stacking a second one', () => {
    const platform = makePlatform()
    const spy = vi.spyOn(platform, 'quietSessionRefresh').mockResolvedValue(undefined)
    const week = 7 * 24 * 60 * 60 * 1000

    platform.scheduleSessionRefresh(Date.now() + week)
    platform.scheduleSessionRefresh(Date.now() + week)

    vi.advanceTimersByTime(week)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('what a failed renewal must never do', () => {
  it('leaves the working session alone and does not email anyone', async () => {
    vi.useFakeTimers()
    const platform = makePlatform()
    platform.config = { username: 'a@b.c', password: 'pw', countryCode: 'GB' }
    platform.api = {
      hap: {
        uuid: {
          generate: () => 'uuid',
        },
      },
    }
    platform.ecovacsAPI = { uid: 'old-uid', user_access_token: 'old-token' }

    // the alpha library rejecting the renewal outright
    vi.doMock('ecovacs-deebot-alpha', () => ({
      EcoVacsAPI: class {
        static getDeviceId() { return 'device' }
        static md5() { return 'hash' }
        connect() { return Promise.reject(new Error('1013 verification required')) }
      },
    }))

    await platform.quietSessionRefresh()

    // the running session is untouched, the failure went to debug only, and a
    // retry is queued instead of a verification email
    expect(platform.ecovacsAPI.uid).toBe('old-uid')
    expect(platform.ecovacsAPI.user_access_token).toBe('old-token')
    expect(platform.log.warn).not.toHaveBeenCalled()
    expect(platform.sessionRefreshTimer).toBeDefined()
    vi.useRealTimers()
    vi.doUnmock('ecovacs-deebot-alpha')
  })
})
