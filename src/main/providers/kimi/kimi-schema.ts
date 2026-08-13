import { z } from 'zod'

const positiveInteger = z.number().int().positive().max(10_000_000)

export const kimiModelSchema = z.object({
  id: z.string().trim().min(1).max(200),
  context_length: positiveInteger,
  supports_reasoning: z.boolean()
})

export const kimiModelsResponseSchema = z.object({
  object: z.literal('list'),
  data: z.array(kimiModelSchema).max(200)
})

const boundedTokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const kimiChatChunkSchema = z.object({
  choices: z
    .array(
      z.object({
        index: z.literal(0),
        delta: z.object({
          content: z.string().max(1024 * 1024).optional(),
          reasoning_content: z.string().max(1024 * 1024).optional()
        }),
        finish_reason: z
          .enum(['stop', 'length', 'content_filter', 'refusal'])
          .nullable()
      })
    )
    .max(1),
  usage: z
    .object({
      prompt_tokens: boundedTokenCount,
      completion_tokens: boundedTokenCount,
      total_tokens: boundedTokenCount,
      cached_tokens: boundedTokenCount.optional()
    })
    .nullable()
    .optional()
})
