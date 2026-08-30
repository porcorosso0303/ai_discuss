# AI Debates

AI Debates 是一个 Windows x64 图形化双角色 AI 交流/辩论程序。它把一方的正式发言自动交给另一方回应，直到一方认输、双方达成一致、用户停止，或达到总正式发言上限。

## 启动便携版

1. 下载 `AI-Debates-Portable-x64.exe`，放到任意可写目录；无需安装，也无需管理员权限。
2. 双击运行。未签名版本可能触发 Microsoft Defender SmartScreen；请先核对文件来源和发布者提供的 SHA-256，再决定是否选择“更多信息 → 仍要运行”。
3. 便携版可从中文路径启动，但仍会把配置、历史和日志写到当前 Windows 用户目录，而不是 EXE 所在目录。

## 配置两个角色

角色 A、B 均可分别设置角色名称、立场/人物设定、服务商、动态获取的模型，以及模型官方支持的参数。切换服务商或参数后需要重新“测试连接”。

- OpenAI / Codex：点击“使用 ChatGPT 登录”，在浏览器完成 ChatGPT 授权后回到程序。界面支持退出登录和再次登录，不使用 OpenAI API Key。
- Kimi：填写 API Key；默认官方 Base URL 为 `https://api.moonshot.cn/v1`，也可设置自定义 Base URL。先“获取模型”，再选择模型及其可用参数。
- DeepSeek：填写 API Key；默认官方 Base URL 为 `https://api.deepseek.com`，也可设置自定义 Base URL。先“获取模型”，再选择模型及其可用参数。

Kimi 与 DeepSeek 的 API Key 保存在 Windows Credential Manager；配置、历史、日志和 Markdown 导出中不应出现明文密钥。需要移除时，在对应角色卡点击“删除已保存凭据”。

## 开始与控制辩论

1. 两个角色均测试成功后进入辩论设置。
2. 输入话题，指定角色 A 或 B 先发言，并设置轮数上限。默认值 100 指双方合计最多 100 条总正式发言，并非每方各 100 条。
3. 启动后，对话按角色直观显示。运行中可“暂停”，暂停后可“继续”，也可随时“停止”。
4. 一方返回认输、双方达成一致、达到上限或发生终止性错误后，结果卡会显示结束原因。

历史记录页可搜索、查看、删除和导出 Markdown。未完成辩论可“加载并恢复”，但恢复后不会自动调用模型：必须由用户手动点击“继续”。

## 本机数据

- Windows 正常环境：`%LOCALAPPDATA%/AI Debates`
- 若 Windows 没有提供有效的绝对 `LOCALAPPDATA`，程序保留 Electron 的默认 `userData` 目录。
- 上述目录保存角色配置、辩论历史、日志及独立的 Codex 登录资料；API Key 则由 Windows Credential Manager 保存。
- 删除 EXE 不会自动删除这些每用户数据。请先在程序中删除凭据，并按需删除历史和数据目录。

## 故障排查

- Codex 无法启动：确认便携包未被安全软件隔离，`codex.exe` 与程序版本匹配；关闭程序后重启再试。
- ChatGPT 登录停住：确认浏览器能访问 OpenAI，取消当前登录后重试；需要时先退出再重新登录。
- Credential helper 报错：确认 Windows Credential Manager 服务可用，安全软件没有拦截 `credential-helper.exe`，再重新保存或删除凭据。
- Kimi / DeepSeek 获取模型失败：检查网络、API Key、Base URL 和服务状态；自定义地址必须包含正确的 API 根路径。
- HTTP 401/403 通常表示凭据或账号权限问题；429 表示限流；5xx 通常是服务端或网关临时故障。程序会对适合重试的错误有限重试。
- 辩论恢复后没有继续：这是预期行为，请手动点击“继续”。

## 已知限制

- 当前仅支持两个角色，不支持三方或更多模型同时交流。
- 发布物未签名，因此可能显示 SmartScreen 警告。
- 所有模型都依赖在线 API 或 ChatGPT 服务，离线不可用，且可能产生服务商费用。
- 便携版“无需安装”不等于“零写入”：它仍会写入每用户数据目录和 Windows Credential Manager。
- 自动化验收不代替真实账号的人工登录、退出/重新登录与服务商计费检查。

开发、协议映射与发布验收详见 [官方 API 来源](docs/official-api-sources.md) 和 [Windows 冒烟测试](docs/windows-smoke-test.md)。
