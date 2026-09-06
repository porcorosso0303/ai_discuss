# Windows 便携版冒烟测试

目标环境：干净的 Windows 10/Windows 11 x64 普通用户，无需管理员权限。真实账号和付费 API 步骤必须由发布者人工执行；不得把密钥、token 或授权响应粘贴到本记录。

## 发布记录

| Item | Expected | Actual | Pass | Notes |
| --- | --- | --- | --- | --- |
| 自动化单元/合同测试 | 全部通过，live 默认显示 skipped | 2026-08-30：43 个测试文件通过、1 个文件 skipped；780 项通过、5 项 skipped，其中 3 项为 live | Pass | 未设置真实 API 环境变量 |
| Windows 构建与结构校验 | portable、Codex、credential helper 均为 x64，固定版本通过 | 2026-09-02：Windows 11 x64（10.0.26200）全新隔离目录构建；Codex 0.147.0 与两个 PE x64 校验通过 | Pass | 单一 tgz 经 Windows 原生 tar 解压；`npm ci` 使用独立 Windows `node_modules` |
| 中文路径启动 | EXE 在中文目录启动，10 秒后进程仍存活 | 2026-09-02：从 `AI辩论终验-20260902-final` 启动；15 秒后本次新增 PID 4032、19604、21524、26940、28152 共 5 个进程存活、1 个有窗口；隔离 `%LOCALAPPDATA%/AI Debates` 已创建 | Pass | 仅按本次新增 PID 停止；3 秒后相关残留为 0 |

最终发布物（2026-09-02）：`dist/AI-Debates-Portable-x64.exe`，144,826,755 bytes，SHA-256 `f92690855ebce024b78e3672e2d9c8c8000a221ed7de845e173eba0249691f44`。构建未签名。

## 2026-09-02 最终构建验证矩阵

| Command | Actual | Pass | Notes |
| --- | --- | --- | --- |
| `npm test -- --reporter=dot` | 780 passed、5 skipped | Pass | 3 个 live provider 测试因无 opt-in 环境变量跳过；另有 2 个既有条件测试跳过 |
| `npm run typecheck` | exit 0 | Pass | renderer/main 两套 TypeScript 配置 |
| `npm run lint` | 152 个源文件检查通过 | Pass | 检查 NUL、合并标记、行尾空白、末尾换行和大小上限 |
| `npm run build` | main/preload/renderer 构建成功 | Pass | 2026-09-02 fresh build，exit 0 |
| `npm run test:e2e` | 6 passed | Pass | 包含中文话题、100 条边界、暂停/继续、认输、重试、历史导出和 renderer 隔离 |
| Linux credential helper Go test（见下方命令） | credential helper tests passed | Pass | 从模块目录运行并使用全新缓存；系统默认 Go cache 曾无法解析 stdlib |
| `npm run build:credential-helper` | exit 0 | Pass | 2026-09-02 fresh 生成 Windows amd64 helper |
| `npm run stage:codex` / `npm run verify:staged-runtime` | Codex 0.147.0、Codex/helper PE x64 通过 | Pass | Linux 与全新 Windows 隔离目录分别校验通过 |
| `npm audit --omit=dev` | 0 vulnerabilities | Pass | Windows fresh `npm ci` 报告 0；Linux 结果沿用完整门禁记录 |
| Windows `npm run dist:win` / `npm run verify:artifact` | portable 结构、大小与哈希通过 | Pass | 首次下载遇到瞬时 DNS `EAI_AGAIN`；DNS 恢复后在同一 fresh 目录重试通过，未签名 |

Linux/WSL 本次实际执行：

```bash
cd native/credential-helper
GOCACHE=/tmp/ai-debates-go-cache go test ./...
```

Windows PowerShell 若已安装 Go，应从同一模块目录运行：

```powershell
Set-Location native/credential-helper
go test ./...
```

## 干净 Windows 10/11 x64 人工清单

