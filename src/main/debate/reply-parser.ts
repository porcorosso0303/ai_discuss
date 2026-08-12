import type { DebateReply, DebateReplyStatus } from '../../shared/domain'
import { debateReplySchema } from '../../shared/schemas'

export const EMPTY_SPEECH_PLACEHOLDER = '（模型未返回可显示的发言）'
export const INVALID_REPLY_PLACEHOLDER = '（模型返回了无法解析的回复）'

export type ReplyParseSource = 'json' | 'tag' | 'fallback'

export interface ParsedDebateReply extends DebateReply {
  source: ReplyParseSource
  warning?: string
}

const MAX_SPEECH_LENGTH = 200_000
const outerJsonFencePattern = /^\s*```(?:json)?[ \t]*\r?\n?([\s\S]*?)\r?\n?```\s*$/i
const trailingStatusPattern =
  /\s*<debate-status>(continue|concede|agree)<\/debate-status>\s*$/
const trailingInvalidStatusPattern =
  /\s*<debate-status>[^<>]*<\/debate-status>\s*$/i
const trailingUnclosedStatusPattern = /\s*<debate-status>[^<>]*$/i
const openingStatusTag = '<debate-status>'
const closingStatusTag = '</debate-status>'

const appendWarning = (warning: string | undefined, addition: string): string =>
  warning === undefined ? addition : `${warning} ${addition}`

const finalizeReply = ({
  speech,
  status,
  source,
  warning
}: {
  speech: string
  status: DebateReplyStatus
  source: ReplyParseSource
  warning?: string
}): ParsedDebateReply => {
  let visibleSpeech = speech.trim()
  let finalWarning = warning

  if (visibleSpeech.length > MAX_SPEECH_LENGTH) {
    visibleSpeech = visibleSpeech.slice(0, MAX_SPEECH_LENGTH)
    finalWarning = appendWarning(finalWarning, '模型发言超过长度限制，已截断。')
  }

  if (visibleSpeech.length === 0) {
    visibleSpeech = EMPTY_SPEECH_PLACEHOLDER
    finalWarning = appendWarning(finalWarning, '模型未返回可显示的发言。')
  }

  return finalWarning === undefined
    ? { speech: visibleSpeech, status, source }
    : { speech: visibleSpeech, status, source, warning: finalWarning }
}

interface ParsedJsonString {
  value: string
  end: number
}

const parseJsonStringAt = (input: string, start: number): ParsedJsonString | undefined => {
  if (input[start] !== '"') {
    return undefined
  }

  let escaped = false

  for (let index = start + 1; index < input.length; index += 1) {
    const character = input[index]

    if (character === '"' && !escaped) {
      try {
        const value = JSON.parse(input.slice(start, index + 1)) as unknown
        return typeof value === 'string' ? { value, end: index + 1 } : undefined
      } catch {
        return undefined
      }
    }

    escaped = character === '\\' && !escaped
  }

  return undefined
}

const skipWhitespace = (input: string, start: number): number => {
  let index = start

  while (/\s/.test(input[index] ?? '')) {
    index += 1
  }

  return index
}

const recoverTopLevelJsonSpeech = (input: string, parsed: unknown): string | undefined => {
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    Object.prototype.hasOwnProperty.call(parsed, 'speech') &&
    typeof (parsed as { speech?: unknown }).speech === 'string'
  ) {
    return (parsed as { speech: string }).speech
  }

  const rootStart = skipWhitespace(input, 0)

  if (input[rootStart] !== '{') {
    return undefined
  }

  const containerStack: Array<'{' | '['> = []
  let recoveredSpeech: string | undefined

  for (let index = rootStart; index < input.length; index += 1) {
    const character = input[index]

    if (character === '"') {
      const jsonString = parseJsonStringAt(input, index)

      if (jsonString === undefined) {
        return recoveredSpeech
      }

      if (containerStack.length === 1 && containerStack[0] === '{') {
        const colonIndex = skipWhitespace(input, jsonString.end)

        if (input[colonIndex] === ':' && jsonString.value === 'speech') {
          const speechStart = skipWhitespace(input, colonIndex + 1)
          const speech = parseJsonStringAt(input, speechStart)

          if (speech === undefined) {
            return undefined
          }

          recoveredSpeech = speech.value
          index = speech.end - 1
          continue
        }
      }

      index = jsonString.end - 1
      continue
    }

    if (character === '{' || character === '[') {
      containerStack.push(character)
    } else if (character === '}' || character === ']') {
      const expectedOpener = character === '}' ? '{' : '['

      if (containerStack.pop() !== expectedOpener) {
        return undefined
      }

      if (containerStack.length === 0) {
        return input.slice(index + 1).trim().length === 0 ? recoveredSpeech : undefined
      }
    }
  }

  return recoveredSpeech
}

