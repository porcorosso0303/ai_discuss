import type {
  KimiRoleConfig,
  ModelCapability,
  ProviderCapabilities,
  RoleConfig
} from '../../../shared/domain'
import { kimiRoleConfigSchema, providerCapabilitiesSchema } from '../../../shared/schemas'
import {
  HttpResponseError,
  fetchJson,
  streamSse,
  type FetchLike
} from '../http/http-client'
import { HttpNetworkError, HttpStatusError } from '../http/retry-policy'
import {
  ProviderNonRetryableError,
  ProviderRetryableError,
  type Provider,
  type ProviderChunk,
  type ProviderReplyRequest
} from '../provider'
import { kimiChatChunkSchema, kimiModelsResponseSchema } from './kimi-schema'

export interface KimiProviderDependencies {
  getApiKey: (config: KimiRoleConfig) => string | Promise<string>
  fetch?: FetchLike
}

const endpoint = (baseUrl: string, path: string): string =>
  `${baseUrl.replace(/\/+$/, '')}/${path}`

const capabilityKey = (baseUrl: string, model: string, roleId: string): string =>
  `${roleId}\n${baseUrl.replace(/\/+$/, '')}\n${model}`

const standardSampling: ModelCapability['samplingParameters'] = [
  { name: 'temperature', min: 0, max: 1 },
  { name: 'topP', min: 0, max: 1 },
  { name: 'frequencyPenalty', min: -2, max: 2 },
  { name: 'presencePenalty', min: -2, max: 2 }
]

const isK3 = (model: string): boolean => /^kimi-k3(?:$|-)/.test(model)
const isK27Code = (model: string): boolean => /^kimi-k2\.7-code(?:$|-)/.test(model)
const isK26 = (model: string): boolean => /^kimi-k2\.6(?:$|-)/.test(model)
const isK25 = (model: string): boolean => /^kimi-k2\.5(?:$|-)/.test(model)
const MAX_VISIBLE_CONTENT_CHARS = 201_000

const debateReplyJsonSchema = {
  type: 'object',
  properties: {
    speech: { type: 'string', minLength: 1, maxLength: 200_000 },
    status: { type: 'string', enum: ['continue', 'concede', 'agree'] }
  },
  required: ['speech', 'status'],
  additionalProperties: false
} as const

const modelCapability = (model: {
  id: string
  context_length?: number
  supports_reasoning: boolean
}): ModelCapability => {
  const knownFixedSampling = isK3(model.id) || isK27Code(model.id) || isK26(model.id) || isK25(model.id)
  const thinking = !model.supports_reasoning
    ? null
    : isK27Code(model.id) || isK26(model.id)
      ? { default: true, keepSupported: true }
      : isK25(model.id) || !isK3(model.id)
        ? { default: true, keepSupported: false }
        : null

  const capability: ModelCapability = {
    id: model.id,
    reasoningEfforts: model.supports_reasoning && isK3(model.id) ? ['low', 'high', 'max'] : [],
    thinking,
    samplingParameters: knownFixedSampling ? [] : standardSampling,
    structuredOutputModes: ['json-schema', 'json-object']
  }
  if (model.context_length !== undefined) capability.contextLength = model.context_length
  return capability
}

const isAbort = (error: unknown, signal?: AbortSignal): boolean =>
  (error instanceof Error && error.name === 'AbortError') ||
  (signal?.aborted === true && error === signal.reason)

const normalizeError = (error: unknown, signal?: AbortSignal): Error => {
  if (isAbort(error, signal)) return error as Error
  if (
    error instanceof HttpNetworkError ||
    (error instanceof HttpStatusError &&
      (error.status === 429 || (error.status >= 500 && error.status <= 599)))
  ) {
    return new ProviderRetryableError('Kimi API request failed temporarily')
  }
  if (error instanceof ProviderRetryableError || error instanceof ProviderNonRetryableError) {
    return error
  }
  if (error instanceof HttpStatusError || error instanceof HttpResponseError) {
    return new ProviderNonRetryableError('Kimi API rejected the request or response')
  }
  return new ProviderNonRetryableError('Kimi API response did not match the expected contract')
}

