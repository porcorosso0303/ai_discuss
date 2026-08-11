import { z } from 'zod'

import {
  debateEventSchema,
  debateSessionSchema,
  debateSessionStateSchema,
  debateSetupSchema,
  providerCapabilitiesSchema,
  roleConfigSchema,
  roleIdSchema
} from './schemas'

export const IPC_CHANNELS = {
  appGetVersion: 'app:get-version',
  configListRoles: 'config:list-roles',
  configSaveRole: 'config:save-role',
  configDeleteRole: 'config:delete-role',
  credentialsSetProviderSecret: 'credentials:set-provider-secret',
  credentialsDeleteProviderSecret: 'credentials:delete-provider-secret',
  openAIGetAuthStatus: 'openai:get-auth-status',
  openAIStartLogin: 'openai:start-login',
  openAILogout: 'openai:logout',
  providerDiscoverCapabilities: 'provider:discover-capabilities',
  providerTestConnection: 'provider:test-connection',
  debateStart: 'debate:start',
  debatePause: 'debate:pause',
  debateResume: 'debate:resume',
  debateStop: 'debate:stop',
  debateRetryCurrentTurn: 'debate:retry-current-turn',
  historyList: 'history:list',
  historyGet: 'history:get',
  historyDelete: 'history:delete',
  historyClear: 'history:clear',
  exportMarkdown: 'export:markdown',
  debateEvent: 'debate:event',
  openAIAuthChanged: 'openai:auth-changed'
} as const

export const IPC_INVOKE_CHANNELS = [
  IPC_CHANNELS.appGetVersion,
  IPC_CHANNELS.configListRoles,
  IPC_CHANNELS.configSaveRole,
  IPC_CHANNELS.configDeleteRole,
  IPC_CHANNELS.credentialsSetProviderSecret,
  IPC_CHANNELS.credentialsDeleteProviderSecret,
  IPC_CHANNELS.openAIGetAuthStatus,
  IPC_CHANNELS.openAIStartLogin,
  IPC_CHANNELS.openAILogout,
  IPC_CHANNELS.providerDiscoverCapabilities,
  IPC_CHANNELS.providerTestConnection,
  IPC_CHANNELS.debateStart,
  IPC_CHANNELS.debatePause,
  IPC_CHANNELS.debateResume,
  IPC_CHANNELS.debateStop,
  IPC_CHANNELS.debateRetryCurrentTurn,
  IPC_CHANNELS.historyList,
  IPC_CHANNELS.historyGet,
  IPC_CHANNELS.historyDelete,
  IPC_CHANNELS.historyClear,
  IPC_CHANNELS.exportMarkdown
] as const

export const IPC_EVENT_CHANNELS = [
  IPC_CHANNELS.debateEvent,
  IPC_CHANNELS.openAIAuthChanged
] as const

const emptyRequestSchema = z.strictObject({})
const acknowledgementSchema = z.strictObject({ accepted: z.boolean() })
const sessionRequestSchema = z.strictObject({ sessionId: z.string().trim().min(1) })
const providerWithSecretSchema = z.enum(['kimi', 'deepseek'])

export const openAIAuthStatusSchema = z.strictObject({
  status: z.enum(['signed-out', 'signing-in', 'signed-in']),
  accountLabel: z.string().trim().min(1).optional()
})

export const debateSessionSummarySchema = z.strictObject({
  id: z.string().trim().min(1),
  topic: z.string().trim().min(1),
  state: debateSessionStateSchema,
  currentTurn: z.number().int().nonnegative(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true })
})

