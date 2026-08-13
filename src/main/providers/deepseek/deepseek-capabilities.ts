import { z } from 'zod'

import type { ModelCapability } from '../../../shared/domain'

// Current V4 model table, last verified against the official model/pricing page.
export const DEEPSEEK_CAPABILITIES_DOCUMENT_DATE = '2026-08-13' as const
export const DEEPSEEK_CAPABILITIES_SOURCE_URL =
  'https://api-docs.deepseek.com/quick_start/pricing/' as const
export const DEEPSEEK_CHAT_CONTRACT_SOURCE_URL =
  'https://api-docs.deepseek.com/api/create-chat-completion/' as const

const boundedText = z.string().trim().min(1).max(200)

export const deepSeekModelsResponseSchema = z.object({
  object: z.literal('list'),
  data: z
    .array(
      z.object({
        id: boundedText,
        object: z.literal('model'),
        owned_by: boundedText
      })
    )
    .max(200)
})

const v4Sampling: ModelCapability['samplingParameters'] = [
  { name: 'temperature', min: 0, max: 2, default: 1 },
  { name: 'topP', min: 0, max: 1, default: 1 }
]

const currentV4Capability = (id: string): ModelCapability => ({
  id,
  reasoningEfforts: ['low', 'high', 'max'],
  contextLength: 1_000_000,
  maxOutputTokens: 384_000,
  thinking: { default: true, keepSupported: false },
  samplingParameters: v4Sampling.map((parameter) => ({ ...parameter })),
  structuredOutputModes: ['json-object']
})

export const deepSeekModelCapability = (id: string): ModelCapability =>
  id === 'deepseek-v4-flash' || id === 'deepseek-v4-pro'
    ? currentV4Capability(id)
    : {
        id,
        reasoningEfforts: [],
        thinking: null,
        samplingParameters: [],
        structuredOutputModes: []
      }