/*
 * Invalid structured output must never be rendered wholesale because it can
 * contain provider-only reasoning or raw payload fields. Recovery is limited
 * to one complete top-level JSON string named `speech`.
 */
const recoverVisibleStructuredSpeech = (input: string, parsed: unknown): string =>
  recoverTopLevelJsonSpeech(input, parsed) ?? INVALID_REPLY_PLACEHOLDER

const stripTrailingMachineMarker = (input: string): string | undefined => {
  const invalidStatusMatch = trailingInvalidStatusPattern.exec(input)

  if (invalidStatusMatch !== null) {
    return input.slice(0, invalidStatusMatch.index)
  }

  const unclosedStatusMatch = trailingUnclosedStatusPattern.exec(input)

  if (unclosedStatusMatch !== null) {
    return input.slice(0, unclosedStatusMatch.index)
  }

  const normalizedInput = input.toLowerCase()
  const openingTagIndex = normalizedInput.lastIndexOf(openingStatusTag)

  if (openingTagIndex !== -1) {
    const markerSuffix = normalizedInput.slice(openingTagIndex)
    const closingTagIndex = markerSuffix.indexOf(closingStatusTag, openingStatusTag.length)

    if (
      closingTagIndex === -1 ||
      markerSuffix.slice(closingTagIndex + closingStatusTag.length).trim().length === 0
    ) {
      return input.slice(0, openingTagIndex)
    }
  }

  const lastTagStart = input.lastIndexOf('<')

  if (lastTagStart === -1) {
    return undefined
  }

  const possibleClosingFragment = input.slice(lastTagStart).trim().toLowerCase()

  return possibleClosingFragment.startsWith('</debate-') &&
    closingStatusTag.startsWith(possibleClosingFragment)
    ? input.slice(0, lastTagStart)
    : undefined
}

const fallbackVisibleSpeech = (input: string, parsed: unknown): string =>
  input.startsWith('{') || input.startsWith('[')
    ? recoverVisibleStructuredSpeech(input, parsed)
    : input

export const parseReply = (raw: string): ParsedDebateReply => {
  const trimmedRaw = raw.trim()
  const fencedMatch = outerJsonFencePattern.exec(trimmedRaw)
  const candidate = (fencedMatch?.[1] ?? trimmedRaw).trim()
  let parsedJson: unknown

  try {
    parsedJson = JSON.parse(candidate)
    const validated = debateReplySchema.safeParse(parsedJson)

    if (validated.success) {
      return finalizeReply({ ...validated.data, source: 'json' })
    }
  } catch {
    parsedJson = undefined
  }

  const statusMatch = trailingStatusPattern.exec(trimmedRaw)

  if (statusMatch !== null) {
    return finalizeReply({
      speech: trimmedRaw.slice(0, statusMatch.index),
      status: statusMatch[1] as DebateReplyStatus,
      source: 'tag'
    })
  }

  const speechWithoutMachineMarker = stripTrailingMachineMarker(trimmedRaw)

  if (speechWithoutMachineMarker !== undefined) {
    const cleanedRaw = speechWithoutMachineMarker.trim()
    const cleanedFenceMatch = outerJsonFencePattern.exec(cleanedRaw)
    const cleanedCandidate = (cleanedFenceMatch?.[1] ?? cleanedRaw).trim()
    let cleanedJson: unknown

    try {
      cleanedJson = JSON.parse(cleanedCandidate)
    } catch {
      cleanedJson = undefined
    }

    return finalizeReply({
      speech: fallbackVisibleSpeech(cleanedCandidate, cleanedJson),
      status: 'continue',
      source: 'fallback',
      warning: '已移除无效或不完整的末尾辩论状态标记，状态按 continue 处理。'
    })
  }

  return finalizeReply({
    speech: fallbackVisibleSpeech(candidate, parsedJson),
    status: 'continue',
    source: 'fallback',
    warning: '模型输出不符合回复 contract，状态已按 continue 处理。'
  })
}
