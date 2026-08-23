import { constants } from 'node:fs'
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, resolve } from 'node:path'

import { debateSessionSchema, type DebateSession, type RoleConfig } from '../../shared/schemas'
import { redactString } from '../providers/http/redaction'
import { parseSafeJson } from '../storage/atomic-json'

const CRLF = '\r\n'
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024

export interface SaveDialogResult {
  canceled: boolean
  filePath?: string
}

export interface SaveDialogPort {
  showSaveDialog(options: {
    title: string
    defaultPath: string
    filters: Array<{ name: string; extensions: string[] }>
  }): Promise<SaveDialogResult>
}

export interface MarkdownExporterOptions {
  maxOutputBytes?: number
}

export interface MarkdownExportResult {
  cancelled: boolean
  fileName?: string
}

const providerLabel = (provider: RoleConfig['provider']): string =>
  ({ openai: 'OpenAI', kimi: 'Kimi', deepseek: 'DeepSeek' })[provider]

const safePublicText = (value: string): string => redactString(value, { maxLength: 200_000 })
const safeInlineText = (value: string): string =>
  safePublicText(value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/([\\`*_{}\[\]()#+|<>])/g, '\\$1')

const fenced = (value: string): string => {
  const text = safePublicText(value).replace(/\r\n?|\n/g, CRLF)
  const longestRun = Math.max(0, ...[...text.matchAll(/`+/g)].map(([run]) => run.length))
  const fence = '`'.repeat(Math.max(4, longestRun + 1))
  return `${fence}text${CRLF}${text}${CRLF}${fence}`
}

const roleSummary = (role: RoleConfig): string[] => {
  const lines = [
    `### ${role.roleId === 'role-a' ? '角色 A' : '角色 B'}：${safeInlineText(role.name)}`,
    '',
    `- 服务商：${providerLabel(role.provider)}`,
    `- 模型：${safeInlineText(role.model)}`
  ]
  if ('effort' in role && role.effort !== undefined) lines.push(`- 思考强度：${role.effort}`)
  if ('thinking' in role && role.thinking !== undefined) {
    lines.push(`- 深度思考：${role.thinking ? '开启' : '关闭'}`)
  }
  lines.push('', '立场/人设：', '', fenced(role.personaOrStance))
  return lines
}

const resultLines = (session: DebateSession): string[] => {
  const stateLabels: Record<DebateSession['state'], string> = {
    idle: '尚未开始',
    validating: '验证中断',
    running: '运行中断，可手动恢复',
    pausing: '暂停过程中断，可手动恢复',
    paused: '已暂停，可手动恢复',
    completed: '已完成',
    stopped: '用户已停止',
    unresolved: '未决',
    refused: '服务商拒绝',
    failed: '调用失败'
  }
  const reasonLabels: Record<NonNullable<DebateSession['terminationReason']>, string> = {
    conceded: '一方认输',
    agreed: '双方达成一致',
    'max-turns': '达到轮次上限',
    'user-stopped': '用户停止',
    'provider-refusal': '服务商拒绝',
    'call-failed': '调用失败'
  }
  const lines = [`- 状态：${stateLabels[session.state]}`]
  if (session.terminationReason) lines.push(`- 结束原因：${reasonLabels[session.terminationReason]}`)
  if (session.winnerRoleId) {
    const winner = session.setup.roles.find(({ roleId }) => roleId === session.winnerRoleId)
    if (winner) lines.push(`- 胜方：${safeInlineText(winner.name)}`)
  }
  lines.push(`- 已完成轮次：${session.currentTurn}`)
  return lines
}

