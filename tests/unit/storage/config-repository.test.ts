import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ConfigRepository } from '../../../src/main/storage/config-repository'
import { kimiRole, openAIRole } from '../../helpers/debate-fixtures'
import { createTempDirectory, removeTempDirectories } from '../../helpers/temp-directories'

describe('ConfigRepository', () => {
  afterEach(removeTempDirectories)

  it('stores only validated RoleConfig values and default settings', async () => {
    const root = await createTempDirectory('config-repository-')
    const repository = new ConfigRepository(root)

    expect(await repository.getSettings()).toEqual({ roles: [], maxTurns: 100 })
    await repository.saveRole(openAIRole)
    await repository.saveRole(kimiRole)

    expect(await repository.listRoles()).toEqual([openAIRole, kimiRole])
    expect(await repository.getSettings()).toEqual({
      roles: [openAIRole, kimiRole],
      maxTurns: 100
    })
  })

  it('replaces roles by roleId, deletes them, and never leaks mutable references', async () => {
    const root = await createTempDirectory('config-repository-clone-')
    const repository = new ConfigRepository(root)
    await repository.saveRole(openAIRole)
    await repository.saveRole({ ...openAIRole, name: '更新后的正方' })

    const roles = await repository.listRoles()
    roles[0]!.name = '外部篡改'
    expect((await repository.listRoles())[0]?.name).toBe('更新后的正方')
    expect(await repository.deleteRole('role-a')).toBe(true)
    expect(await repository.deleteRole('role-a')).toBe(false)
  })

  it('rejects nested secret fields before persistence', async () => {
    const root = await createTempDirectory('config-repository-secret-')
    const repository = new ConfigRepository(root)
    const unsafe = {
      ...kimiRole,
      advanced: { credentials: { apiKey: 'super-secret-value' } }
    }

    await expect(repository.saveRole(unsafe)).rejects.toThrow()
    const settingsPath = join(root, 'config/settings.json')
    const contents = await readFile(settingsPath, 'utf8').catch(() => '')
    expect(contents).not.toContain('super-secret-value')
    expect(contents.toLowerCase()).not.toContain('apikey')
  })

  it('serializes concurrent read-modify-write operations without losing a role', async () => {
    const root = await createTempDirectory('config-repository-concurrent-')
    const repository = new ConfigRepository(root)

    await Promise.all([repository.saveRole(openAIRole), repository.saveRole(kimiRole)])

    expect(await repository.listRoles()).toEqual([openAIRole, kimiRole])
  })

  it('serializes read-modify-write operations across repository instances', async () => {
    const root = await createTempDirectory('config-repository-cross-instance-')
    const first = new ConfigRepository(root)
    const second = new ConfigRepository(root)

    await Promise.all([first.saveRole(openAIRole), second.saveRole(kimiRole)])

    expect(await new ConfigRepository(root).listRoles()).toEqual([openAIRole, kimiRole])
  })

  it('recovers its shared transaction queue after a rejected operation', async () => {
    const root = await createTempDirectory('config-repository-rejection-')
    const first = new ConfigRepository(root)
    const second = new ConfigRepository(root)

    await expect(first.saveRole({ ...openAIRole, model: '' })).rejects.toThrow()
    await second.saveRole(kimiRole)

    expect(await first.listRoles()).toEqual([kimiRole])
  })
})
