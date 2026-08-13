import { describe, expect, it } from 'vitest'

import {
  REDACTED,
  redactForLogging,
  redactString
} from '../../../src/main/providers/http/redaction'

describe('redactString', () => {
  it.each([
    ['Authorization: Bearer sk-auth-secret', 'sk-auth-secret'],
    ['authorization: basic base64-secret', 'base64-secret'],
    ['Bearer standalone-secret', 'standalone-secret'],
    ['X-API-Key: x-secret', 'x-secret'],
    ['api-key=hyphen-secret', 'hyphen-secret'],
    ['api_key: underscore-secret', 'underscore-secret'],
    ['apiKey=camel-secret', 'camel-secret'],
    ['access_token=access-secret', 'access-secret'],
    ['refreshToken: refresh-secret', 'refresh-secret'],
    ['login_token=login-secret', 'login-secret'],
    ['codexLoginToken=codex-secret', 'codex-secret'],
    ['"token":"json-secret"', 'json-secret']
  ])('redacts sensitive credential formats in %s', (input, secret) => {
    const result = redactString(input)

    expect(result).toContain(REDACTED)
    expect(result).not.toContain(secret)
  })

  it('redacts sensitive URL query parameters and preserves ordinary diagnostics', () => {
    const result = redactString(
      'GET https://example.test/v1/models?api_key=url-secret&authorization=Bearer%20url-auth&model=gpt-test'
    )

    expect(result).not.toContain('url-secret')
    expect(result).not.toContain('url-auth')
    expect(result).toContain('model=gpt-test')
    expect(result).toContain('https://example.test/v1/models')
  })

  it('redacts quoted JSON credential values containing apostrophes and escaped quotes', () => {
    const result = redactString(
      '{"token":"abc\\"def\'ghi","model":"diagnostic-model"}'
    )

    expect(result).not.toContain('abc')
    expect(result).not.toContain('ghi')
    expect(result).toContain('"token":"[REDACTED]"')
    expect(result).toContain('diagnostic-model')
  })

  it('does not erase ordinary words that merely contain key or token fragments', () => {
    const input = 'The monkey uses a tokenizer and reports completion_tokens=42.'

    expect(redactString(input)).toBe(input)
  })

  it('bounds visible log strings after redacting secrets', () => {
    const secret = 'never-visible'
    const result = redactString(`${'x'.repeat(200)}\nAuthorization: Bearer ${secret}`, {
      maxLength: 48
    })

    expect(result.length).toBeLessThanOrEqual(48)
    expect(result).not.toContain(secret)
    expect(result).toMatch(/TRUNCATED/)
  })
})

describe('redactForLogging', () => {
  it('deeply clones nested objects and arrays without mutating the input', () => {
    const input = {
      request: {
        apiKey: 'object-secret',
        headers: { Authorization: 'Bearer header-secret', Accept: 'application/json' }
      },
      values: [{ access_token: 'array-secret', model: 'deepseek-chat' }]
    }

    const result = redactForLogging(input)
    const serialized = JSON.stringify(result)

    expect(serialized).not.toContain('object-secret')
    expect(serialized).not.toContain('header-secret')
    expect(serialized).not.toContain('array-secret')
    expect(serialized).toContain('application/json')
    expect(serialized).toContain('deepseek-chat')
    expect(input.request.apiKey).toBe('object-secret')
    expect(input.request.headers.Authorization).toBe('Bearer header-secret')
  })

  it('redacts Headers instances while retaining non-sensitive header fields', () => {
    const headers = new Headers({
      Authorization: 'Bearer headers-secret',
      'X-API-Key': 'key-secret',
      'Content-Type': 'application/json'
    })

    const serialized = JSON.stringify(redactForLogging(headers))

    expect(serialized).not.toContain('headers-secret')
    expect(serialized).not.toContain('key-secret')
    expect(serialized).toContain('content-type')
    expect(serialized).toContain('application/json')
  })

  it('redacts and bounds Error messages, stacks, causes, and custom fields', () => {
    const error = new Error('Authorization: Bearer error-message-secret', {
      cause: new Error('api_key=cause-secret')
    }) as Error & { accessToken?: string }
    error.stack = `Error: Bearer stack-secret\n${'frame\n'.repeat(100)}`
    error.accessToken = 'custom-secret'

    const serialized = JSON.stringify(redactForLogging(error, { maxStringLength: 128 }))

    for (const secret of [
      'error-message-secret',
      'cause-secret',
      'stack-secret',
      'custom-secret'
    ]) {
      expect(serialized).not.toContain(secret)
    }
    expect(serialized).toContain('Error')
    expect(serialized).toContain(REDACTED)
    expect(serialized.length).toBeLessThan(1_000)
  })

  it('is cycle-safe and produces a JSON-serializable diagnostic structure', () => {
    const input: { name: string; token: string; self?: unknown } = {
      name: 'cyclic request',
      token: 'cycle-secret'
    }
    input.self = input

    const result = redactForLogging(input)

    expect(() => JSON.stringify(result)).not.toThrow()
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('cycle-secret')
    expect(serialized).toContain('[Circular]')
    expect(serialized).toContain('cyclic request')
  })
})
