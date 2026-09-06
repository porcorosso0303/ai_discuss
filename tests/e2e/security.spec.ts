import { configureRoles, expect, test } from './fixtures'

test('renderer 保持基础隔离且页面不显示 API Key', async ({ page, mockServer, testKey }) => {
  expect(await page.evaluate(() => ({
    requireType: typeof (globalThis as { require?: unknown }).require,
    processType: typeof (globalThis as { process?: unknown }).process,
    topLevelKeys: Object.keys((globalThis as unknown as { aiDebates: Record<string, unknown> }).aiDebates).sort()
  }))).toEqual({
    requireType: 'undefined',
    processType: 'undefined',
    topLevelKeys: ['app', 'config', 'credentials', 'debate', 'export', 'history', 'openAI', 'providers']
  })
  expect(await page.evaluate(() => 'ipcRenderer' in (globalThis as unknown as { aiDebates: Record<string, unknown> }).aiDebates)).toBe(false)
  await configureRoles(page, mockServer, testKey)
  await expect(page.locator('body')).not.toContainText(testKey)
  expect(await page.locator('body').textContent()).not.toContain(testKey)
})
