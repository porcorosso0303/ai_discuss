# AI 模型辩论场 Windows 便携版 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 构建一个 Windows 10/11 x64 免安装 Electron 应用，让两个可配置的 OpenAI/Codex、Kimi 或 DeepSeek 角色自动交流或辩论，并可靠保存、展示和导出结果。

**Architecture:** React 渲染进程只负责 UI，通过受限 preload IPC 调用 Electron 主进程。主进程承载辩论状态机、上下文管理、三家服务商适配器、Codex App Server 子进程、本地 JSON 仓库和 Windows Credential Manager helper；所有边界使用 Zod schema 校验。

**Tech Stack:** Electron、React、TypeScript、electron-vite、Zod、Vitest、Testing Library、Playwright、Go Windows helper、Electron Builder、OpenAI Codex App Server、原生 Fetch/SSE。

---

## 执行约束

- 先阅读 `docs/plans/2026-08-10-ai-debates-windows-design.md`。
- 每项功能遵循红灯、绿灯、重构的 TDD 顺序。
- 不连接真实付费 API 运行默认测试；真实服务商测试必须显式设置环境变量。
- 每完成一个任务运行该任务测试；每完成一个阶段运行 `npm test`。
- 当前工作区不是有效 Git 仓库。若后续获准初始化 Git，则执行每个任务末尾的 commit；否则保留变更并记录未提交原因。
- OpenAI、Kimi、DeepSeek 的请求参数只能来自设计文档列出的官方文档和固定契约测试。

### Task 1: 建立 Electron/React/TypeScript 安全基线

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `electron.vite.config.ts`
- Create: `tsconfig.json`
- Create: `tsconfig.node.json`
- Create: `src/main/index.ts`
- Create: `src/main/create-window.ts`
- Create: `src/preload/index.ts`
- Create: `src/renderer/index.html`
- Create: `src/renderer/src/main.tsx`
- Create: `src/renderer/src/App.tsx`
- Create: `src/renderer/src/styles/global.css`
- Create: `tests/unit/main/window-security.test.ts`
- Create: `.gitignore`

**Step 1: 写失败测试**

在 `window-security.test.ts` 断言 BrowserWindow 配置固定为：

```ts
expect(options.webPreferences).toMatchObject({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true
})
```

**Step 2: 验证红灯**

Run: `npm test -- tests/unit/main/window-security.test.ts`

Expected: FAIL，`createWindowOptions` 尚不存在。

**Step 3: 最小实现**

- 初始化固定版本依赖并生成 lockfile。
- `create-window.ts` 导出纯函数 `createWindowOptions(preloadPath)`，再由 `createAppWindow()` 使用。
- preload 暂时只暴露只读 `app.getVersion()`。
- App 渲染一个中文标题“AI 模型辩论场”。

**Step 4: 验证绿灯和构建**

Run: `npm test -- tests/unit/main/window-security.test.ts`

Expected: PASS。

Run: `npm run typecheck && npm run build`

Expected: 两条命令 exit 0，生成 `out/`。

**Step 5: Commit**

```bash
git add package.json package-lock.json electron.vite.config.ts tsconfig*.json src tests .gitignore
git commit -m 'chore: scaffold secure electron application'
```

### Task 2: 定义领域模型、配置能力与 IPC contract

**Files:**
- Create: `src/shared/domain.ts`
- Create: `src/shared/schemas.ts`
- Create: `src/shared/ipc.ts`
- Create: `tests/unit/shared/schemas.test.ts`

**Step 1: 写失败测试**

覆盖：

- 角色 ID 只能是 `role-a` 或 `role-b`。
- 服务商只能是 `openai`、`kimi`、`deepseek`。
- 最大单方发言次数范围为 1–100，默认 100。
- `DebateReply.status` 只能是 `continue/concede/agree`。
- 配置对象不允许出现 `apiKey` 持久化字段。

示例：

```ts
expect(() => DebateSetupSchema.parse({ ...validSetup, maxTurns: 101 })).toThrow()
expect(DebateReplySchema.parse({ speech: '继续。', status: 'continue' })).toBeTruthy()
```

