import { z } from 'zod'

import {
  roleConfigSchema,
  roleIdSchema,
  type RoleConfig
} from '../../shared/schemas'
import { AtomicJsonStore, parseSafeJson } from './atomic-json'
import { runKeyedTransaction } from './transaction-coordinator'

const SETTINGS_PATH = 'config/settings.json'

export const persistedSettingsSchema = z
  .strictObject({
    roles: z.array(roleConfigSchema).max(2),
    maxTurns: z.number().int().min(1).max(100).default(100)
  })
  .superRefine(({ roles }, context) => {
    if (new Set(roles.map(({ roleId }) => roleId)).size !== roles.length) {
      context.addIssue({ code: 'custom', path: ['roles'], message: 'role ids must be unique' })
    }
  })

export type PersistedSettings = z.output<typeof persistedSettingsSchema>

const defaultSettings = (): PersistedSettings => ({ roles: [], maxTurns: 100 })

export class ConfigRepository {
  private readonly store: AtomicJsonStore
  private readonly root: string

  constructor(root: string) {
    this.root = root
    this.store = new AtomicJsonStore(root)
  }

  async getSettings(): Promise<PersistedSettings> {
    return await this.mutate(async (settings) => structuredClone(settings))
  }

  async listRoles(): Promise<RoleConfig[]> {
    return (await this.getSettings()).roles
  }

  async saveRole(value: unknown): Promise<RoleConfig> {
    const role = parseSafeJson(roleConfigSchema, value)
    return await this.mutate(async (settings) => {
      const roles = settings.roles.filter(({ roleId }) => roleId !== role.roleId)
      roles.push(role)
      roles.sort(({ roleId: left }, { roleId: right }) => left.localeCompare(right))
      await this.store.write(SETTINGS_PATH, persistedSettingsSchema, { ...settings, roles })
      return structuredClone(role)
    })
  }

  async deleteRole(value: unknown): Promise<boolean> {
    const roleId = parseSafeJson(roleIdSchema, value)
    return await this.mutate(async (settings) => {
      const roles = settings.roles.filter((role) => role.roleId !== roleId)
      if (roles.length === settings.roles.length) return false
      await this.store.write(SETTINGS_PATH, persistedSettingsSchema, { ...settings, roles })
      return true
    })
  }

  async setMaxTurns(value: unknown): Promise<number> {
    const maxTurns = parseSafeJson(z.number().int().min(1).max(100), value)
    return await this.mutate(async (settings) => {
      await this.store.write(SETTINGS_PATH, persistedSettingsSchema, { ...settings, maxTurns })
      return maxTurns
    })
  }

  private mutate<T>(operation: (settings: PersistedSettings) => Promise<T>): Promise<T> {
    return runKeyedTransaction(this.root, 'config-repository', async () => {
      const settings =
        (await this.store.read(SETTINGS_PATH, persistedSettingsSchema)) ?? defaultSettings()
      return operation(settings)
    })
  }
}
