import type { DebateReply, DebateReplyStatus } from '../../shared/domain'
import { debateReplySchema } from '../../shared/schemas'

export const EMPTY_SPEECH_PLACEHOLDER = '（模型未返回可显示的发言）'

export type ReplyParseSource = 'json' | 'tag' | 'fallback'

export interface ParsedDebateReply extends DebateReply {
  source: ReplyParseSource
  warning?: string
}

const MAX_SPEECH_LENGTH = 200_000
const outerJsonFencePattern = /^\s*```(?:json)?[ \t]*\r?\n?([\s\S]*?)\r?\n?```\s*$/i
const trailingStatusPattern =
  /\s*<debate-status>(continue|concede|agree)<\/debate-status>\s*$/

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

const decodeJsonStringContent = (content: string): string => {
  try {
    return JSON.parse(`"${content}"`) as string
  } catch {
    return content
      .replaceAll('\\n', '\n')
      .replaceAll('\\r', '\r')
      .replaceAll('\\t', '\t')
      .replaceAll('\\"', '"')
      .replaceAll('\\\\', '\\')
  }
}

const recoverJsonSpeech = (input: string, parsed: unknown): string | undefined => {
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'speech' in parsed &&
    typeof parsed.speech === 'string'
  ) {
    return parsed.speech
  }

  const speechStart = /"speech"\s*:\s*"/.exec(input)

  if (speechStart === null) {
    return undefined
  }

  const valueStart = speechStart.index + speechStart[0].length
  let escaped = false
  let encodedSpeech = ''

  for (let index = valueStart; index < input.length; index += 1) {
    const character = input[index]

    if (character === '"' && !escaped) {
      return decodeJsonStringContent(encodedSpeech)
    }

    encodedSpeech += character

    if (character === '\\' && !escaped) {
      escaped = true
    } else {
      escaped = false
    }
  }

  return decodeJsonStringContent(encodedSpeech)
}

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

  const recoveredSpeech = recoverJsonSpeech(candidate, parsedJson)
  const looksLikeStructuredOutput = candidate.startsWith('{') || candidate.startsWith('[')
  const fallbackSpeech = recoveredSpeech ?? (looksLikeStructuredOutput ? '' : candidate)

  return finalizeReply({
    speech: fallbackSpeech,
    status: 'continue',
    source: 'fallback',
    warning: '模型输出不符合回复 contract，状态已按 continue 处理。'
  })
}
