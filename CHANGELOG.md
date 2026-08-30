# Changelog

## 0.1.0 - 2026-08-29

### 功能

- Windows x64 便携版双角色图形化交流/辩论，支持 OpenAI/Codex、Kimi 与 DeepSeek。
- ChatGPT 浏览器登录；Kimi/DeepSeek 动态模型、参数配置与 Windows Credential Manager 凭据保存。
- 流式对话、默认 100 条总正式发言上限、认输/一致检测、暂停/继续/停止和结果展示。
- 历史搜索、手动恢复、删除及 Markdown 导出。

### 修复与可靠性

- 固定并校验 Codex 0.147.0 runtime、稳定 App Server 合同与 x64 credential helper。
- 对 API 错误、流式协议、取消、恢复、持久化和凭据边界增加合同与端到端测试。
- Windows 数据目录固定为 `%LOCALAPPDATA%/AI Debates`；环境无效时保留 Electron 默认目录。

### 已知限制

- 仅支持双角色。
- 构建未签名，可能触发 SmartScreen。
- 模型依赖在线服务及用户账号/额度；便携运行仍会写入每用户数据和 Credential Manager。