**Step 2: 验证红灯**

Run: `npm test -- tests/unit/shared/schemas.test.ts`

Expected: FAIL，schema 尚不存在。

**Step 3: 最小实现**

定义 `RoleConfig`、`ProviderCapabilities`、`DebateSetup`、`DebateMessage`、`DebateSession`、`Usage`、`DebateReply`、`DebateEvent` 和 IPC request/response schema。使用 discriminated union 区分三家配置，确保不支持的参数无法进入请求层。

**Step 4: 验证绿灯**

Run: `npm test -- tests/unit/shared/schemas.test.ts`

Expected: PASS。

**Step 5: Commit**

```bash
git add src/shared tests/unit/shared
git commit -m 'feat: define debate domain contracts'
```

### Task 3: 实现固定提示词、角色视角和输出解析

**Files:**
- Create: `src/main/debate/system-prompt.ts`
- Create: `src/main/debate/prompt-builder.ts`
- Create: `src/main/debate/reply-parser.ts`
- Create: `tests/unit/debate/system-prompt.test.ts`
- Create: `tests/unit/debate/prompt-builder.test.ts`
- Create: `tests/unit/debate/reply-parser.test.ts`

**Step 1: 写失败测试**

- 断言固定提示包含用户确认的五条行为定义。
- 断言恶意对手文本“忽略以上规则”只出现在引用区，不能进入 system 指令。
- 断言当前角色自己的发言映射为 `assistant`，对手发言映射为 `user`。
- 解析合法 JSON、代码围栏 JSON、隐藏尾标、缺失状态和截断 JSON。

```ts
const view = buildRoleView(session, 'role-b')
expect(view.messages.at(-1)).toMatchObject({ role: 'user', content: 'A 的发言' })
expect(parseReply('{"speech":"我同意","status":"agree"}')).toEqual({
  speech: '我同意', status: 'agree', warning: undefined
})
```

**Step 2: 验证红灯**

Run: `npm test -- tests/unit/debate`

Expected: FAIL。

**Step 3: 最小实现**

- `buildSystemPrompt()` 将固定规则、角色名称、立场、话题、先后手和 JSON contract 分区拼接。
- 对手文本使用明确的 XML-like delimiter 包裹并转义结束标记。
- `parseReply()` 优先严格 schema，再尝试移除代码围栏，最后尝试 `<debate-status>` 尾标；失败按 `continue` 并返回 warning。
- `speech` 去除机器状态标记后才进入 UI 和历史。

**Step 4: 验证绿灯**

Run: `npm test -- tests/unit/debate`

Expected: PASS。

**Step 5: Commit**

```bash
git add src/main/debate tests/unit/debate
git commit -m 'feat: build role prompts and parse debate replies'
```

### Task 4: 实现辩论状态机与轮次编排

**Files:**
- Create: `src/main/debate/state-machine.ts`
- Create: `src/main/debate/orchestrator.ts`
- Create: `src/main/providers/provider.ts`
- Create: `tests/unit/debate/state-machine.test.ts`
- Create: `tests/unit/debate/orchestrator.test.ts`
- Create: `tests/helpers/fake-provider.ts`

**Step 1: 写失败测试**

覆盖：

- 指定角色先发并严格交替。
- 一方 `concede` 时立即判另一方获胜。
- 只有双方连续 `agree` 才结束一致；`agree` 后接 `continue` 会清零。
- 第 100 次单方发言后为 `unresolved`，绝不发起第 101 次调用。
- pause 在当前发言完成后进入 paused；stop 取消当前调用且不保存半条发言。
- 三次可重试错误后进入 failed/paused recovery 状态。

**Step 2: 验证红灯**

Run: `npm test -- tests/unit/debate/state-machine.test.ts tests/unit/debate/orchestrator.test.ts`

Expected: FAIL。

**Step 3: 最小实现**

`ModelProvider` contract：

```ts
interface ModelProvider {
  discover(config: RoleConfig, signal?: AbortSignal): Promise<ProviderCapabilities>
  streamReply(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderChunk>
  cancelActive?(): Promise<void>
}
```

