import type { API } from 'homebridge'

export default class PlatformChars {
  declare uuids: {
    maxSpeed: string
    predefinedArea: string
    trueDetect: string
  }

  declare MaxSpeed: any
  declare PredefinedArea: any
  declare TrueDetect: any

  constructor(api: API) {
    this.uuids = {
      maxSpeed: 'E963F001-079E-48FF-8F27-9C2605A29F52',
      predefinedArea: 'E963F002-079E-48FF-8F27-9C2605A29F52',
      trueDetect: 'E963F003-079E-48FF-8F27-9C2605A29F52',
    }
    const uuids = this.uuids

    this.MaxSpeed = class extends api.hap.Characteristic {
      constructor() {
        super('Max Speed', uuids.maxSpeed, {
          format: api.hap.Formats.BOOL,
          perms: [
            api.hap.Perms.PAIRED_READ,
            api.hap.Perms.PAIRED_WRITE,
            api.hap.Perms.NOTIFY,
          ],
        })
        this.value = this.getDefaultValue()
      }
    }

    this.PredefinedArea = class extends api.hap.Characteristic {
      constructor() {
        super('Predefined Area', uuids.predefinedArea, {
          format: api.hap.Formats.UINT8,
          perms: [
            api.hap.Perms.PAIRED_READ,
            api.hap.Perms.PAIRED_WRITE,
            api.hap.Perms.NOTIFY,
          ],
          minValue: 0,
          maxValue: 15,
          minStep: 1,
          validValues: [
            0,
            1,
            2,
            3,
            4,
            5,
            6,
            7,
            8,
            9,
            10,
            11,
            12,
            13,
            14,
            15,
          ],
        })
        this.value = this.getDefaultValue()
      }
    }

    this.TrueDetect = class extends api.hap.Characteristic {
      constructor() {
        super('TrueDetect', uuids.trueDetect, {
          format: api.hap.Formats.BOOL,
          perms: [
            api.hap.Perms.PAIRED_READ,
            api.hap.Perms.PAIRED_WRITE,
            api.hap.Perms.NOTIFY,
          ],
        })
        this.value = this.getDefaultValue()
      }
    }

    this.PredefinedArea.UUID = this.uuids.predefinedArea
    this.TrueDetect.UUID = this.uuids.trueDetect
    this.MaxSpeed.UUID = this.uuids.maxSpeed
  }
}
