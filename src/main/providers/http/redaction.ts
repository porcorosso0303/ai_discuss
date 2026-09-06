export const REDACTED = '[REDACTED]'
const CIRCULAR = '[Circular]'
const DEFAULT_MAX_STRING_LENGTH = 4_096

export interface RedactStringOptions {
  maxLength?: number
}

export interface RedactLoggingOptions {
  maxStringLength?: number
}

export const normalizeCredentialKey = (key: string): string =>
  key
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{Separator}\p{Format}\p{Punctuation}]/gu, '')

const SENSITIVE_KEYS = new Set([
  'authorization',
  'apikey',
  'xapikey',
  'token',
  'accesstoken',
  'refreshtoken',
  'logintoken',
  'codexlogintoken',
  'idtoken',
  'sessiontoken'
])

export const isSensitiveCredentialKey = (key: string): boolean => {
  const normalized = normalizeCredentialKey(key)
  const words = key
    .normalize('NFKC')
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .replace(/[\p{Separator}\p{Format}\p{Punctuation}]+/gu, ' ')
    .toLowerCase()
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
  const hasWord = (word: string): boolean => words.includes(word)
  const hasPair = (left: string, right: string): boolean =>
    words.some((word, index) => word === left && words[index + 1] === right)
  return (
    SENSITIVE_KEYS.has(normalized) ||
    hasWord('authorization') ||
    hasWord('secret') ||
    hasWord('credential') ||
    hasWord('password') ||
    hasWord('passphrase') ||
    hasWord('token') ||
    hasPair('api', 'key') ||
    hasPair('private', 'key') ||
    hasPair('access', 'key') ||
    normalized.endsWith('apikey') ||
    normalized.endsWith('secret') ||
    normalized.endsWith('credential') ||
    normalized.endsWith('password') ||
    normalized.endsWith('passphrase') ||
    normalized.endsWith('privatekey') ||
    normalized.endsWith('accesskey') ||
    normalized.endsWith('authorization') ||
    normalized.endsWith('token')
  )
}

const maxLength = (value: number | undefined, fallback: number): number => {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError('Redacted string length must be a positive safe integer')
  }
  return resolved
}

const truncate = (value: string, maximum: number): string => {
  if (value.length <= maximum) return value
  const suffix = '…[TRUNCATED]'
  if (maximum <= suffix.length) return suffix.slice(0, maximum)
  return `${value.slice(0, maximum - suffix.length)}${suffix}`
}