`DebateOrchestrator` 只依赖 provider、repository、clock 和 retry policy，使用事件回调发送 `turnStarted/chunk/turnCompleted/stateChanged/error`。所有状态转移集中在纯函数 reducer 中。

**Step 4: 验证绿灯**

Run: `npm test -- tests/unit/debate/state-machine.test.ts tests/unit/debate/orchestrator.test.ts`

Expected: PASS，FakeProvider 调用次数符合断言。

**Step 5: Commit**

```bash
git add src/main/debate src/main/providers/provider.ts tests
git commit -m 'feat: orchestrate two-role debate state machine'
```

### Task 5: 实现上下文预算与压缩

**Files:**
- Create: `src/main/debate/context-manager.ts`
- Create: `src/main/debate/argument-summary.ts`
- Create: `tests/unit/debate/context-manager.test.ts`

**Step 1: 写失败测试**

- 未超预算时保留完整历史。
- 超过阈值时始终保留 system、话题、立场和最近 20 条发言。
- 旧发言替换为一条明确标注范围的中立论点摘要。
- 原始 session messages 不被修改。
- `reasoning_content` 永不进入对手视角。

**Step 2: 验证红灯**

Run: `npm test -- tests/unit/debate/context-manager.test.ts`

Expected: FAIL。

**Step 3: 最小实现**

- 为已知模型保存运行时发现的 `contextLength`；未知值采用保守字符估算和可配置安全阈值。
- 默认在预计占用达到上下文 75% 时压缩。
- 摘要请求使用独立 neutral prompt，通过注入的 `SummaryProvider` 生成 `{claims, evidence, concessions, disputes}`；失败时退回确定性截断并发出警告。
- 本地保存 summary metadata，但保留完整原文。

**Step 4: 验证绿灯**

Run: `npm test -- tests/unit/debate/context-manager.test.ts`

Expected: PASS。

**Step 5: Commit**

```bash
git add src/main/debate tests/unit/debate/context-manager.test.ts
git commit -m 'feat: compact long debate context safely'
```

### Task 6: 实现 HTTP、SSE 与重试基础设施

**Files:**
- Create: `src/main/providers/http/http-client.ts`
- Create: `src/main/providers/http/sse-parser.ts`
- Create: `src/main/providers/http/retry-policy.ts`
- Create: `src/main/providers/http/redaction.ts`
- Create: `tests/unit/providers/sse-parser.test.ts`
- Create: `tests/unit/providers/retry-policy.test.ts`
- Create: `tests/unit/providers/redaction.test.ts`

**Step 1: 写失败测试**

覆盖任意字节分片、CRLF、多个 data 行、`[DONE]`、AbortSignal；验证只重试网络/429/5xx，遵循 `Retry-After`，最多三次；验证日志中 Authorization 和 Key 被替换为 `[REDACTED]`。

**Step 2: 验证红灯**

Run: `npm test -- tests/unit/providers`

Expected: FAIL。

**Step 3: 最小实现**

使用 Electron 内置 Node 的原生 `fetch` 和 Web Streams，不引入通用 OpenAI SDK。`fetchJson`、`streamSse` 和 `withRetry` 注入 fetch/sleep/random，保证测试不实际等待。

**Step 4: 验证绿灯**

Run: `npm test -- tests/unit/providers`

Expected: PASS。

**Step 5: Commit**

```bash
git add src/main/providers/http tests/unit/providers
git commit -m 'feat: add cancellable sse transport and retries'
```

### Task 7: 实现 Kimi 适配器

**Files:**
- Create: `src/main/providers/kimi/kimi-provider.ts`
- Create: `src/main/providers/kimi/kimi-schema.ts`
- Create: `tests/contract/kimi-provider.test.ts`
- Create: `tests/fixtures/kimi/*.json`

**Step 1: 写失败契约测试**

- `GET {baseUrl}/models` 使用 Bearer Key，并解析 `context_length` 和 `supports_reasoning`。
- Chat URL 为 `{baseUrl}/chat/completions`。
- 使用 `max_completion_tokens`，绝不发送弃用的 `max_tokens`。
- `thinking` 仅在模型支持时出现；`keep: all` 仅在用户显式开启时出现。
- 请求 `response_format: json_schema`，SSE 只输出 content，reasoning 不进入可见 chunk。

