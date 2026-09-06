import type {
  DeepSeekRoleConfig,
  ModelCapability,
  ProviderCapabilities,
  RoleConfig
} from '../../../shared/domain'
import { deepSeekRoleConfigSchema, providerCapabilitiesSchema } from '../../../shared/schemas'
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
import {
  deepSeekModelCapability,
  deepSeekModelsResponseSchema
} from './deepseek-capabilities'
import { deepSeekChatChunkSchema } from './deepseek-schema'

export interface DeepSeekProviderDependencies {
  getApiKey: (
    config: DeepSeekRoleConfig,
    signal?: AbortSignal
  ) => string | Promise<string>
  fetch?: FetchLike
}

const endpoint = (baseUrl: string, path: string): string =>
  `${baseUrl.replace(/\/+$/, '')}/${path}`

const capabilityKey = (baseUrl: string, model: string): string =>
  `${baseUrl.replace(/\/+$/, '')}\n${model}`

const MAX_VISIBLE_CONTENT_CHARS = 201_000

const isAbort = (error: unknown, signal?: AbortSignal): boolean =>
  signal?.aborted === true &&
  (error === signal.reason || (error instanceof Error && error.name === 'AbortError'))

const normalizeError = (error: unknown, signal?: AbortSignal): unknown => {
  if (isAbort(error, signal)) return error
  if (
    error instanceof HttpNetworkError ||
    (error instanceof HttpStatusError &&
      (error.status === 429 || (error.status >= 500 && error.status <= 599)))
  ) {
    return new ProviderRetryableError('DeepSeek API request failed temporarily', {
      ...(error instanceof HttpStatusError && error.retryAfter !== undefined
        ? { retryAfter: error.retryAfter }
        : {})
    })
  }
  if (error instanceof ProviderRetryableError || error instanceof ProviderNonRetryableError) {
    return error
  }
  if (error instanceof HttpStatusError || error instanceof HttpResponseError) {
    return new ProviderNonRetryableError('DeepSeek API rejected the request or response')
  }
  return new ProviderNonRetryableError(
    'DeepSeek API response did not match the expected contract'
  )
}

const isOfficialBase = (baseUrl: string): boolean =>
  new URL(baseUrl).hostname.toLowerCase().replace(/\.$/, '') === 'api.deepseek.com'

const requireApiKey = (value: string): string => {
  if (value.trim() === '') {
    throw new ProviderNonRetryableError('A DeepSeek API key is required')
  }
  return value
}

const resolveApiKey = async (
  getApiKey: DeepSeekProviderDependencies['getApiKey'],
  config: DeepSeekRoleConfig,
  signal?: AbortSignal
): Promise<string> => {
  try {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
    }
    const pending = Promise.resolve(getApiKey(config, signal))
    const value =
      signal === undefined
        ? await pending
        : await new Promise<string>((resolve, reject) => {
            const onAbort = (): void => {
              signal.removeEventListener('abort', onAbort)
              reject(
                signal.reason ??
                  new DOMException('The operation was aborted', 'AbortError')
              )
            }
            signal.addEventListener('abort', onAbort, { once: true })
            pending.then(
              (resolved) => {
                signal.removeEventListener('abort', onAbort)
                resolve(resolved)
              },
              (error: unknown) => {
                signal.removeEventListener('abort', onAbort)
                reject(error)
              }
            )
          })
    return requireApiKey(value)
  } catch (error) {
    if (isAbort(error, signal)) throw error
    throw new ProviderNonRetryableError('The DeepSeek credential could not be read')
  }
}

export class DeepSeekProvider implements Provider {
  private readonly discoveredCapabilitiesByRole = new Map<
    string,
    ReadonlyMap<string, ModelCapability>
  >()

  constructor(private readonly dependencies: DeepSeekProviderDependencies) {}