const SCAN_LOOKAHEAD = 1_024
const MAX_LABEL_LENGTH = 256
const LABEL_BOUNDARY = /[\p{Control},;&?{}\[\]()"':=]/u
const WHITESPACE = /\s/u
const WORD_CHARACTER = /[\p{L}\p{N}_]/u

const labelBefore = (value: string, separatorIndex: number): string => {
  let start = separatorIndex
  if (start > 1 && (value[start - 1] === '"' || value[start - 1] === "'")) {
    const quote = value[start - 1]
    let quotedStart = start - 2
    let inspected = 1
    while (quotedStart >= 0 && inspected <= MAX_LABEL_LENGTH) {
      if (value[quotedStart] === quote) {
        return value.slice(quotedStart + 1, start - 1).trim()
      }
      quotedStart -= 1
      inspected += 1
    }
  }
  let inspected = 0
  while (start > 0 && inspected < MAX_LABEL_LENGTH) {
    const character = value[start - 1]
    if (LABEL_BOUNDARY.test(character)) break
    start -= 1
    inspected += 1
  }
  return value.slice(start, separatorIndex).trim()
}

const isWordBoundary = (value: string, index: number): boolean =>
  index < 0 || index >= value.length || !WORD_CHARACTER.test(value[index])

interface ScannedValue {
  replacement: string
  nextIndex: number
}

const startsWithRedactionMarker = (value: string, start: number): boolean =>
  value.slice(start, start + REDACTED.length).toUpperCase() === REDACTED

const isUnquotedValueDelimiter = (
  character: string | undefined,
  consumeSpaces: boolean
): boolean =>
  character === undefined ||
  character === '\r' ||
  character === '\n' ||
  character === ',' ||
  character === ';' ||
  character === '&' ||
  character === '}' ||
  character === ']' ||
  (!consumeSpaces && WHITESPACE.test(character))

const scanCredentialValue = (
  value: string,
  start: number,
  consumeSpaces: boolean
): ScannedValue => {
  if (start >= value.length) return { replacement: REDACTED, nextIndex: start }

  const quote = value[start]
  if (quote === '"' || quote === "'") {
    const markerStart = start + 1
    const markerEnd = markerStart + REDACTED.length
    if (startsWithRedactionMarker(value, markerStart) && value[markerEnd] === quote) {
      return {
        replacement: `${quote}${REDACTED}${quote}`,
        nextIndex: markerEnd + 1
      }
    }
    let index = start + 1
    let escaped = false
    while (index < value.length) {
      const character = value[index]
      if (!escaped && character === quote) {
        return {
          replacement: `${quote}${REDACTED}${quote}`,
          nextIndex: index + 1
        }
      }
      if (!escaped && (character === '\r' || character === '\n')) break
      if (character === '\\') {
        escaped = !escaped
      } else {
        escaped = false
      }
      index += 1
    }
    return { replacement: `${quote}${REDACTED}`, nextIndex: index }
  }

  const markerEnd = start + REDACTED.length
  const startsWithMarker = startsWithRedactionMarker(value, start)
  if (
    startsWithMarker &&
    isUnquotedValueDelimiter(value[markerEnd], consumeSpaces)
  ) {
    return { replacement: REDACTED, nextIndex: markerEnd }
  }

  let index = startsWithMarker ? markerEnd : start
  while (index < value.length) {
    const character = value[index]
    if (
      character === '\r' ||
      character === '\n' ||
      character === ',' ||
      character === ';' ||
      character === '&' ||
      character === '"' ||
      character === "'" ||
      character === '}' ||
      character === ']' ||
      (!consumeSpaces && WHITESPACE.test(character))
    ) {
      break
    }
    index += 1
  }
  return { replacement: REDACTED, nextIndex: index }
}

const appendTruncationMarker = (value: string, maximum: number): string => {
  const suffix = '…[TRUNCATED]'
  if (value.length + suffix.length <= maximum) return `${value}${suffix}`
  return truncate(value.length > maximum ? value : `${value}${suffix}`, maximum)
}

const scanRedactedPrefix = (value: string): string => {
  const output: string[] = []
  let segmentStart = 0
  let index = 0

  while (index < value.length) {
    const character = value[index]
    if (character === ':' || character === '=') {
      const label = labelBefore(value, index)
      if (label && isSensitiveCredentialKey(label)) {
        let valueStart = index + 1
        while (valueStart < value.length && WHITESPACE.test(value[valueStart])) {
          valueStart += 1
        }
        const scanned = scanCredentialValue(
          value,
          valueStart,
          normalizeCredentialKey(label).includes('authorization')
        )
        output.push(value.slice(segmentStart, valueStart), scanned.replacement)
        segmentStart = scanned.nextIndex
        index = scanned.nextIndex
        continue
      }
    }

    if (
      value.slice(index, index + 6).toLowerCase() === 'bearer' &&
      isWordBoundary(value, index - 1) &&
      isWordBoundary(value, index + 6)
    ) {
      let valueStart = index + 6
      if (valueStart < value.length && WHITESPACE.test(value[valueStart])) {
        while (valueStart < value.length && WHITESPACE.test(value[valueStart])) {
          valueStart += 1
        }
        const scanned = scanCredentialValue(value, valueStart, false)
        output.push(
          value.slice(segmentStart, index),
          'Bearer',
          value.slice(index + 6, valueStart),
          scanned.replacement
        )
        segmentStart = scanned.nextIndex
        index = scanned.nextIndex
        continue
      }
    }
    index += 1
  }

  output.push(value.slice(segmentStart))
  return output.join('')
}

export const redactString = (
  input: string,
  options: RedactStringOptions = {}
): string => {
  const maximum = maxLength(options.maxLength, DEFAULT_MAX_STRING_LENGTH)
  const scanLimit = Math.min(input.length, maximum + SCAN_LOOKAHEAD)
  const redacted = scanRedactedPrefix(input.slice(0, scanLimit).normalize('NFKC'))
  return scanLimit < input.length
    ? appendTruncationMarker(redacted, maximum)
    : truncate(redacted, maximum)
}

const redactValue = (
  value: unknown,
  maximum: number,
  ancestors: WeakSet<object>
): unknown => {
  if (typeof value === 'string') return redactString(value, { maxLength: maximum })
  if (
    value === null ||
    value === undefined ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value
  }
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'symbol') return value.toString()
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`

  if (ancestors.has(value)) return CIRCULAR
  ancestors.add(value)
  try {
    if (typeof Headers !== 'undefined' && value instanceof Headers) {
      const headers: Record<string, unknown> = {}
      value.forEach((headerValue, key) => {
        headers[key] = isSensitiveCredentialKey(key)
          ? REDACTED
          : redactString(headerValue, { maxLength: maximum })
      })
      return headers
    }

    if (value instanceof Date) return value.toISOString()

    if (value instanceof Error) {
      const result: Record<string, unknown> = {
        name: redactString(value.name, { maxLength: maximum }),
        message: redactString(value.message, { maxLength: maximum })
      }
      if (value.stack !== undefined) {
        result.stack = redactString(value.stack, { maxLength: maximum })
      }
      if (value.cause !== undefined) {
        result.cause = redactValue(value.cause, maximum, ancestors)
      }
      for (const [key, nested] of Object.entries(value)) {
        result[key] = isSensitiveCredentialKey(key)
          ? REDACTED
          : redactValue(nested, maximum, ancestors)
      }
      return result
    }

    if (Array.isArray(value)) {
      return value.map((nested) => redactValue(nested, maximum, ancestors))
    }

    const result: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value)) {
      result[key] = isSensitiveCredentialKey(key)
        ? REDACTED
        : redactValue(nested, maximum, ancestors)
    }
    return result
  } finally {
    ancestors.delete(value)
  }
}

export const redactForLogging = (
  value: unknown,
  options: RedactLoggingOptions = {}
): unknown => {
  const maximum = maxLength(options.maxStringLength, DEFAULT_MAX_STRING_LENGTH)
  return redactValue(value, maximum, new WeakSet())
}
