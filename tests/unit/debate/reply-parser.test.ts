import { describe, expect, it } from 'vitest'

import { EMPTY_SPEECH_PLACEHOLDER, parseReply } from '../../../src/main/debate/reply-parser'

describe('parseReply', () => {
  it('strictly parses a valid JSON reply', () => {
    expect(parseReply('{"speech":"这是我的论点。","status":"continue"}')).toEqual({
      speech: '这是我的论点。',
      status: 'continue',
      source: 'json'
    })
  })

  it('parses valid JSON wrapped by one outer markdown JSON fence', () => {
    expect(
      parseReply('```json\n{"speech":"我承认你说服了我。","status":"concede"}\n```')
    ).toEqual({
      speech: '我承认你说服了我。',
      status: 'concede',
      source: 'json'
    })
  })

  it('recognizes and removes a valid status tag only at the end of the body', () => {
    expect(parseReply('我们已经找到共同结论。\n<debate-status>agree</debate-status>')).toEqual({
      speech: '我们已经找到共同结论。',
      status: 'agree',
      source: 'tag'
    })
  })

  it('does not treat a status-like tag inside visible prose as machine status', () => {
    const raw = '例如 <debate-status>concede</debate-status> 只是我引用的字符串，并非认输。'
    const parsed = parseReply(raw)

    expect(parsed.speech).toBe(raw)
    expect(parsed.status).toBe('continue')
    expect(parsed.source).toBe('fallback')
    expect(parsed.warning).toBeDefined()
  })

  it('keeps visible speech but defaults to continue for an invalid JSON status', () => {
    const parsed = parseReply('{"speech":"我仍然坚持这个论点。","status":"victory"}')

    expect(parsed.speech).toBe('我仍然坚持这个论点。')
    expect(parsed.status).toBe('continue')
    expect(parsed.source).toBe('fallback')
    expect(parsed.warning).toBeDefined()
  })

  it('keeps visible speech but defaults to continue when JSON lacks status', () => {
    const parsed = parseReply('{"speech":"缺少状态也不能丢掉正文。"}')

    expect(parsed.speech).toBe('缺少状态也不能丢掉正文。')
    expect(parsed.status).toBe('continue')
    expect(parsed.source).toBe('fallback')
    expect(parsed.warning).toBeDefined()
  })

  it('recovers a complete speech string from truncated JSON', () => {
    const parsed = parseReply('{"speech":"截断前的正文仍应可见。","status":"con')

    expect(parsed.speech).toBe('截断前的正文仍应可见。')
    expect(parsed.status).toBe('continue')
    expect(parsed.source).toBe('fallback')
    expect(parsed.warning).toBeDefined()
  })

  it('does not expose reasoning content from an otherwise invalid JSON object', () => {
    const parsed = parseReply(
      '{"speech":"只显示回答。","status":"agree","reasoning_content":"秘密思考"}'
    )

    expect(parsed.speech).toBe('只显示回答。')
    expect(parsed.speech).not.toContain('秘密思考')
    expect(parsed.status).toBe('continue')
    expect(parsed.source).toBe('fallback')
    expect(parsed.warning).toBeDefined()
  })

  it('returns a safe non-empty placeholder and warning for empty output', () => {
    expect(parseReply('   ')).toEqual({
      speech: EMPTY_SPEECH_PLACEHOLDER,
      status: 'continue',
      source: 'fallback',
      warning: expect.any(String)
    })
  })

  it('keeps a valid pure marker status but replaces its empty speech safely', () => {
    expect(parseReply('<debate-status>agree</debate-status>')).toEqual({
      speech: EMPTY_SPEECH_PLACEHOLDER,
      status: 'agree',
      source: 'tag',
      warning: expect.any(String)
    })
  })

  it('preserves ordinary unstructured visible text as a continue fallback', () => {
    const parsed = parseReply('这是一段没有机器状态的正常辩论正文。')

    expect(parsed).toEqual({
      speech: '这是一段没有机器状态的正常辩论正文。',
      status: 'continue',
      source: 'fallback',
      warning: expect.any(String)
    })
  })
})
