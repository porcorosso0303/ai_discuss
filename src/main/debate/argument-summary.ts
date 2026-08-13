import { z } from 'zod'

export const ARGUMENT_SUMMARY_ITEM_MAX_LENGTH = 4000
export const ARGUMENT_SUMMARY_CONTENT_MAX_LENGTH = 32_000

const summaryItemSchema = z.string().trim().min(1).max(ARGUMENT_SUMMARY_ITEM_MAX_LENGTH)

export const argumentSummarySchema = z
  .strictObject({
    claims: z.array(summaryItemSchema).max(100),
    evidence: z.array(summaryItemSchema).max(100),
    concessions: z.array(summaryItemSchema).max(100),
    disputes: z.array(summaryItemSchema).max(100)
  })
  .refine(
    ({ claims, evidence, concessions, disputes }) =>
      claims.length + evidence.length + concessions.length + disputes.length > 0,
    { message: 'argument summary must not be empty' }
  )
  .refine(
    ({ claims, evidence, concessions, disputes }) =>
      [...claims, ...evidence, ...concessions, ...disputes].reduce(
        (total, item) => total + item.length,
        0
      ) <= ARGUMENT_SUMMARY_CONTENT_MAX_LENGTH,
    { message: 'argument summary exceeds the aggregate content limit' }
  )

export const argumentSummaryMetadataSchema = z
  .strictObject({
    id: z.string().trim().min(1).max(200),
    createdAt: z.string().datetime({ offset: true }),
    coveredFromTurn: z.number().int().positive(),
    coveredThroughTurn: z.number().int().positive(),
    provider: z.string().trim().min(1).max(100),
    model: z.string().trim().min(1).max(200),
    source: z.enum(['provider', 'fallback']),
    summary: argumentSummarySchema,
    warning: z.string().trim().min(1).max(4000).optional()
  })
  .refine(({ coveredFromTurn, coveredThroughTurn }) => coveredFromTurn <= coveredThroughTurn, {
    message: 'coveredFromTurn must not exceed coveredThroughTurn'
  })

export type ArgumentSummary = z.output<typeof argumentSummarySchema>
export type ArgumentSummaryMetadata = z.output<typeof argumentSummaryMetadataSchema>