const ipcSchemas = {
  appGetVersion: {
    request: emptyRequestSchema,
    response: z.string().trim().min(1)
  },
  configListRoles: {
    request: emptyRequestSchema,
    response: z.strictObject({ roles: z.array(roleConfigSchema) })
  },
  configSaveRole: {
    request: z.strictObject({ role: roleConfigSchema }),
    response: z.strictObject({ role: roleConfigSchema })
  },
  configDeleteRole: {
    request: z.strictObject({ roleId: roleIdSchema }),
    response: z.strictObject({ deleted: z.boolean() })
  },
  credentialsSetProviderSecret: {
    request: z.strictObject({
      roleId: roleIdSchema,
      provider: providerWithSecretSchema,
      secret: z.string().min(1)
    }),
    response: z.strictObject({ stored: z.boolean() })
  },
  credentialsDeleteProviderSecret: {
    request: z.strictObject({
      roleId: roleIdSchema,
      provider: providerWithSecretSchema
    }),
    response: z.strictObject({ deleted: z.boolean() })
  },
  openAIGetAuthStatus: {
    request: emptyRequestSchema,
    response: openAIAuthStatusSchema
  },
  openAIStartLogin: {
    request: emptyRequestSchema,
    response: z.strictObject({ started: z.boolean() })
  },
  openAILogout: {
    request: emptyRequestSchema,
    response: z.strictObject({ signedOut: z.boolean() })
  },
  providerDiscoverCapabilities: {
    request: z.strictObject({ roleId: roleIdSchema }),
    response: providerCapabilitiesSchema
  },
  providerTestConnection: {
    request: z.strictObject({ roleId: roleIdSchema }),
    response: z.strictObject({
      ok: z.boolean(),
      message: z.string().optional(),
      capabilities: providerCapabilitiesSchema.optional()
    })
  },
  debateStart: {
    request: z.strictObject({ setup: debateSetupSchema }),
    response: z.strictObject({ session: debateSessionSchema })
  },
  debatePause: {
    request: sessionRequestSchema,
    response: acknowledgementSchema
  },
  debateResume: {
    request: sessionRequestSchema,
    response: acknowledgementSchema
  },
  debateStop: {
    request: sessionRequestSchema,
    response: acknowledgementSchema
  },
  debateRetryCurrentTurn: {
    request: sessionRequestSchema,
    response: acknowledgementSchema
  },
  historyList: {
    request: z.strictObject({
      search: z.string().optional(),
      limit: z.number().int().min(1).max(200).default(50)
    }),
    response: z.strictObject({ sessions: z.array(debateSessionSummarySchema) })
  },
  historyGet: {
    request: sessionRequestSchema,
    response: z.strictObject({ session: debateSessionSchema.nullable() })
  },
  historyDelete: {
    request: sessionRequestSchema,
    response: z.strictObject({ deleted: z.boolean() })
  },
  historyClear: {
    request: emptyRequestSchema,
    response: z.strictObject({ deletedCount: z.number().int().nonnegative() })
  },
  exportMarkdown: {
    request: sessionRequestSchema,
    response: z.strictObject({
      cancelled: z.boolean(),
      fileName: z.string().trim().min(1).optional()
    })
  }
} as const

export const ipcInvokeContracts = {
  [IPC_CHANNELS.appGetVersion]: ipcSchemas.appGetVersion,
  [IPC_CHANNELS.configListRoles]: ipcSchemas.configListRoles,
  [IPC_CHANNELS.configSaveRole]: ipcSchemas.configSaveRole,
  [IPC_CHANNELS.configDeleteRole]: ipcSchemas.configDeleteRole,
  [IPC_CHANNELS.credentialsSetProviderSecret]: ipcSchemas.credentialsSetProviderSecret,
  [IPC_CHANNELS.credentialsDeleteProviderSecret]: ipcSchemas.credentialsDeleteProviderSecret,
  [IPC_CHANNELS.openAIGetAuthStatus]: ipcSchemas.openAIGetAuthStatus,
  [IPC_CHANNELS.openAIStartLogin]: ipcSchemas.openAIStartLogin,
  [IPC_CHANNELS.openAILogout]: ipcSchemas.openAILogout,
  [IPC_CHANNELS.providerDiscoverCapabilities]: ipcSchemas.providerDiscoverCapabilities,
  [IPC_CHANNELS.providerTestConnection]: ipcSchemas.providerTestConnection,
  [IPC_CHANNELS.debateStart]: ipcSchemas.debateStart,
  [IPC_CHANNELS.debatePause]: ipcSchemas.debatePause,
  [IPC_CHANNELS.debateResume]: ipcSchemas.debateResume,
  [IPC_CHANNELS.debateStop]: ipcSchemas.debateStop,
  [IPC_CHANNELS.debateRetryCurrentTurn]: ipcSchemas.debateRetryCurrentTurn,
  [IPC_CHANNELS.historyList]: ipcSchemas.historyList,
  [IPC_CHANNELS.historyGet]: ipcSchemas.historyGet,
  [IPC_CHANNELS.historyDelete]: ipcSchemas.historyDelete,
  [IPC_CHANNELS.historyClear]: ipcSchemas.historyClear,
  [IPC_CHANNELS.exportMarkdown]: ipcSchemas.exportMarkdown
} as const

export const ipcEventContracts = {
  [IPC_CHANNELS.debateEvent]: debateEventSchema,
  [IPC_CHANNELS.openAIAuthChanged]: openAIAuthStatusSchema
} as const

export type IpcInvokeChannel = keyof typeof ipcInvokeContracts
export type IpcEventChannel = keyof typeof ipcEventContracts

export type IpcRequestMap = {
  [Channel in IpcInvokeChannel]: z.input<(typeof ipcInvokeContracts)[Channel]['request']>
}

export type IpcResponseMap = {
  [Channel in IpcInvokeChannel]: z.output<(typeof ipcInvokeContracts)[Channel]['response']>
}

export type IpcEventMap = {
  [Channel in IpcEventChannel]: z.output<(typeof ipcEventContracts)[Channel]>
}