**Step 2: 验证红灯**

Run: `npm test -- tests/contract/kimi-provider.test.ts`

Expected: FAIL。

**Step 3: 最小实现**

严格按照 Kimi 官方 `/v1/models` 和 `/v1/chat/completions` contract 构造请求。发现接口失败时只有用户选择自定义兼容端点才允许手动模型 fallback；官方端点错误直接显示。

**Step 4: 验证绿灯**

Run: `npm test -- tests/contract/kimi-provider.test.ts`

Expected: PASS，快照中无未授权参数。

**Step 5: Commit**

```bash
git add src/main/providers/kimi tests/contract tests/fixtures/kimi
git commit -m 'feat: integrate official kimi chat api'
```

### Task 8: 实现 DeepSeek 适配器

**Files:**
- Create: `src/main/providers/deepseek/deepseek-provider.ts`
- Create: `src/main/providers/deepseek/deepseek-capabilities.ts`
- Create: `tests/contract/deepseek-provider.test.ts`
- Create: `tests/fixtures/deepseek/*.json`

**Step 1: 写失败契约测试**

- `GET {baseUrl}/models` 发现 V4 模型。
- Chat URL 为 `{baseUrl}/chat/completions`。
- V4 Flash 显示 `low/high/max`；V4 Pro 使用官方固定能力映射。
- thinking enabled 时不发送 `temperature/top_p/presence_penalty/frequency_penalty`。
- 使用 `response_format: { type: 'json_object' }`，系统提示明确要求 JSON。
- usage chunk 正确合并；reasoning_content 不显示、不保存。

**Step 2: 验证红灯**

Run: `npm test -- tests/contract/deepseek-provider.test.ts`

Expected: FAIL。

**Step 3: 最小实现**

按官方模型发现和 Chat Completions schema 实现。能力映射附带文档更新时间常量，未知模型默认只显示模型 ID 和最小参数，避免猜测能力。

**Step 4: 验证绿灯**

Run: `npm test -- tests/contract/deepseek-provider.test.ts`

Expected: PASS。

**Step 5: Commit**

```bash
git add src/main/providers/deepseek tests/contract tests/fixtures/deepseek
git commit -m 'feat: integrate official deepseek chat api'
```

### Task 9: 实现 Codex App Server JSON-RPC、登录与模型调用

**Files:**
- Create: `src/main/providers/codex/jsonrpc-client.ts`
- Create: `src/main/providers/codex/codex-process.ts`
- Create: `src/main/providers/codex/codex-provider.ts`
- Create: `src/main/providers/codex/codex-events.ts`
- Create: `src/main/providers/codex/codex-path.ts`
- Create: `tests/unit/providers/codex/jsonrpc-client.test.ts`
- Create: `tests/contract/codex-provider.test.ts`
- Create: `tests/helpers/fake-codex-server.mjs`

**Step 1: 写失败测试**

覆盖：

- 启动后必须先 `initialize` 再 `initialized`。
- request ID 并发关联、notification 分发、server error 和进程异常退出。
- `account/read`、ChatGPT browser login start/completed、logout。
- `model/list` 映射模型和 supported reasoning effort。
- 每个角色独立 thread，turn 使用 `effort` 与 `outputSchema`。
- `item/agentMessage/delta` 转成可见流；`turn/completed` 完成；stop 调用 `turn/interrupt`。

**Step 2: 验证红灯**

Run: `npm test -- tests/unit/providers/codex tests/contract/codex-provider.test.ts`

Expected: FAIL。

**Step 3: 最小实现**

- 生产模式从 `process.resourcesPath/bin/codex.exe` 启动；开发模式允许 `CODEX_BIN` 覆盖。
- 使用官方稳定 JSON-RPC 字段；构建时用固定 Codex 版本生成 schema 并保存到 `vendor/codex-schema/`。
- 为每个角色使用独立空 cwd 和受限 read-only sandbox，approval policy 为 never。
- 浏览器只打开 App Server 返回且 host 属于 OpenAI/ChatGPT 登录域的 `authUrl`。
- 登录 token 永不经过 renderer。

