# Development Notes

## 2026-04-11 — Phase 1: Foundation

### What was built

Phase 1 搭建了 Persona Engine 的基础骨架：monorepo 脚手架、配置管理、SQLite 事件存储、HTTP API、终端 TUI、CLI 命令。

### Tech decisions made

| Decision | Choice | Reason |
|----------|--------|--------|
| Package manager | pnpm + workspace | 原生 monorepo 支持，磁盘高效 |
| Node target | 22+ (ES2023) | 用户当前环境 Node 25 |
| Onboarding UI | @clack/prompts | 专为 CLI wizard 设计（Phase 2 用） |
| Daemon TUI | Ink (React for CLI) | 组件化开发，实时更新 |
| Build tool | tsup (esbuild-based) | 快速，零配置 |
| CLI framework | Commander.js | 轻量，成熟 |

### Files created

```
packages/daemon/src/
  ├── index.tsx       — Daemon 入口：启动 server + TUI + PID file + graceful shutdown
  ├── config.ts       — ~/.persona-engine/config.json 读写，深度合并默认值
  ├── server.ts       — Fastify HTTP API (POST /api/events, POST /api/events/batch, GET /api/status)
  ├── db/events.ts    — SQLite (WAL mode) events 表 CRUD + getTodayStats
  └── tui/
      ├── App.tsx       — TUI 根组件，布局 + 快捷键（支持非 TTY 环境）
      ├── EventFeed.tsx — 实时事件流，含 deep read / idle 判定
      └── Summary.tsx   — 今日统计面板

packages/cli/src/
  ├── index.ts              — Commander 命令路由
  └── commands/
      ├── start.ts          — persona start（前台/后台模式）
      ├── stop.ts           — persona stop（SIGTERM via PID file）
      └── status.ts         — persona status（调用 /api/status）
```

### Issues encountered & resolved

1. **better-sqlite3 native addon** — pnpm 10 默认不运行 install scripts，需要在 `pnpm-workspace.yaml` 设置 `onlyBuiltDependencies`。且 `node-gyp` 不在全局 PATH，需要用 `npx node-gyp` 手动编译。
2. **Ink raw mode error** — 后台运行时 stdin 不是 TTY，`useInput` 会崩溃。修复：加 `isActive: isInteractive` 检测 `process.stdin.isTTY`。
3. **@types/better-sqlite3** — 最新版本是 7.6.13 不是 7.6.14，pnpm 严格版本匹配报错。

### Design note: deep read vs idle

用户提出了一个重要问题：单纯挂机不应算深度阅读。当前方案：
- TUI 层：dwell > 5min 且 < 45min → "deep"，> 45min → "idle?"（保守估计）
- 真正的智能判定在 Phase 3（扩展端 visibilitychange 追踪活跃时间）和 Phase 4（dreaming 内容分类）

### Verification results

- `pnpm build` 编译成功
- `persona start --background` 后台启动 daemon
- `curl POST /api/events` 返回 201 + event id
- `curl POST /api/events/batch` 批量插入成功
- `curl GET /api/status` 返回完整统计
- TUI 实时刷新事件流和统计面板
- `persona status` 显示 daemon 运行状态
- `persona stop` 正常关闭 daemon

## 2026-04-13 — Phase 2: Onboarding + Directory Scan

### What was built

Phase 2 实现了完整的 onboarding 流程：交互式问卷、目录扫描、LLM 生成 USER.md、用户审核/编辑/带反馈重新生成。运行 `persona onboard` 即可从零开始构建用户 persona。

### Tech decisions made

| Decision | Choice | Reason |
|----------|--------|--------|
| LLM provider | OpenAI (gpt-5.4) | 用户指定使用 OpenAI API |
| LLM SDK | Vercel AI SDK (`ai` + `@ai-sdk/openai`) | 多 provider 支持，PRD 推荐 |
| Onboarding UI | @clack/prompts | Phase 1 已决定 |
| 问卷字段 | name, birthday, pronouns, timezone, occupation, interests, social profiles | 用户要求合并 name/preferred name 为单一字段，增加 birthday，增加社交媒体链接 |
| 文档扫描 | 文件名作为标题信号（不解析内容） | PDF/Word/Excel/Apple iWork 文件只取文件名，避免复杂解析依赖 |

