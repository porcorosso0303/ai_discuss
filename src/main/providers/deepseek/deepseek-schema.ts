import { z } from 'zod'

const boundedTokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const deepSeekChatChunkSchema = z.object({
  choices: z
    .array(
      z.object({
        index: z.literal(0),
        delta: z.object({
          content: z.string().max(1024 * 1024).nullable().optional(),
          reasoning_content: z.string().max(1024 * 1024).nullable().optional()
        }),
        finish_reason: z
          .enum([
            'stop',
            'length',
            'content_filter',
            'tool_calls',
            'insufficient_system_resource'
          ])
          .nullable()
      })
    )
    .max(1),
  usage: z
    .object({
      prompt_tokens: boundedTokenCount,
      completion_tokens: boundedTokenCount,
      total_tokens: boundedTokenCount,
      prompt_cache_hit_tokens: boundedTokenCount,
      prompt_cache_miss_tokens: boundedTokenCount,
      completion_tokens_details: z
        .object({ reasoning_tokens: boundedTokenCount.optional() })
        .optional()
    })
    .nullable()
})