  async discover(config: RoleConfig, signal?: AbortSignal): Promise<ProviderCapabilities> {
    let deepSeekConfig: DeepSeekRoleConfig
    let apiKey: string
    try {
      deepSeekConfig = deepSeekRoleConfigSchema.parse(config)
      apiKey = await resolveApiKey(this.dependencies.getApiKey, deepSeekConfig, signal)
    } catch (error) {
      throw normalizeError(error, signal)
    }

    let models: ModelCapability[]
    try {
      const raw = await fetchJson(
        endpoint(deepSeekConfig.baseUrl, 'models'),
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}` },
          signal
        },
        { fetch: this.dependencies.fetch }
      )
      const response = deepSeekModelsResponseSchema.parse(raw)
      models = response.data.map(({ id }) => deepSeekModelCapability(id))
    } catch (error) {
      if (isAbort(error, signal)) throw error
      if (isOfficialBase(deepSeekConfig.baseUrl)) throw normalizeError(error, signal)
      models = [deepSeekModelCapability(deepSeekConfig.model)]
    }

    let capabilities: ProviderCapabilities
    try {
      capabilities = providerCapabilitiesSchema.parse({
        provider: 'deepseek',
        models,
        defaultModel: models.some(({ id }) => id === deepSeekConfig.model)
          ? deepSeekConfig.model
          : models[0]?.id
      })
    } catch (error) {
      throw normalizeError(error, signal)
    }

    const replacement = new Map<string, ModelCapability>()
    for (const capability of capabilities.models) {
      replacement.set(capabilityKey(deepSeekConfig.baseUrl, capability.id), capability)
    }
    this.discoveredCapabilitiesByRole.set(deepSeekConfig.roleId, replacement)
    return capabilities
  }

  async *streamReply(
    request: ProviderReplyRequest,
    signal: AbortSignal
  ): AsyncIterable<ProviderChunk> {
    let config: DeepSeekRoleConfig
    let capability: ModelCapability
    let apiKey: string
    try {
      config = deepSeekRoleConfigSchema.parse(request.role)
      capability =
        this.discoveredCapabilitiesByRole
          .get(config.roleId)
          ?.get(capabilityKey(config.baseUrl, config.model)) ??
        deepSeekModelCapability(config.model)
      if (
        (config.thinking !== undefined && capability.thinking === null) ||
        (config.effort !== undefined &&
          !capability.reasoningEfforts.includes(config.effort)) ||
        (config.sampling !== undefined &&
          config.sampling.temperature !== undefined &&
          !capability.samplingParameters.some(({ name }) => name === 'temperature')) ||
        (config.sampling !== undefined &&
          config.sampling.topP !== undefined &&
          !capability.samplingParameters.some(({ name }) => name === 'topP'))
      ) {
        throw new ProviderNonRetryableError(
          'The selected DeepSeek model does not support the configured controls'
        )
      }
      apiKey = await resolveApiKey(this.dependencies.getApiKey, config, signal)
    } catch (error) {
      throw normalizeError(error, signal)
    }

    const body: Record<string, unknown> = {
      model: config.model,
      messages: [
        { role: 'system', content: request.view.system },
        ...request.view.messages
      ],
      max_tokens: config.maxTokens,
      stream: true,
      stream_options: { include_usage: true }
    }
    if (capability.structuredOutputModes.includes('json-object')) {
      body.response_format = { type: 'json_object' }
    }
    if (config.thinking !== undefined) {
      body.thinking = { type: config.thinking ? 'enabled' : 'disabled' }
    }
    if (config.effort !== undefined) body.reasoning_effort = config.effort
    if (config.thinking === false && config.sampling !== undefined) {
      if (config.sampling.temperature !== undefined) {
        body.temperature = config.sampling.temperature
      }
      if (config.sampling.topP !== undefined) body.top_p = config.sampling.topP
    }

    let completed = false
    let usageReceived = false
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
          throw new ProviderNonRetryableError(
            'DeepSeek streaming response contained invalid JSON'
          )
        }
        const chunk = deepSeekChatChunkSchema.parse(raw)
        if (chunk.choices.length === 0 && chunk.usage === null) {
          throw new ProviderNonRetryableError(
            'DeepSeek streaming response included an empty non-usage chunk'
          )
        }
        if (chunk.choices.length > 0 && chunk.usage !== null) {
          throw new ProviderNonRetryableError(
            'DeepSeek streaming usage must arrive in a separate empty-choice chunk'
          )
        }
        if (completed && chunk.choices.length > 0) {
          throw new ProviderNonRetryableError(
            'DeepSeek streaming response continued after completion'
          )
        }
        for (const choice of chunk.choices) {
          if (
            choice.delta.content !== undefined &&
            choice.delta.content !== null &&
            choice.delta.content !== ''
          ) {
            const nextVisibleContentChars =
              visibleContentChars + choice.delta.content.length
            if (nextVisibleContentChars > MAX_VISIBLE_CONTENT_CHARS) {
              throw new ProviderNonRetryableError(
                'DeepSeek visible response exceeded the debate reply limit'
              )
            }
            visibleContentChars = nextVisibleContentChars
            yield { type: 'content', content: choice.delta.content }
          }
          if (choice.finish_reason !== null) {
            if (choice.finish_reason === 'insufficient_system_resource') {
              throw new ProviderRetryableError(
                'DeepSeek stopped because inference resources were unavailable'
              )
            }
            if (choice.finish_reason === 'tool_calls') {
              throw new ProviderNonRetryableError(
                'DeepSeek returned a tool call although debate requests do not enable tools'
              )
            }
            completed = true
            yield {
              type: 'final',
              finishReason:
                choice.finish_reason === 'content_filter'
                  ? 'refusal'
                  : choice.finish_reason
            }
          }
        }
        if (chunk.usage !== null) {
          if (!completed || chunk.choices.length !== 0 || usageReceived) {
            throw new ProviderNonRetryableError(
              'DeepSeek streaming usage arrived out of sequence'
            )
          }
          usageReceived = true
          yield {
            type: 'usage',
            usage: {
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
              totalTokens: chunk.usage.total_tokens,
              cacheReadTokens: chunk.usage.prompt_cache_hit_tokens,
              ...(chunk.usage.completion_tokens_details?.reasoning_tokens === undefined
                ? {}
                : {
                    reasoningTokens:
                      chunk.usage.completion_tokens_details.reasoning_tokens
                  })
            }
          }
        }
      }
      if (!completed || !usageReceived) {
        throw new ProviderRetryableError(
          'DeepSeek streaming response ended before completion metadata'
        )
      }
    } catch (error) {
      throw normalizeError(error, signal)
    }
  }
}