export const renderDebateMarkdown = (
  value: unknown,
  options: MarkdownExporterOptions = {}
): string => {
  const session = parseSafeJson(debateSessionSchema, value)
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new RangeError('maxOutputBytes must be a positive safe integer')
  }

  const lines: string[] = [
    '# AI 辩论记录',
    '',
    '## 话题',
    '',
    fenced(session.setup.topic),
    '',
    '## 配置摘要',
    '',
    `- 先发角色：${session.setup.firstSpeaker === 'role-a' ? '角色 A' : '角色 B'}`,
    `- 最大轮次：${session.setup.maxTurns}`,
    `- 创建时间：${session.createdAt}`,
    '',
    ...roleSummary(session.setup.roles[0]),
    '',
    ...roleSummary(session.setup.roles[1]),
    '',
    '## 正式发言',
    ''
  ]

  if (session.messages.length === 0) {
    lines.push('_尚无正式发言。_', '')
  } else {
    for (const message of session.messages) {
      const role = session.setup.roles.find(({ roleId }) => roleId === message.roleId)
      lines.push(
        `### 第 ${message.turn} 轮 · ${safeInlineText(role?.name ?? message.roleId)}`,
        '',
        `- 服务商：${providerLabel(message.provider)}`,
        `- 模型：${safeInlineText(message.model)}`,
        `- 时间：${message.createdAt}`,
        '',
        fenced(message.speech),
        ''
      )
      if (message.usage) {
        lines.push(
          `- 输入用量：${message.usage.inputTokens}`,
          `- 输出用量：${message.usage.outputTokens}`,
          `- 总用量：${message.usage.totalTokens}`
        )
        if (message.usage.cacheReadTokens !== undefined) {
          lines.push(`- 缓存读取用量：${message.usage.cacheReadTokens}`)
        }
        lines.push('')
      }
    }
  }

  lines.push('## 结果', '', ...resultLines(session), '')
  const markdown = lines.join(CRLF)
  if (Buffer.byteLength(markdown, 'utf8') > maxOutputBytes) {
    throw new RangeError('Markdown export is too large')
  }
  return markdown
}

const safeDefaultFileName = (session: DebateSession): string => {
  const topic = session.setup.topic
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 80)
    .trim()
  const id = session.id
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 80)
    .trim()
  return `${topic || 'AI辩论'}-${id || 'session'}.md`
}

const validateSelectedPath = async (filePath: string): Promise<string> => {
  if (!isAbsolute(filePath) || filePath.includes('\0')) {
    throw new TypeError('Export path must be an absolute local file path')
  }
  const target = resolve(filePath)
  const name = basename(target)
  if (
    /[<>:"|?*\u0000-\u001f]/.test(name) ||
    /[. ]$/.test(name) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  ) {
    throw new TypeError('Export file name is not valid on Windows')
  }
  const parent = dirname(target)
  const canonicalParent = await realpath(parent)
  const sameParent =
    process.platform === 'win32'
      ? canonicalParent.toLocaleLowerCase('en-US') === parent.toLocaleLowerCase('en-US')
      : canonicalParent === parent
  if (!sameParent) {
    throw new TypeError('Export directory must not contain symlinks')
  }
  try {
    const info = await lstat(target)
    if (info.isSymbolicLink()) throw new TypeError('Export target must not be a symlink')
    if (!info.isFile()) throw new TypeError('Export target must be a regular file')
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
    if (code !== 'ENOENT') throw error
  }
  return target
}

const writeAtomicFile = async (target: string, content: string): Promise<void> => {
  const directory = dirname(target)
  const temporary = resolve(directory, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`)
  let handle
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    )
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, target)
    if (process.platform !== 'win32') {
      const directoryHandle = await open(directory, constants.O_RDONLY)
      try {
        await directoryHandle.sync()
      } finally {
        await directoryHandle.close()
      }
    }
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

export class MarkdownExporter {
  constructor(
    private readonly dialog: SaveDialogPort,
    private readonly options: MarkdownExporterOptions = {}
  ) {}

  async export(value: unknown): Promise<MarkdownExportResult> {
    const session = parseSafeJson(debateSessionSchema, value)
    const markdown = renderDebateMarkdown(session, this.options)
    const result = await this.dialog.showSaveDialog({
      title: '导出辩论记录',
      defaultPath: safeDefaultFileName(session),
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (result.canceled) return { cancelled: true }
    if (!result.filePath) throw new TypeError('Save dialog returned no local file path')
    const target = await validateSelectedPath(result.filePath)
    await writeAtomicFile(target, markdown)
    return { cancelled: false, fileName: basename(target) }
  }
}
