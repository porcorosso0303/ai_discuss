import { describe, expect, it } from 'vitest'

import {
  EMPTY_SPEECH_PLACEHOLDER,
  INVALID_REPLY_PLACEHOLDER,
  parseReply
} from '../../../src/main/debate/reply-parser'

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

  it('does not recover an incomplete top-level speech string', () => {
    const parsed = parseReply('{"speech":"尚未闭合的正文')

    expect(parsed.speech).toBe(INVALID_REPLY_PLACEHOLDER)
    expect(parsed.speech).not.toContain('尚未闭合的正文')
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

  it('never recovers a nested speech field from reasoning content', () => {
    const parsed = parseReply(
      '{"reasoning_content":{"speech":"秘密思考不得显示"},"status":"continue"}'
    )

    expect(parsed.speech).toBe(INVALID_REPLY_PLACEHOLDER)
    expect(parsed.speech).not.toContain('秘密思考不得显示')
    expect(parsed.status).toBe('continue')
    expect(parsed.source).toBe('fallback')
    expect(parsed.warning).toBeDefined()
  })

  it('never recovers a nested speech field from a raw provider payload', () => {
    const parsed = parseReply(
      '{"rawPayload":{"speech":"secret provider payload"},"status":"continue"}'
    )

    expect(parsed.speech).toBe(INVALID_REPLY_PLACEHOLDER)
    expect(parsed.speech).not.toContain('secret provider payload')
    expect(parsed.status).toBe('continue')
    expect(parsed.source).toBe('fallback')
    expect(parsed.warning).toBeDefined()
  })

  it.each([
    '{"metadata":[},"speech":"方括号与花括号不匹配后的泄漏"',
    '{"metadata":{],"speech":"花括号与方括号不匹配后的泄漏"'
  ])('abandons speech recovery after a mismatched JSON closer: %s', (raw) => {
    const parsed = parseReply(raw)

    expect(parsed.speech).toBe(INVALID_REPLY_PLACEHOLDER)
    expect(parsed.speech).not.toContain('泄漏')
    expect(parsed.status).toBe('continue')
    expect(parsed.source).toBe('fallback')
    expect(parsed.warning).toBeDefined()
  })

  it.each([
    '{"speech":"不得在后续结构错配时显示","metadata":[}}',
    '{"speech":"不得在根闭合后有残余时显示"} trailing-data',
    '{"speech":"不得在根闭合后发生栈下溢时显示"}}'
  ])('abandons an early recovered speech when later JSON structure is invalid: %s', (raw) => {
    const parsed = parseReply(raw)

    expect(parsed.speech).toBe(INVALID_REPLY_PLACEHOLDER)
    expect(parsed.speech).not.toContain('不得')
    expect(parsed.status).toBe('continue')
    expect(parsed.source).toBe('fallback')
    expect(parsed.warning).toBeDefined()
  })

  it('recovers a top-level speech after valid nested objects and arrays', () => {
    const parsed = parseReply(
      '{"metadata":{"items":[{"speech":"嵌套内容"}]},"speech":"安全的顶层正文","status":"bro'
    )

    expect(parsed.speech).toBe('安全的顶层正文')
    expect(parsed.speech).not.toContain('嵌套内容')
    expect(parsed.status).toBe('continue')
    expect(parsed.source).toBe('fallback')
    expect(parsed.warning).toBeDefined()
  })

  it('recovers a complete top-level speech when later JSON is truncated but structurally valid so far', () => {
    const parsed = parseReply(
      '{"metadata":[1,{"safe":true}],"speech":"截断前安全正文","status":"con'
    )

    expect(parsed.speech).toBe('截断前安全正文')
    expect(parsed.status).toBe('continue')
    expect(parsed.source).toBe('fallback')
    expect(parsed.warning).toBeDefined()
  })

  it('removes an invalid status marker at the end without accepting its status', () => {
    const parsed = parseReply('正文仍然可见。<debate-status>victory</debate-status>')

    expect(parsed.speech).toBe('正文仍然可见。')
    expect(parsed.status).toBe('continue')
    expect(parsed.source).toBe('fallback')
    expect(parsed.warning).toBeDefined()
  })

  it('removes an unclosed status marker at the end', () => {
    const parsed = parseReply('正文仍然可见。<debate-status>concede')

    expect(parsed.speech).toBe('正文仍然可见。')
    expect(parsed.status).toBe('continue')
    expect(parsed.source).toBe('fallback')
    expect(parsed.warning).toBeDefined()
  })

  it('removes a closing status-tag fragment at the end', () => {
    const parsed = parseReply('正文仍然可见。</debate-status>')

    expect(parsed.speech).toBe('正文仍然可见。')
    expect(parsed.status).toBe('continue')
    expect(parsed.source).toBe('fallback')
    expect(parsed.warning).toBeDefined()
  })

  it.each(['普通正文<', '普通正文</', '普通正文</d', '数学比较：1 <'])(
    'keeps an ordinary short closing-tag-like suffix visible: %s',
    (raw) => {
      const parsed = parseReply(raw)

      expect(parsed.speech).toBe(raw)
      expect(parsed.status).toBe('continue')
      expect(parsed.source).toBe('fallback')
      expect(parsed.warning).toBeDefined()
    }
  )

  it('removes a suffix clearly attributable to a debate-status closing tag', () => {
    const parsed = parseReply('正文仍然可见。</debate-sta')

    expect(parsed.speech).toBe('正文仍然可见。')
    expect(parsed.status).toBe('continue')
    expect(parsed.source).toBe('fallback')
    expect(parsed.warning).toBeDefined()
  })

  it('keeps a complete status tag in the middle as ordinary visible debate text', () => {
    const raw = '正文中的 <debate-status>agree</debate-status> 是引用，后面还有论述。'
    const parsed = parseReply(raw)

    expect(parsed.speech).toBe(raw)
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