### Files created

```
packages/daemon/src/onboarding/
  ├── questionnaire.ts  — 交互式问卷（@clack/prompts），收集用户信息和目录
  ├── scanner.ts        — 目录扫描器：树结构 + 关键文件 + 文档检测（PDF/Word/Excel/Pages/Numbers/Keynote）
  ├── llm.ts            — LLM 客户端工厂（Vercel AI SDK + OpenAI provider）
  └── generator.ts      — USER.md 生成器，支持带用户反馈的重新生成

packages/cli/src/commands/
  └── onboard.ts        — `persona onboard` 完整流程命令

templates/
  └── USER.md           — 默认 persona 模板（含 birthday 字段）
```

### Files modified

- `packages/daemon/src/config.ts` — 新增 `USER_MD_PATH`、`isOnboarded()`，默认 LLM 改为 OpenAI/gpt-5.4；数据目录从 `~/.persona-engine/` 改为 `<project>/persona-engine/`
- `packages/cli/src/index.ts` — 注册 onboard 命令
- `packages/cli/src/commands/start.ts` — 从 config.ts 导入 PID_FILE，不再硬编码 `~/.persona-engine/` 路径
- `packages/cli/src/commands/stop.ts` — 同上
- `packages/cli/src/commands/status.ts` — 同上，使用 loadConfig() 读取端口号
- `packages/daemon/package.json` — 新增依赖：ai, @ai-sdk/openai, @ai-sdk/anthropic, @clack/prompts
- `packages/cli/package.json` — 新增依赖：@clack/prompts, ai, @ai-sdk/openai
- `.gitignore` — `.persona-engine/` 改为 `persona-engine/`

### Design decisions

1. **Onboarding 不依赖 daemon 运行** — onboarding 是独立的 CLI 流程，直接 import daemon 的 onboarding 模块源码（通过相对路径），tsup 打包时内联。
2. **重新生成带反馈** — 用户选择 regenerate 时可以输入修改意见（如"多加 Python 经验描述"），LLM 会基于上一版 USER.md + 反馈进行修改。
3. **目录扫描兼容非技术文件夹** — 不仅扫描代码项目，也检测普通文档文件（PDF, Word, Excel, Apple iWork），用文件名作为内容信号。
4. **已有 persona 检测** — 重复运行 `persona onboard` 会提示 reset/update/cancel。
5. **社交媒体收集** — 问卷中收集 LinkedIn、X (Twitter)、Instagram 及其他社交/作品集链接（均为可选），传给 LLM 以生成更丰富的用户画像。
6. **必填字段防空输入** — 必填问题（name、occupation、API key）使用 `requiredText()` / `requiredPassword()` 循环，空输入时重新提示而非终止流程。
7. **系统原生目录选择器** — macOS 上使用 `osascript choose folder` 弹出 Finder 文件夹选择对话框，用户可视化选择目录，无需手动输入路径。非 macOS 回退为手动输入。
8. **数据目录改为项目内非隐藏目录** — 从 `~/.persona-engine/`（用户主目录隐藏文件夹）改为 `<project>/persona-engine/`（项目目录内可见文件夹）。通过 `import.meta.dirname` 从构建产物位置反推项目根目录，CLI 和 daemon 两端路径一致。所有 CLI 命令统一从 config.ts 导入路径常量，不再各自硬编码。

### Verification results

- `pnpm build` 编译成功
- `persona onboard --help` 正常显示帮助信息
- CLI 命令列表包含 onboard（排在 start/stop/status 之前）
- 数据目录路径正确解析：CLI 和 daemon 均指向 `<project>/persona-engine/`
