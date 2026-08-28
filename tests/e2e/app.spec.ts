import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

import { configureRoles, expect, startDebate, test } from './fixtures'

test('配置、B 先发、流式达成一致、历史与导出形成完整桌面流程', async ({ page, mockServer, testKey, exportPath }) => {
  mockServer.setScenario('agree')
  await configureRoles(page, mockServer, testKey)
  const topic = `E2E 一致话题 ${Date.now()}`
  await startDebate(page, topic)
  await expect(page.getByLabel('辩手 B 第 1 轮发言')).toBeVisible()
  await expect(page.getByRole('region', { name: '辩论结果' })).toContainText('双方达成一致')
  expect(mockServer.requests.slice(0, 2).map(({ provider }) => provider)).toEqual(['deepseek', 'kimi'])
  expect(mockServer.requests.slice(0, 2).map(({ authorization }) => authorization)).toEqual([
    `Bearer ${testKey}`, `Bearer ${testKey}`
  ])
  expect(mockServer.requests.every(({ body }) => !JSON.stringify(body).includes(testKey))).toBe(true)

  await page.getByRole('button', { name: '返回角色配置' }).click()
  await page.getByRole('button', { name: '历史记录' }).click()
  await page.getByRole('button', { name: `查看${topic}` }).click()
  await expect(page.locator('.history-detail')).toContainText('双方达成一致')
  await page.getByRole('button', { name: '导出 Markdown' }).click()
  await expect(page.locator('.history-notice')).toContainText(basename(exportPath))
  const markdown = await readFile(exportPath, 'utf8')
  expect(markdown).toContain(topic)
  expect(markdown).toContain('第1位辩手同意这一结论')
  expect(markdown).toContain('双方达成一致')
  expect(markdown).not.toContain(testKey)
})

test('暂停在当前发言结束后生效，并可继续到终局', async ({ page, mockServer, testKey }) => {
  mockServer.setScenario('pause')
  await configureRoles(page, mockServer, testKey)
  await startDebate(page, '暂停恢复话题', 2)
  await expect(page.getByText(/第1轮继续/)).toBeVisible()
  await page.getByRole('button', { name: '暂停辩论' }).click()
  await expect(page.getByText('已暂停', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '继续辩论' }).click()
  await expect(page.getByRole('region', { name: '辩论结果' })).toContainText('达到轮次上限')
})

test('认输立即判定对方获胜', async ({ page, mockServer, testKey }) => {
  mockServer.setScenario('concede')
  await configureRoles(page, mockServer, testKey)
  await startDebate(page, '认输话题')
  await expect(page.getByRole('region', { name: '辩论结果' })).toContainText('辩手 A 获胜')
})

test('默认上限为 100 且第 100 次发言后未决', async ({ page, mockServer, testKey }) => {
  test.setTimeout(180_000)
  mockServer.setScenario('continue')
  await configureRoles(page, mockServer, testKey)
  await page.getByRole('button', { name: '进入辩论设置' }).click()
  await expect(page.getByLabel('最大轮次')).toHaveValue('100')
  await page.getByRole('textbox', { name: '辩论话题' }).fill('百轮边界话题')
  await page.getByLabel(/角色 B ·/).check()
  await page.getByRole('button', { name: '开始辩论' }).click()
  await expect(page.getByRole('region', { name: '辩论结果' })).toContainText('达到轮次上限', { timeout: 150_000 })
  await expect(page.locator('.message-bubble:not(.draft)')).toHaveCount(100)
  expect(mockServer.requests).toHaveLength(100)
})

test('首轮调用失败后可重试当前轮并恢复', async ({ page, mockServer, testKey }) => {
  mockServer.setScenario('fail-first')
  await configureRoles(page, mockServer, testKey)
  await startDebate(page, '失败恢复话题', 2)
  await expect(page.getByRole('region', { name: '辩论结果' })).toContainText('模型调用失败')
  mockServer.setScenario('agree')
  await page.getByRole('button', { name: '重试当前轮' }).click()
  await expect(page.getByRole('region', { name: '辩论结果' })).toContainText('双方达成一致')
})