**Step 4: 验证绿灯**

Run: `npm test -- tests/unit/providers/codex tests/contract/codex-provider.test.ts`

Expected: PASS。

**Step 5: Commit**

```bash
git add src/main/providers/codex tests vendor/codex-schema
git commit -m 'feat: integrate codex app server authentication'
```

### Task 10: 实现 Windows Credential Manager helper

**Files:**
- Create: `native/credential-helper/go.mod`
- Create: `native/credential-helper/protocol.go`
- Create: `native/credential-helper/main_windows.go`
- Create: `native/credential-helper/main_other.go`
- Create: `native/credential-helper/protocol_test.go`
- Create: `src/main/security/credential-vault.ts`
- Create: `tests/unit/security/credential-vault.test.ts`
- Create: `scripts/build-credential-helper.mjs`

**Step 1: 写失败测试**

- Go 协议测试覆盖 stdin JSON 的 `get/set/delete`、非法 target 和不在输出回显 secret。
- Node wrapper 测试断言 secret 只通过 stdin 传递，不进入 argv、日志或错误消息。
- 删除角色配置会删除对应 target。

**Step 2: 验证红灯**

Run: `go test ./native/credential-helper/...`

Expected: FAIL。

Run: `npm test -- tests/unit/security/credential-vault.test.ts`

Expected: FAIL。

**Step 3: 最小实现**

- 使用 Go 标准库和 Windows `CredWriteW/CredReadW/CredDeleteW`，不引入 CGo 或第三方包。
- helper 接受单个 stdin JSON 请求，stdout 只返回 `{ ok, found?, errorCode? }` 或 get 的 secret；stderr 脱敏。
- target 格式固定为 `AI Debates/<roleId>/<provider>`。
- Linux 开发 fallback 明确返回 unsupported，单元测试注入 fake executable。

**Step 4: 验证绿灯与交叉编译**

Run: `go test ./native/credential-helper/...`

Expected: PASS。

Run: `GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -o resources/bin/credential-helper.exe ./native/credential-helper`

Expected: exit 0，并且 `file resources/bin/credential-helper.exe` 显示 PE32+ x86-64。

Run: `npm test -- tests/unit/security/credential-vault.test.ts`

Expected: PASS。

**Step 5: Commit**

```bash
git add native src/main/security scripts tests/unit/security
git commit -m 'feat: store api keys in windows credential manager'
```

### Task 11: 实现本地配置、历史、日志与 Markdown 导出

**Files:**
- Create: `src/main/storage/atomic-json.ts`
- Create: `src/main/storage/config-repository.ts`
- Create: `src/main/storage/debate-repository.ts`
- Create: `src/main/storage/log-service.ts`
- Create: `src/main/export/markdown-exporter.ts`
- Create: `tests/unit/storage/*.test.ts`
- Create: `tests/unit/export/markdown-exporter.test.ts`

**Step 1: 写失败测试**

- 写临时文件后 atomic rename，崩溃残留不破坏旧数据。
- API Key 字段无论嵌套多深都不会落盘。
- 历史支持 list/search/get/delete/clear。
- incomplete session 可恢复但不会自动运行。
- Markdown 包含话题、配置摘要、发言和结果，不含 reasoning、Authorization、token。

**Step 2: 验证红灯**

Run: `npm test -- tests/unit/storage tests/unit/export`

Expected: FAIL。

**Step 3: 最小实现**

使用 `%LOCALAPPDATA%/AI Debates` 对应的 `app.getPath('userData')`：

```text
config/settings.json
debates/index.json
debates/<session-id>.json
logs/app-YYYY-MM-DD.log
```

所有写入先 schema parse 和脱敏；export 使用 Electron save dialog 返回的用户选择路径。

**Step 4: 验证绿灯**

Run: `npm test -- tests/unit/storage tests/unit/export`

Expected: PASS。