| Step | Expected | Actual | Pass | Notes |
| --- | --- | --- | --- | --- |
| 从中文路径双击便携版 | 无需管理员权限即可出现窗口 | 自动 `Start-Process` 已出现窗口；人工双击 Not Run | Not Run | 自动基础启动结果见发布记录；仍需真人双击确认 |
| SmartScreen | 未签名程序出现可解释警告；核对哈希后可启动 | Not Run | Not Run | 不建议关闭系统防护 |
| 进程检查 | 主程序、Codex/helper 仅在需要时出现 | 基础启动按精确 PID 清理后无残留；Codex/helper 登录生命周期 Not Run | Not Run | 需真人登录后复核 |
| OpenAI 登录 | 浏览器打开官方 ChatGPT 登录，返回后显示已登录 | Not Run | Not Run | 需要人工完成，不自动化 |
| OpenAI 退出与重新登录 | 退出后显示未登录；可再次登录 | Not Run | Not Run | 需要人工完成 |
| Kimi Key 设置/读取 | 保存后连接测试成功，界面不回显完整 Key | Not Run | Not Run | 使用专门测试 Key，不触碰现有固定 target |
| DeepSeek Key 设置/读取 | 保存后连接测试成功，界面不回显完整 Key | Not Run | Not Run | 使用专门测试 Key，不触碰现有固定 target |
| Kimi/DeepSeek 凭据删除 | 点击删除后连接需重新提供 Key | Not Run | Not Run | 检查 Windows Credential Manager |
| 明文检查 | settings/history/log/export 均无 API Key 或 token | 自动化边界测试通过；真实 Key 指纹检查 Not Run | Not Run | 只搜索专门测试 Key 指纹，不记录 Key |
| Mock 双角色流程 | 配置、先发角色、发言时间线和结果正确 | 自动 E2E 覆盖 agree/concede；人工清单 Not Run | Not Run | 自动部分 Pass |
| 真实短辩论 | Kimi、DeepSeek、Codex 可各完成一条结构化回应 | Not Run | Not Run | 无真实凭据；控制 token 与费用 |
| 暂停/继续 | 暂停不再发起下一轮，继续后恢复 | 自动 E2E Pass；人工清单 Not Run | Not Run |  |
| 停止 | 当前请求取消并显示停止结果 | 单元/组件测试通过；人工清单 Not Run | Not Run |  |
| 历史恢复 | 中文话题可加载，显示“等待用户继续”且不自动调用 | 自动测试通过；人工清单 Not Run | Not Run | 手动点击继续 |
| Markdown 导出 | 中文内容完整且无凭据 | 自动 E2E Pass；人工文件查看 Not Run | Not Run | UTF-8 中文内容已由测试读取 |
| 关闭应用 | 窗口关闭，Codex/helper 子进程退出 | 自动冒烟按本次 PID 停止后残留为 0；正常点关闭 Not Run | Not Run | 任务管理器人工确认待办 |

## Live tests

默认运行 `npm test` 时三个真实服务测试全部 skip。按服务单独提供环境变量：

- Kimi：`RUN_KIMI_LIVE_TEST=1` 和 `KIMI_API_KEY`
- DeepSeek：`RUN_DEEPSEEK_LIVE_TEST=1` 和 `DEEPSEEK_API_KEY`
- Codex：`RUN_CODEX_LIVE_TEST=1`、绝对路径 `CODEX_BIN`（必须为 0.147.0）和绝对文件路径 `CODEX_AUTH_SOURCE`（已有 ChatGPT 登录的 `auth.json`）

仅设置 API Key 不会启用 live test，也不会构造 provider 或发起网络请求。任一 `RUN_*_LIVE_TEST=1` 已设置但对应凭据缺失或为空白时，测试必须用固定消息明确失败，不会静默跳过，也不会打印 secret。CI 不设置上述 RUN_*_LIVE_TEST 开关。测试使用临时隔离目录、短输出、超时和 finally 清理。
