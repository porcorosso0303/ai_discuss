# 官方 API 来源与代码映射

实现核对日期：2026-08-29；发布前链接复查日期：2026-08-30。此清单固定 0.1.0 的实现合同；模型目录和服务能力会变化，程序运行时仍以服务商返回的模型列表为准。这里不复制价格表或大段官方原文。

## OpenAI / Codex

- [Codex CLI](https://developers.openai.com/codex/cli)：Windows/npm 运行入口与 ChatGPT 登录方式。
- [Codex App Server](https://developers.openai.com/codex/app-server/)：JSON-RPC 初始化、账号读取、ChatGPT 浏览器登录/退出、模型列表、thread/turn 与流式事件。
- [Permissions](https://learn.chatgpt.com/docs/permissions)：权限 profile 与文件系统/网络规则。
- [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)：`default_permissions`、登录方式、历史、搜索和 feature 配置。

代码映射：`src/main/providers/codex/` 使用随包固定的 Codex CLI 0.147.0 和稳定 App Server 合同；生产包不调用 OpenAI API Key，而是在应用独立的 Codex 数据目录中完成 ChatGPT 浏览器登录。协议子集固定在 `vendor/codex-schema/`。`tests/unit/providers/codex/codex-events.test.ts` 检查集成所依赖的 schema 为 stable-only；`SHA256SUMS` 则是独立的文件完整性清单。2026-08-30 发布复查在 `vendor/codex-schema` 目录运行 `sha256sum -c SHA256SUMS`，27 个文件均为 `OK`。staging/verification 脚本校验的是随包 Codex runtime 和 credential helper，不校验这些 schema 文件。

## Kimi

- [API 概览](https://platform.kimi.com/docs/api/overview)
- [Chat Completions](https://platform.kimi.com/docs/api/chat)
- [主要概念](https://platform.kimi.com/docs/introduction)

固定合同：默认 Base URL `https://api.moonshot.cn/v1`，Bearer 鉴权，OpenAI-compatible Chat Completions；请求按模型能力映射 `thinking`、`reasoning_effort`、`max_completion_tokens`、`response_format` 与 `stream`。模型能力由 `/models` 响应和本地已审阅规则共同约束，见 `src/main/providers/kimi/`。

## DeepSeek

- [Create Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion/)
- [Thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/)
- [模型与价格入口](https://api-docs.deepseek.com/quick_start/pricing/)

固定合同：Bearer 鉴权；V4 模型能力映射 thinking、`reasoning_effort`（low/high/max）、`max_tokens`、JSON object、SSE 和 usage。thinking 启用时不发送 sampling 参数。实现见 `src/main/providers/deepseek/`。

## 维护规则

升级服务合同前，应重新访问以上官方页面，更新对应的 schema/能力测试和访问日期。自定义 Base URL 可兼容代理，但程序不会假设代理拥有官方端点之外的隐藏能力。