**Step 5: Commit**

```bash
git add src/main/storage src/main/export tests/unit/storage tests/unit/export
git commit -m 'feat: persist and export debate history safely'
```

### Task 12: 注册主进程服务、IPC 和 preload 白名单

**Files:**
- Create: `src/main/services.ts`
- Create: `src/main/ipc/register-ipc.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Create: `src/renderer/src/types/electron.d.ts`
- Create: `tests/unit/main/ipc.test.ts`
- Create: `tests/unit/preload/api-surface.test.ts`

**Step 1: 写失败测试**

断言 renderer 只能调用明确列出的配置、认证、模型发现、辩论控制、历史和导出方法；拒绝未知 channel、任意路径、任意 URL 和含 Key 的配置 payload。

**Step 2: 验证红灯**

Run: `npm test -- tests/unit/main/ipc.test.ts tests/unit/preload/api-surface.test.ts`

Expected: FAIL。

**Step 3: 最小实现**

- IPC handler 入口和返回值都 schema parse。
- Debate event 使用单一订阅 channel，preload 返回 unsubscribe。
- 打开登录 URL 由主进程验证 allowlist 后调用 `shell.openExternal`。
- app quit 时 abort 活动请求并关闭 Codex 子进程。

**Step 4: 验证绿灯**

Run: `npm test -- tests/unit/main/ipc.test.ts tests/unit/preload/api-surface.test.ts`

Expected: PASS。

**Step 5: Commit**

```bash
git add src/main src/preload src/renderer/src/types tests/unit/main tests/unit/preload
git commit -m 'feat: expose validated desktop ipc api'
```

### Task 13: 构建应用壳与角色配置页面

**Files:**
- Create: `src/renderer/src/components/AppShell.tsx`
- Create: `src/renderer/src/components/RoleCard.tsx`
- Create: `src/renderer/src/components/ProviderFields.tsx`
- Create: `src/renderer/src/components/ConnectionBadge.tsx`
- Create: `src/renderer/src/pages/ConfigurationPage.tsx`
- Create: `src/renderer/src/state/app-state.tsx`
- Create: `src/renderer/src/styles/tokens.css`
- Create: `src/renderer/src/styles/components.css`
- Modify: `src/renderer/src/App.tsx`
- Create: `tests/component/ConfigurationPage.test.tsx`

**Step 1: 写失败组件测试**

- 同时显示角色 A/B。
- 切换 provider 后只显示该服务商支持字段。
- OpenAI 显示登录而不显示 API Key。
- DeepSeek thinking enabled 隐藏采样参数。
- 两边未测试通过时开始按钮 disabled。
- 输入 API Key 后 UI 不回读明文。

**Step 2: 验证红灯**

Run: `npm test -- tests/component/ConfigurationPage.test.tsx`

Expected: FAIL。

**Step 3: 最小实现**

- 三栏壳：顶部品牌和状态，左侧导航，主内容。
- 视觉使用深蓝灰背景、青色/橙色角色强调、清晰的焦点环和中文字体 fallback。
- 模型和 effort 选项来自 discover 结果，不硬编码到组件。
- 高级参数折叠，错误贴近字段显示。

**Step 4: 验证绿灯**

Run: `npm test -- tests/component/ConfigurationPage.test.tsx`

Expected: PASS。

Run: `npm run typecheck`

Expected: exit 0。

**Step 5: Commit**

```bash
git add src/renderer tests/component/ConfigurationPage.test.tsx
git commit -m 'feat: add dynamic role configuration ui'
```

### Task 14: 构建辩论现场页面

**Files:**
- Create: `src/renderer/src/pages/DebatePage.tsx`
- Create: `src/renderer/src/components/DebateSetup.tsx`
- Create: `src/renderer/src/components/DebateTimeline.tsx`
- Create: `src/renderer/src/components/MessageBubble.tsx`
- Create: `src/renderer/src/components/DebateControls.tsx`
- Create: `src/renderer/src/components/ResultCard.tsx`
- Create: `src/renderer/src/hooks/use-debate-events.ts`
- Create: `tests/component/DebatePage.test.tsx`

**Step 1: 写失败组件测试**

- 话题、先发角色、默认 100 次上限。
- chunk 到达时对应气泡实时增长。
- 状态徽标不显示原始 JSON/隐藏标记。
- pause/continue/stop 调用正确 IPC。
- stop 后丢弃未完成临时气泡。
- concede/agreement/unresolved 显示正确结果卡。

**Step 2: 验证红灯**

Run: `npm test -- tests/component/DebatePage.test.tsx`

Expected: FAIL。

**Step 3: 最小实现**

使用 reducer 合并 debate events；正式消息和 streaming draft 分离。自动滚动只在用户位于底部附近时生效，用户向上阅读后不抢滚动位置。所有按钮带可见键盘 focus 和中文 aria-label。

**Step 4: 验证绿灯**

Run: `npm test -- tests/component/DebatePage.test.tsx`

Expected: PASS。

**Step 5: Commit**

```bash
git add src/renderer tests/component/DebatePage.test.tsx
git commit -m 'feat: stream and control live debates'
```

### Task 15: 构建历史记录页面

**Files:**
- Create: `src/renderer/src/pages/HistoryPage.tsx`
- Create: `src/renderer/src/components/HistoryList.tsx`
- Create: `src/renderer/src/components/HistoryDetail.tsx`
- Create: `src/renderer/src/components/ConfirmDialog.tsx`
- Create: `tests/component/HistoryPage.test.tsx`

**Step 1: 写失败组件测试**

覆盖搜索、详情、导出、单删、清空二次确认、恢复 incomplete session 和空状态。

**Step 2: 验证红灯**

Run: `npm test -- tests/component/HistoryPage.test.tsx`

Expected: FAIL。

**Step 3: 最小实现**

历史列表按更新时间倒序；删除和清空必须二次确认；恢复只装载现场，用户再点继续；导出成功后显示保存位置但不自动执行该文件。

**Step 4: 验证绿灯**

Run: `npm test -- tests/component/HistoryPage.test.tsx`

Expected: PASS。

**Step 5: Commit**

```bash
git add src/renderer tests/component/HistoryPage.test.tsx
git commit -m 'feat: browse export and manage debate history'
```

### Task 16: 完成端到端模拟辩论和安全回归

**Files:**
- Create: `playwright.config.ts`
- Create: `tests/e2e/app.spec.ts`
- Create: `tests/e2e/mock-provider-server.ts`
- Create: `tests/e2e/fixtures.ts`
- Create: `tests/e2e/security.spec.ts`

**Step 1: 写失败 E2E**

完整场景：配置两个模拟角色、测试连接、输入话题、选择 B 先发、流式运行、双方一致结束、打开历史并导出 Markdown。另测暂停/恢复、认输、100 次边界和调用失败恢复。

安全场景断言 renderer 中 `require/process` 不可用、任意 IPC channel 不可调用、页面文本中不存在测试 Key。

**Step 2: 验证红灯**

Run: `npm run test:e2e`

Expected: FAIL，E2E wiring 尚未完成。

**Step 3: 完成 wiring**

为测试构建注入本地 mock provider registry，不放宽生产 IPC 或 CSP。修复仅由 E2E 暴露的竞态、unsubscribe 和窗口关闭问题。

**Step 4: 验证绿灯**

Run: `npm run test:e2e`

Expected: PASS。

Run: `npm test && npm run typecheck && npm run build`

Expected: 全部 exit 0。

**Step 5: Commit**

```bash
git add playwright.config.ts tests/e2e src
git commit -m 'test: cover complete desktop debate workflow'
```

### Task 17: 配置 Codex 运行时、便携包与 Windows CI

**Files:**
- Create: `electron-builder.yml`
- Create: `scripts/stage-codex-runtime.mjs`
- Create: `scripts/verify-artifact.mjs`
- Create: `.github/workflows/windows-build.yml`
- Modify: `package.json`
- Modify: `.gitignore`

**Step 1: 写失败构建检查**

`verify-artifact.mjs` 必须检查：

- `resources/bin/codex.exe` 和 `credential-helper.exe` 存在且为 PE x64。
- Codex 版本等于 package 固定版本。
- Builder target 为 `portable`、x64、无管理员请求。
- asar 中不包含 `.env`、测试 fixture key 或源码 map。
- 输出文件名为 `AI-Debates-Portable-x64.exe`。

**Step 2: 验证红灯**

Run: `npm run verify:staged-runtime`

Expected: FAIL，Windows Codex runtime 尚未 stage。

**Step 3: 最小实现**

- 固定 `@openai/codex` 和 Windows x64 runtime 的同一版本。
- stage 脚本从 lockfile 对应 npm artifact 提取官方 `codex.exe`，校验 package version 和完整性，不使用系统预装 Codex 作为发布资源。
- `electron-builder.yml` 使用 `portable` target，将两个 helper 放入 `extraResources/bin`。
- CI 使用 `windows-latest`，顺序执行 install、Go helper build、Codex stage、tests、Playwright、portable build、SHA-256 和 artifact upload。

**Step 4: 构建验证**

Run: `npm run dist:win`

Expected: `dist/AI-Debates-Portable-x64.exe` 存在。

Run: `npm run verify:artifact`

Expected: 输出 artifact 路径、大小和 SHA-256，exit 0。

**Step 5: Commit**

```bash
git add electron-builder.yml scripts .github package.json package-lock.json .gitignore
git commit -m 'build: package windows portable application'
```

### Task 18: 官方服务冒烟测试、说明文档与最终验收

**Files:**
- Create: `tests/live/providers.live.test.ts`
- Create: `README.md`
- Create: `docs/official-api-sources.md`
- Create: `docs/windows-smoke-test.md`
- Create: `CHANGELOG.md`

**Step 1: 添加 opt-in live tests**

只有设置下列变量时运行对应测试，否则 skip：

```text
KIMI_API_KEY
DEEPSEEK_API_KEY
RUN_CODEX_LIVE_TEST=1
```

测试只发现模型并各生成一条极短结构化回应；输出和日志不得打印 secret。

**Step 2: 编写用户文档**

README 包含：启动、OpenAI 浏览器登录、Kimi/DeepSeek Key、角色与立场、100 次上限、暂停/停止、历史导出、数据目录、凭据删除、SmartScreen 提示和故障排查。

`official-api-sources.md` 固化实现所用官方页面、访问日期和各参数映射。

**Step 3: 运行全套自动验证**

Run: `npm test`

Expected: 全部测试 PASS，无未处理 promise rejection。

Run: `npm run typecheck && npm run lint && npm run build && npm run test:e2e`

Expected: 全部 exit 0。

Run: `npm audit --omit=dev`

Expected: 无 high/critical production vulnerability；若上游不可修复，记录具体 advisory 和隔离理由，不静默忽略。

**Step 4: Windows 人工冒烟**

按 `docs/windows-smoke-test.md` 在干净 Windows 10/11 x64 用户环境验证：

- 无管理员权限启动便携 EXE。
- Codex 浏览器登录、退出和重新登录。
- Kimi/DeepSeek Key 写入、读取、删除，配置文件中无明文。
- 两个真实或模拟角色完成 continue、concede、agree、pause、stop。
- 中文路径运行和中文 Markdown 导出。
- 关闭后无遗留 Codex/helper 进程。

**Step 5: 最终 diff 与 commit**

Run: `git diff --check`

Expected: 无输出。

```bash
git add README.md CHANGELOG.md docs tests/live
git commit -m 'docs: add usage and release verification guide'
```

## 最终完成条件

- 设计文档中的全部首版功能可从 GUI 使用。
- 默认测试不使用真实 API 或真实凭据。
- 三家适配器的请求 contract 有官方 fixture/测试约束。
- API Key 不进入 renderer、配置、历史、导出或日志。
- 最大 100 次单方发言、认输和双方连续一致的状态机测试通过。
- `dist/AI-Debates-Portable-x64.exe` 可在 Windows 10/11 x64 无安装运行。
- 最终交付记录 EXE 的 SHA-256、测试结果、已知限制和未签名提示。
