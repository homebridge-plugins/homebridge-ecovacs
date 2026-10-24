/**
 * Base Matter Accessory Class
 *
 * Provides common functionality that all Matter devices use.
 * Adapted from homebridge-plugins/homebridge-matter.
 */

import type { API, ClusterStateMap, EndpointType, Logger, MatterAccessory } from 'homebridge'

export interface BaseMatterAccessoryConfig {
  UUID: string
  displayName: string
  deviceType: EndpointType
  serialNumber: string
  manufacturer: string
  model: string
  firmwareRevision: string
  hardwareRevision: string
  context?: Record<string, unknown>
  clusters?: MatterAccessory['clusters']
  handlers?: MatterAccessory['handlers']
  parts?: MatterAccessory['parts']
}

/**
 * Base class for all Matter accessories.
 * Implements the MatterAccessory interface and provides common methods.
 */
export abstract class BaseMatterAccessory implements MatterAccessory {
  public readonly UUID: string
  public readonly displayName: string
  public readonly deviceType: EndpointType
  public readonly serialNumber: string
  public readonly manufacturer: string
  public readonly model: string
  public readonly firmwareRevision: string
  public readonly hardwareRevision: string
  public readonly context: Record<string, unknown>
  public readonly clusters?: MatterAccessory['clusters']
  public readonly handlers?: MatterAccessory['handlers']
  public readonly parts?: MatterAccessory['parts']

  protected readonly api: API
  protected readonly log: Logger

  /** Set to true once the accessory has been registered with the Matter server. */
  private _registered = false

  /** Queued state updates received before registration completes. */
  private _pendingUpdates: Array<{ cluster: string, attributes: Record<string, unknown>, partId?: string }> = []

  /** Call after api.matter.registerPlatformAccessories() resolves for this accessory. */
  public async markRegistered(): Promise<void> {
    this._registered = true
    // Flush any state updates that arrived before registration
    for (const pending of this._pendingUpdates) {
      try {
        await this.api.matter?.updateAccessoryState(this.UUID, pending.cluster, pending.attributes, pending.partId)
        this.log.debug(`[${this.displayName}] Flushed queued ${pending.cluster} state:`, pending.attributes)
      } catch (err) {
        this.log.error(`[${this.displayName}] Failed to flush queued ${pending.cluster} state: ${err instanceof Error
          ? err.message
          : err}`)
      }
    }
    this._pendingUpdates = []
  }

  protected constructor(
    api: API,
    log: Logger,
    config: BaseMatterAccessoryConfig,
  ) {
    this.api = api
    this.log = log

    this.UUID = config.UUID
    this.displayName = config.displayName
    this.deviceType = config.deviceType
    this.serialNumber = config.serialNumber
    this.manufacturer = config.manufacturer
    this.model = config.model
    this.firmwareRevision = config.firmwareRevision
    this.hardwareRevision = config.hardwareRevision
    this.clusters = config.clusters
    this.handlers = config.handlers
    this.parts = config.parts

    this.context = {
      serialNumber: this.serialNumber,
      manufacturer: this.manufacturer,
      model: this.model,
      firmwareRevision: this.firmwareRevision,
      hardwareRevision: this.hardwareRevision,
      ...config.context,
    }
  }

  /**
   * Update cluster state attributes.
   */
  protected async updateState<K extends keyof ClusterStateMap>(
    cluster: K,
    attributes: Partial<ClusterStateMap[K]>,
    partId?: string,
  ): Promise<void>

  protected async updateState(
    cluster: string,
    attributes: Record<string, unknown>,
    partId?: string,
  ): Promise<void>

  protected async updateState(
    cluster: string,
    attributes: Record<string, unknown>,
    partId?: string,
  ): Promise<void> {
    if (!this._registered) {
      this.log.debug(`[${this.displayName}] Queuing ${cluster} state update — not yet registered with Matter server.`)
      this._pendingUpdates.push({ cluster, attributes, partId })
      return
    }
    try {
      await this.api.matter?.updateAccessoryState(this.UUID, cluster, attributes, partId)
      this.log.debug(`[${this.displayName}] Updated ${cluster} state:`, attributes)
    } catch (err) {
      this.log.error(`[${this.displayName}] Failed to update ${cluster} state: ${err instanceof Error
        ? err.message
        : err}`)
    }
  }

  /**
   * Read the current cluster state.
   */
  protected async readState<K extends keyof ClusterStateMap>(
    cluster: K,
    partId?: string,
  ): Promise<Partial<ClusterStateMap[K]> | undefined>

  protected async readState(
    cluster: string,
    partId?: string,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      return await this.api.matter?.getAccessoryState(this.UUID, cluster, partId)
    } catch (err) {
      this.log.error(`[${this.displayName}] Failed to read ${cluster} state: ${err instanceof Error
        ? err.message
        : err}`)
      return undefined
    }
  }

  protected logInfo(message: string, ...args: unknown[]): void {
    this.log.info(`[${this.displayName}] ${message}`, ...args)
  }

  protected logError(message: string, ...args: unknown[]): void {
    this.log.error(`[${this.displayName}] ${message}`, ...args)
  }

  protected logDebug(message: string, ...args: unknown[]): void {
    this.log.debug(`[${this.displayName}] ${message}`, ...args)
  }

  protected logWarn(message: string, ...args: unknown[]): void {
    this.log.warn(`[${this.displayName}] ${message}`, ...args)
  }

  /**
   * Convert this instance to a plain MatterAccessory object for registration.
   */
  public toAccessory(): MatterAccessory {
    return {
      UUID: this.UUID,
      displayName: this.displayName,
      deviceType: this.deviceType,
      serialNumber: this.serialNumber,
      manufacturer: this.manufacturer,
      model: this.model,
      firmwareRevision: this.firmwareRevision,
      hardwareRevision: this.hardwareRevision,
      context: this.context,
      clusters: this.clusters,
      handlers: this.handlers,
      parts: this.parts,
    }
  }
}
