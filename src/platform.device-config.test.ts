import { describe, expect, it, vi } from 'vitest'

import { EcovacsPlatform } from './platform.js'

/**
 * #309 (valatalo): a per-device `pollInterval` looked like it was being
 * ignored. Every per-device setting is looked up by the device's `did`, so an
 * id in the config that matches nothing on the account silently discards that
 * whole entry — and nothing said so.
 */
describe('warnAboutUnmatchedDeviceConfig', () => {
  function makePlatform(deviceConf: Record<string, unknown>) {
    const platform: any = Object.create(EcovacsPlatform.prototype)
    const warn = vi.fn()
    platform.log = Object.assign(vi.fn(), { warn })
    platform.deviceConf = deviceConf
    return { platform, warn }
  }

  it('names the ids that matched nothing, and the ones that exist', () => {
    const { platform, warn } = makePlatform({
      typo123: { pollInterval: 30 },
    })

    platform.warnAboutUnmatchedDeviceConfig([
      { did: 'real456' },
    ])

    expect(warn).toHaveBeenCalledTimes(1)
    const message = warn.mock.calls[0].join(' ')
    expect(message).toContain('typo123')
    expect(message).toContain('real456')
  })

  it('says nothing when every configured id matches a device', () => {
    const { platform, warn } = makePlatform({
      real456: { pollInterval: 30 },
    })

    platform.warnAboutUnmatchedDeviceConfig([
      { did: 'real456' },
      { did: 'other789' },
    ])

    expect(warn).not.toHaveBeenCalled()
  })

  it('says nothing when no devices are configured at all', () => {
    const { platform, warn } = makePlatform({})

    platform.warnAboutUnmatchedDeviceConfig([
      { did: 'real456' },
    ])

    expect(warn).not.toHaveBeenCalled()
  })

  it('does not fall over when the device list is missing', () => {
    const { platform, warn } = makePlatform({ typo123: {} })

    expect(() => platform.warnAboutUnmatchedDeviceConfig(undefined)).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