const isOfficialBase = (baseUrl: string): boolean => {
  const url = new URL(baseUrl)
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  return (
    url.protocol === 'https:' &&
    url.port === '' &&
    (hostname === 'api.moonshot.cn' || hostname === 'api.moonshot.ai') &&
    url.pathname.replace(/\/+$/, '') === '/v1'
  )
}

const finishReason = (value: string): 'stop' | 'length' | 'refusal' | undefined => {
  if (value === 'stop') return 'stop'
  if (value === 'length') return 'length'
  if (value === 'content_filter' || value === 'refusal') return 'refusal'
  return undefined
}

const requireApiKey = (value: string): string => {
  if (value.trim() === '') {
    throw new ProviderNonRetryableError('A Kimi API key is required')
  }
  return value
}

export class KimiProvider implements Provider {
  private readonly discoveredCapabilitiesByRole = new Map<
    string,
    ReadonlyMap<string, ModelCapability>
  >()

  constructor(private readonly dependencies: KimiProviderDependencies) {}

  async discover(config: RoleConfig, signal?: AbortSignal): Promise<ProviderCapabilities> {
    let kimiConfig: KimiRoleConfig
    let apiKey: string
    try {
      kimiConfig = kimiRoleConfigSchema.parse(config)
      apiKey = requireApiKey(await this.dependencies.getApiKey(kimiConfig))
    } catch (error) {
      throw normalizeError(error, signal)
    }

    let models: ModelCapability[]
    try {
      const raw = await fetchJson(
        endpoint(kimiConfig.baseUrl, 'models'),
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}` },
          signal
        },
        { fetch: this.dependencies.fetch }
      )
      const response = kimiModelsResponseSchema.parse(raw)
      models = response.data.map(modelCapability)
    } catch (error) {
      if (isAbort(error, signal)) throw error
      if (isOfficialBase(kimiConfig.baseUrl)) throw normalizeError(error, signal)
      models = [
        modelCapability({
          id: kimiConfig.model,
          supports_reasoning:
            isK3(kimiConfig.model) ||
            isK27Code(kimiConfig.model) ||
            isK26(kimiConfig.model) ||
            isK25(kimiConfig.model)
        })
      ]
    }

    const roleCapabilities = new Map<string, ModelCapability>()
    for (const capability of models) {
      roleCapabilities.set(
        capabilityKey(kimiConfig.baseUrl, capability.id, kimiConfig.roleId),
        capability
      )
    }
    this.discoveredCapabilitiesByRole.set(kimiConfig.roleId, roleCapabilities)

    return providerCapabilitiesSchema.parse({
      provider: 'kimi',
      models,
      defaultModel: models.some(({ id }) => id === kimiConfig.model)
        ? kimiConfig.model
        : models[0]?.id
    })
  }

  async *streamReply(
    request: ProviderReplyRequest,
    signal: AbortSignal
  ): AsyncIterable<ProviderChunk> {
    let config: KimiRoleConfig
    let apiKey: string
    try {
      config = kimiRoleConfigSchema.parse(request.role)
      const capability = this.discoveredCapabilitiesByRole
        .get(config.roleId)
        ?.get(capabilityKey(config.baseUrl, config.model, config.roleId))
      if (
        capability !== undefined &&
        ((capability.thinking === null &&
          (config.thinking !== undefined || config.thinkingKeep !== undefined)) ||
          (config.thinkingKeep === 'all' &&
            capability.thinking?.keepSupported !== true) ||
          (config.effort !== undefined &&
            !capability.reasoningEfforts.includes(config.effort)))
      ) {
        throw new ProviderNonRetryableError(
          'The selected Kimi model does not support the configured reasoning controls'
        )
      }
      apiKey = requireApiKey(await this.dependencies.getApiKey(config))
    } catch (error) {
      throw normalizeError(error, signal)
    }

    const body: Record<string, unknown> = {
      model: config.model,
      messages: [
        { role: 'system', content: request.view.system },
        ...request.view.messages
      ],
      max_completion_tokens: config.maxCompletionTokens,
      stream: true,
      stream_options: { include_usage: true },
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'debate_reply',
          strict: true,
          schema: debateReplyJsonSchema
        }
      }
    }

    if (isK3(config.model) && config.effort !== undefined) {
      body.reasoning_effort = config.effort
    } else if (isK26(config.model) || isK25(config.model)) {
      if (config.thinking !== undefined || config.thinkingKeep === 'all') {
        const thinking: Record<string, unknown> = {
          type: config.thinking === false ? 'disabled' : 'enabled'
        }
        if (config.thinkingKeep === 'all') thinking.keep = 'all'
        body.thinking = thinking
      }
    } else if (!isK27Code(config.model)) {
      if (config.effort !== undefined) body.reasoning_effort = config.effort
      if (config.thinking !== undefined || config.thinkingKeep === 'all') {
        const thinking: Record<string, unknown> = {
          type: config.thinking === false ? 'disabled' : 'enabled'
        }
        if (config.thinkingKeep === 'all') thinking.keep = 'all'
        body.thinking = thinking
      }
      if (config.sampling !== undefined) {
        if (config.sampling.temperature !== undefined) body.temperature = config.sampling.temperature
        if (config.sampling.topP !== undefined) body.top_p = config.sampling.topP
        if (config.sampling.frequencyPenalty !== undefined) {
          body.frequency_penalty = config.sampling.frequencyPenalty
        }
        if (config.sampling.presencePenalty !== undefined) {
          body.presence_penalty = config.sampling.presencePenalty
        }
      }
    }

    let completed = false
    let visibleContentChars = 0
    try {
      for await (const event of streamSse(
        endpoint(config.baseUrl, 'chat/completions'),
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream'
          },
          body: JSON.stringify(body),
          signal
        },
        { fetch: this.dependencies.fetch }
      )) {
        let raw: unknown
        try {
          raw = JSON.parse(event.data)
        } catch {
          throw new ProviderNonRetryableError('Kimi streaming response contained invalid JSON')
        }
        const chunk = kimiChatChunkSchema.parse(raw)
        if (completed && chunk.choices.length > 0) {
          throw new ProviderNonRetryableError(
            'Kimi streaming response continued after completion'
          )
        }
        for (const choice of chunk.choices) {
          if (choice.delta.content !== undefined && choice.delta.content !== '') {
            const nextVisibleContentChars = visibleContentChars + choice.delta.content.length
            if (nextVisibleContentChars > MAX_VISIBLE_CONTENT_CHARS) {
              throw new ProviderNonRetryableError(
                'Kimi visible response exceeded the debate reply limit'
              )
            }
            visibleContentChars = nextVisibleContentChars
            yield { type: 'content', content: choice.delta.content }
          }
        }
        if (chunk.usage !== undefined && chunk.usage !== null) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
              totalTokens: chunk.usage.total_tokens,
              ...(chunk.usage.cached_tokens === undefined
                ? {}
                : { cacheReadTokens: chunk.usage.cached_tokens })
            }
          }
        }
        for (const choice of chunk.choices) {
          if (choice.finish_reason !== null) {
            completed = true
            const mapped = finishReason(choice.finish_reason)
            yield mapped === undefined
              ? { type: 'final' }
              : { type: 'final', finishReason: mapped }
          }
        }
      }
      if (!completed) {
        throw new ProviderRetryableError('Kimi streaming response ended before completion')
      }
    } catch (error) {
      throw normalizeError(error, signal)
    }
  }
}
