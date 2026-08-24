export const REDACTED = '[REDACTED]'
const CIRCULAR = '[Circular]'
const DEFAULT_MAX_STRING_LENGTH = 4_096

export interface RedactStringOptions {
  maxLength?: number
}

export interface RedactLoggingOptions {
  maxStringLength?: number
}

const SENSITIVE_KEY_SOURCE =
  'authorization|x-api-key|api-key|api_key|apiKey|access[_-]?token|accessToken|refresh[_-]?token|refreshToken|login[_-]?token|loginToken|codex[_-]?login[_-]?token|codexLoginToken|id[_-]?token|idToken|session[_-]?token|sessionToken|client[_-]?secret|private[_-]?key|access[_-]?key|password|passphrase|credential|secret|token'

const JSON_CREDENTIAL = new RegExp(
  `(["'])(${SENSITIVE_KEY_SOURCE})\\1(\\s*:\\s*)("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`,
  'gi'
)
const AUTHORIZATION_VALUE = new RegExp(
  '\\bauthorization\\b(\\s*[:=]\\s*)(?:"[^"\\r\\n]*"|\'[^\'\\r\\n]*\'|[^\\r\\n,;&"\'\\\\}\\]]+)',
  'gi'
)
const OTHER_CREDENTIAL = new RegExp(
  `\\b(?:${SENSITIVE_KEY_SOURCE.replace('authorization|', '')})\\b(\\s*[:=]\\s*)(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s,;&"'\\\\}\\]]+)`,
  'gi'
)
const BEARER_VALUE = /\bbearer\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&]+)/gi

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

const FLEXIBLE_SEPARATOR = '[\\p{Separator}\\p{Format}\\p{Punctuation}]*'
const FLEXIBLE_SENSITIVE_LABELS = [
  'authorization',
  'xapikey',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'logintoken',
  'codexlogintoken',
  'idtoken',
  'sessiontoken',
  'clientsecret',
  'privatekey',
  'accesskey',
  'password',
  'passphrase',
  'credential',
  'secret',
  'token'
]
  .sort((left, right) => right.length - left.length)
  .map((label) => [...label].join(FLEXIBLE_SEPARATOR))
  .join('|')

const FLEXIBLE_CREDENTIAL = new RegExp(
  `(?<![\\p{L}\\p{N}])(${FLEXIBLE_SENSITIVE_LABELS})(\\s*[:=]\\s*)(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s,;&"'\\\\}\\]]+)`,
  'giu'
)

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

export const redactString = (
  input: string,
  options: RedactStringOptions = {}
): string => {
  const maximum = maxLength(options.maxLength, DEFAULT_MAX_STRING_LENGTH)
  const redacted = input
    .normalize('NFKC')
    .replace(JSON_CREDENTIAL, (_match, quote, key, separator, quotedValue) => {
      const valueQuote = quotedValue[0]
      return `${quote}${key}${quote}${separator}${valueQuote}${REDACTED}${valueQuote}`
    })
    .replace(AUTHORIZATION_VALUE, (match, separator) =>
      match.toUpperCase().includes('[REDACTED')
        ? match
        : `authorization${separator}${REDACTED}`
    )
    .replace(OTHER_CREDENTIAL, (match, separator) => {
      if (match.toUpperCase().includes('[REDACTED')) return match
      const keyLength = match.indexOf(separator)
      return `${match.slice(0, keyLength)}${separator}${REDACTED}`
    })
    .replace(BEARER_VALUE, `Bearer ${REDACTED}`)
    .replace(FLEXIBLE_CREDENTIAL, (match, key, separator) =>
      match.includes('[REDACTED') ? match : `${key}${separator}${REDACTED}`
    )

  return truncate(redacted, maximum)
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
