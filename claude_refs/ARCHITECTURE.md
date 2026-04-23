# Claude Code Power - 程序架构文档

> 📐 本文档为 Claude Code 开发时的架构参考。
> 描述 `claude_code_power` 外部插件的系统结构、模块关系和数据流。
> 宿主架构详见 `termcat_client/claude_refs/ARCHITECTURE.md`。

---

## 1. 概述

### 🎯 产品定位

**Claude Code 会话增强面板** —— 在 TermCat 终端里检测到运行中的 `claude` 进程后，右侧边栏自动注入一个面板，提供：

- **Drive 模式切换**：`default` / `acceptEdits` / `plan` / `bypassPermissions` 四种权限模式的查看与一键切换
- **提问历史 + Undo**：按时间倒序列出当前 session 的每条 prompt，支持 `/rewind` 回滚
- **调用详情**：按 prompt 分组展示每次调用的 tool_use（内置 / Skill / MCP / Sub-agent）与加载的规则/上下文文件
- **多套模型 Preset**：管理多组 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` 配置，一键切换并启动

### 设计原则

1. **只读本地文件**：数据全部来自 `~/.claude/projects/<hash>/*.jsonl` 与 `~/.claude/settings.json`，**不装 hook**，**不改用户全局配置**
2. **默认"填入不回车"**：大部分向终端注入的命令停在输入行（`Ctrl+U` + 文本，不发 `\r`），用户按 Enter 才执行。**唯一例外**：header 上的 launch 按钮属于显式"立即启动"手势，会直接回车执行
3. **面板跟随激活 tab**：切 tab 面板内容跟着切；两个 tab 同时跑 claude 互不干扰
4. **零外部服务**：全部逻辑在 Electron Main 进程内运行，不 fork 子进程、不监听网络端口

### 技术栈

| 层次 | 技术 |
|------|------|
| 运行环境 | Electron Main 进程（被 TermCat PluginManager 加载） |
| 语言 | TypeScript 5 |
| 文件监听 | chokidar 3（JSONL + settings.json + presets.json） |
| 进程遍历 | pidtree 0.6（跨平台子进程枚举） |
| ID 生成 | uuid v9 |
| 构建工具 | esbuild（单文件 bundle → `dist/extension.js`） |
| UI 渲染 | TermCat UI 贡献点系统（声明式 section 树，宿主渲染） |

### 单进程模型

```
┌─────────────────────────────────────────────────────┐
│             Electron Main Process                   │
│  ┌───────────────────────────────────────────────┐  │
│  │  PluginManager                                │  │
│  │  └── activate(context) → extension.ts         │  │
│  │      ├── Store          状态存储              │  │
│  │      ├── PresetStore    Preset + active.env   │  │
│  │      ├── SettingsReader settings.json 读写    │  │
│  │      ├── Detector       5s 轮询进程树 + JSONL │  │
│  │      ├── JsonlWatcher   chokidar 增量解析     │  │
│  │      ├── PtyInjector    Ctrl+U + 文本         │  │
│  │      └── UI 贡献点      setPanelData(sections)│  │
│  └──────────────┬────────────────────────────────┘  │
└─────────────────┼───────────────────────────────────┘
                  │ Host API (context.api)
┌─────────────────▼───────────────────────────────────┐
│         Renderer Process (React)                    │
│  ├── PanelRenderer                                  │
│  │   ├── header / drive-mode / preset / history ... │
│  │   └── 用户操作 → onEvent(sectionId, eventId)     │
│  └── 用户动作（切 preset / 切 mode / rewind）        │
│      → handlePanelEvent → PtyInjector.fillLine()    │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
              ┌──────────────────┐
              │  Terminal (PTY)  │
              │  └─ zsh          │
              │       └─ claude  │
              │           └─ JSONL 写入 ~/.claude/…/ │
              └──────────────────┘
                       │
                       │ chokidar 增量监听
                       ▼
                 JsonlWatcher → SessionIndex
```

---

## 2. 目录结构（自动生成区域）

> 💡 此区域由 `scripts/update_architecture_manifest.py` 自动维护，
> 通过 Claude Code Hook（PostToolUse → Write|Edit）触发更新。
> 手动编辑会被下一次 hook 覆盖。

<!-- AUTO-GENERATED:START -->
<!-- 自动生成，请勿手动编辑此区域 | Auto-generated, do not edit manually -->
<!-- 最后更新: 2026-04-21 14:39:31 -->

```
claude_code_power/
├── esbuild.config.mjs
├── package.json
├── tsconfig.json
└── src/
    ├── extension.ts                            # Claude Code Power — plugin entry.
    ├── i18n.ts
    ├── actions/
    │   ├── commands.ts                         # All Claude Code slash literals in one place — easy to patch when Claude renames.
    │   ├── drive-mode.ts
    │   ├── launch.ts
    │   ├── preset-apply.ts
    │   ├── preset-store.ts
    │   ├── preset-types.ts
    │   ├── pty-inject.ts
    │   └── rewind.ts
    ├── core/
    │   ├── event-bus.ts
    │   ├── state.ts
    │   └── types.ts
    ├── data/
    │   ├── jsonl-parser.ts
    │   ├── jsonl-watcher.ts
    │   ├── project-hash.ts
    │   ├── rule-file-detector.ts
    │   ├── session-index.ts
    │   ├── settings-reader.ts
    │   └── types.ts                            # Claude Code permission modes. Matches claude's JSONL `permissionMode` field.
    ├── detector/
    │   └── process-watcher.ts
    ├── locales/
    │   ├── en.ts
    │   ├── es.ts
    │   ├── index.ts
    │   └── zh.ts
    └── ui/
        ├── event-handlers.ts
        ├── msg-block-adapter.ts
        ├── msg-block-types.ts                  # Minimal MsgBlock shape mirrored from host `src/shared-components/msg-viewer/types.ts`.
        └── panel-layout.ts
```

<!-- AUTO-GENERATED:END -->

---

## 3. 核心概念

### 3.1 TabStatus — 每个终端 tab 的运行状态

```typescript
type TabStatus = 'idle' | 'active' | 'active-idle' | 'stale';
```

| 状态 | 含义 | 判定 |
|------|------|------|
| `active` | 正在活跃使用 | shell 子树里有 claude 进程 **且** 该 cwd 下最新 JSONL mtime < 60s |
| `active-idle` | claude 进程存在但空闲 | 有 claude 进程但 JSONL 超过 60s 无更新 |
| `stale` | 进程已退出但近期跑过 | 无 claude 进程，但全局最新 JSONL < 24h |
| `idle` | 无 claude 活动 | 其他情况 |

**后果**：
- `active` / `active-idle` 时面板显示「实时控制」区（drive-mode slash、launch 按钮）
- 切 drive mode 时，`active*` 走 `/permission-mode` slash；其他状态询问是否改 `settings.json`

### 3.2 PermissionMode — Claude Code 五种权限模式

```typescript
type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';
```

插件识别两个来源：
- **Session 级**：从当前 session JSONL 的最后一条 `permissionMode` 字段
- **全局默认**：`~/.claude/settings.json` 的 `permissions.defaultMode`

Session 级优先于全局默认，UI 用不同颜色区分 `driveSource: 'session' | 'default'`。

### 3.3 Preset — 一组 Claude Code 环境变量

```typescript
interface Preset {
  id: string;                         // uuid
  name: string;                       // 用户可见名称
  apiKey?: string;                    // → ANTHROPIC_API_KEY
  authToken?: string;                 // → ANTHROPIC_AUTH_TOKEN
  baseUrl?: string;                   // → ANTHROPIC_BASE_URL
  model: string;                      // → ANTHROPIC_MODEL（也用于 /model slash）
  maxTokens?: number;                 // → ANTHROPIC_MAX_TOKENS
  extraEnv?: Record<string, string>;  // 自定义 export
}
```

切 preset 时的行为分两种路径：
- **活跃 tab 有 claude 在跑**：对比新旧 preset，`onlyModelChanged` → 注入 `/model <name>`；否则 writeActiveEnv + 提示用户 `exit` 重启
- **活跃 tab 无 claude**：仅 writeActiveEnv，下次用户点 `launchClaude` 按钮会重新 source

### 3.4 PromptTurn — JSONL 主分支上一次用户交互的全部事件

```typescript
interface PromptTurn {
  index: number;                                              // 1-based
  userEvent: Extract<NormalizedEvent, { kind: 'user-prompt' }>;
  assistantEvents: Array<Extract<NormalizedEvent, { kind: 'assistant-msg' }>>;
  attachments: Array<Extract<NormalizedEvent, { kind: 'attachment' }>>;
}
```

由 `SessionIndex` 通过 `parentUuid` 链走出主分支得到，用于：
- 提问历史列表
- 调用详情展开（展示 tool_use + skill/mcp 分类）
- `/rewind` 时计算 steps

---

## 4. 检测流程（Detector）

每 5 秒执行一次 `tick()`：

```
┌────────────────────────────────────────┐
│ 1. listProcesses() — ps -A             │
│    POSIX: `ps -A -o pid=,ppid=,comm=`  │
│    Win:    wmic process get ...        │
└──────────────┬─────────────────────────┘
               ▼
     Map<pid, ProcessRow>
               │
               ▼
┌────────────────────────────────────────┐
│ 2. 对每个已知 terminal tab 并行处理：   │
│    shellPid = host.getPid(sessionId)   │
│    descendants = pidtree(shellPid)     │
│    claudePid = 查找 name==='claude'    │
└──────────────┬─────────────────────────┘
               ▼
┌────────────────────────────────────────┐
│ 3. 有 claudePid：                       │
│    cwd = lsof -p <pid> / /proc/<pid>/cwd│
│    sessionFile = 最新 mtime *.jsonl    │
│    fresh = now - mtime < 60s           │
│    status = fresh ? 'active' :         │
│             'active-idle'              │
│   无 claudePid：                        │
│    globalLatestJsonlMtime < 24h →      │
│      'stale'，否则 'idle'               │
└──────────────┬─────────────────────────┘
               ▼
        onTabState(newState) → Store.upsertTab
                              → scheduleUiRefresh()
```

**关键细节**：
- `pidtree` 失败时回退到 `ppid` 链遍历（`walkDescendants`）
- macOS 用 `lsof -Fn` 读取进程 cwd，Linux 用 `/proc/<pid>/cwd`，Windows 用 JSONL 反推
- 整个 tick 串行，`running` flag 防重入

---

## 5. JSONL 数据流

### 5.1 路径编码

Claude Code 把 cwd 编码到目录名：所有非字母数字字符替换为 `-`：

```
/Users/dum/work/foo               → -Users-dum-work-foo
/Users/dum/Vmware_Share/dum_dev/x → -Users-dum-Vmware-Share-dum-dev-x
```

所以 `~/.claude/projects/<encoded>/` 下放着一份或多份 `<uuid>.jsonl`（一个 session 一个文件）。

### 5.2 JsonlWatcher — 增量监听 + 背压合并

```
chokidar.watch(projectDir/*.jsonl)
  ↓ change 事件
读取 [byteOffset, 文件末尾)
  ↓ 按行 parseJsonlLine → normalizeEvents
累积到 FileState.buffered[]
  ↓ 200ms 防抖 或 buffered.length > 200
flush → listener(filePath, events[])
```

**ref-counting**：JsonlWatcher 按 projectDir 去重。插件维护 `watchers = Map<projectDir, JsonlWatcher>`，同 projectDir 的多个 tab 共用一个 watcher。

**容错**：
- 连续 50 次解析失败 → 标记 corrupted，触发 `onCorrupt` 通知面板
- 字节偏移出错（文件被截断）→ 重置 offset

### 5.3 SessionIndex — 主分支 + permissionMode 提取

每个 JSONL 文件一个 `SessionIndex` 实例。职责：
- 按 `uuid` 入表
- 按 `parentUuid` 链走出"主分支"（Claude Code 的多分支 session 里只显示最新一条主链）
- 缓存 `getLatestPermissionMode()` 用于 drive-mode 对齐
- 缓存 `getPromptTurns()` 用于面板渲染

### 5.4 NormalizedEvent — 归一化事件类型

```typescript
type NormalizedEvent =
  | { kind: 'user-prompt';   uuid, parentUuid, ts, permissionMode, text }
  | { kind: 'assistant-msg'; uuid, parentUuid, ts, text, toolUses: ToolUse[] }
  | { kind: 'attachment';    uuid, parentUuid, ts, hookEvent, content }
  | { kind: 'chain-link';    uuid, parentUuid, ts };   // 占位，保持链完整
```

**ToolUse 分类**（`classifyTool`）：
```typescript
name === 'Skill'           → kind: 'skill'
name.startsWith('mcp__')   → kind: 'mcp'
name === 'Task'            → kind: 'task'
其他                        → kind: 'builtin'
```

---

## 6. 状态管理

### 6.1 Store（core/state.ts）

```typescript
interface AppState {
  stage: 'NoPreset' | 'Ready';
  activeTabSessionId: string | null;
  perTabStates: Map<sessionId, PerTabState>;
  pendingDrive: Map<sessionId, PendingDrive>;        // /permission-mode 注入后的 60s 观察窗口
  activePresetId: string | null;
  sessionsByProjectDir: Map<dir, SessionMeta[]>;
  selectedSessionFileByTab: Map<sessionId, string | null>;
  selectedTurnIndexByTab: Map<sessionId, number | null>;
  expandedTurnsByTab: Map<sessionId, Set<number>>;
  viewingRuleFileByTab: Map<sessionId, Map<number, string>>;
  gotoByTab: Map<sessionId, { nonce, blockId }>;     // 面板滚动请求
  gotoCounter: number;
}
```

**原则**：
- Store 只持有**运行时状态**，不做持久化
- 持久化状态分别交给 `PresetStore`、`SettingsReader`
- 所有对 Store 的修改走 `setXxx()` 方法，保证面板刷新触发

### 6.2 面板刷新：`scheduleUiRefresh()`

200ms 防抖：
```typescript
let uiRefreshTimer: NodeJS.Timeout | null = null;
function scheduleUiRefresh() {
  if (uiRefreshTimer) return;
  uiRefreshTimer = setTimeout(() => {
    uiRefreshTimer = null;
    pushPanelData();
  }, 200);
}
```

`pushPanelData()` 把当前 `AppState` → `panel-layout.ts` → `SectionDescriptor[]` → `api.ui.setPanelData(PANEL_ID, sections)`。

---

## 7. 用户交互与 PTY 注入

### 7.1 PtyInjector 的核心契约

```typescript
async fillLine(sessionId, text) {
  await write(sessionId, '\x15');       // Ctrl+U: 清空当前输入行
  if (text) await write(sessionId, text); // 写入新文本
  await focus(sessionId);                 // 聚焦终端
  // 默认不发 '\r' — 用户按 Enter 才执行
}

async sendLine(sessionId, text) {
  await write(sessionId, '\x15');
  if (text) await write(sessionId, text);
  await write(sessionId, '\r');           // 立即执行（目前仅 injectLaunchCommand 使用）
}
```

**per-session 队列化**：并发调用 `fillLine` 时按 sessionId 串行，防止 Ctrl+U / 文本 对被交错破坏。

### 7.2 三大用户动作

| 动作 | 入口 | 流程 |
|------|------|------|
| 启动 claude | `launchClaude` 命令 / header 按钮 | `writeActiveEnv(preset)` → `sendLine(set -a; source '...'; set +a; claude)` — **自动回车执行** |
| 切 drive mode | drive-mode 行的循环按钮（icon: rotate-cw） | 读当前 mode，`active*` 时发一次 Shift+Tab（`pressKey('\x1b[Z', 1)`）推进到下一个 mode；否则 `showConfirm` → `writeDefaultPermissionMode`。循环顺序：`default → acceptEdits → plan → auto → default`。UI 只暴露"下一步"按钮而非绝对跳转，因为 claude 的输入处理会合并短时间内相同的转义序列，无法保证"按 N 次 Shift+Tab"精准落地。`bypassPermissions` 无法通过键盘进入/退出 |
| 切 preset | preset 下拉 | `setActive` + `writeActiveEnv` → 活跃 claude 且仅 model 变 → `fillLine('/model <name>')`；否则 `showConfirm` 提示退出 claude |
| Rewind | 历史列表上的 undo | 弹窗确认 → `fillLine('/rewind')`（v1 未验证数字参数）+ 文本提示「手动按 N 次 ↑」 |

---

## 8. UI 贡献点集成

### 8.1 声明式面板

插件不直接渲染 DOM，而是输出 `SectionDescriptor[]` 给 TermCat 宿主：

```typescript
interface SectionDescriptor {
  id?: string;
  template: string;    // 'header' | 'select' | 'list' | 'msg-viewer' | ...
  data: unknown;       // 模板消费的 data（结构由模板约定）
  collapsible?: boolean;
  variant?: 'default' | 'compact' | 'card' | 'nested';
}
```

宿主的 `PanelRenderer.tsx` 遍历数组，按 `template` 查表渲染 `TemplateComponent`。

### 8.2 事件回流

用户点击面板里的 button / select / item，宿主发射 `(sectionId, eventId, payload)` → 插件的 `handlePanelEvent`：

```typescript
// src/ui/event-handlers.ts 片段
if (sectionId === 'header' && eventId === 'launchClaude') {
  await injectLaunchCommand(sid, deps.presetStore.activeEnvPath(), deps.injector);
}
```

### 8.3 msg-viewer 复用

调用详情面板复用宿主的 `shared-components/msg-viewer` 控件：
```
PromptTurn[] → ui/msg-block-adapter.ts → MsgBlock[] → msg-viewer (virtualized list)
```

MsgBlock 类型对齐宿主 `termcat_client/src/shared-components/msg-viewer/types.ts`。

---

## 9. 配置持久化

### 9.1 文件位置

```
~/.termcat/plugins/claude_code_power/
├── presets.json                   mode 600, {version, activePresetId, presets[]}
├── active.env                     mode 600, shell-source 格式
└── state.json                     (预留，v1 未使用)
```

目录创建 mode 为 `0o700`；`writeActiveEnv` 用「写 tmp → rename」保证原子性。

### 9.2 active.env 格式

```bash
# Generated by TermCat claude-code-power plugin - do not edit
# Active preset: <name> (<uuid>)
# Generated at: <ISO 8601>

export ANTHROPIC_API_KEY='xxxxx'
export ANTHROPIC_AUTH_TOKEN='yyyyy'
export ANTHROPIC_BASE_URL='https://...'
export ANTHROPIC_MODEL='claude-sonnet-4-5'
```

启动命令规范：`set -a; source '<path>'; set +a; claude`

单引号里的引号用 `'\''` 转义（`shellEscape` 实现）。

### 9.3 外部编辑自动刷新

`PresetStore` 用 chokidar 监听 `presets.json`，过滤掉自身 write 的 echo（比对 mtime 差值 < 5ms），其他外部改动触发 `onDidChange` → `scheduleUiRefresh`。

`SettingsReader` 同样监听 `~/.claude/settings.json`，变化时重读 `defaultMode`。

---

## 10. 插件生命周期

### 10.1 activate 入口

```typescript
export async function activate(context: PluginContext): Promise<void> {
  // 1. 依赖注入：context.api 提供 terminal / ui / commands / events API
  // 2. 构造 Store / PresetStore / SettingsReader / PtyInjector
  // 3. presetStore.load() → 决定 stage = 'NoPreset' | 'Ready'
  // 4. 注册 panel (sidebar-right, defaultVisible: false)
  // 5. 注册 commands: togglePanel / launchClaude
  // 6. 监听 terminal:open / close / active-change
  // 7. 启动 Detector（立即 tick 一次 + 5s interval）
  // 8. 启动 driveReapTimer（5s 清理超时 pendingDrive）
  // 9. 推送初始面板
}
```

### 10.2 activationEvents

`package.json` 声明：

```json
"activationEvents": ["onStartup", "onTerminalOpen"]
```

TermCat 启动或打开第一个终端时激活。

### 10.3 deactivate

所有 `disposables` 逐个 dispose：
- 关闭 chokidar watcher
- 清理 setTimeout / setInterval
- 释放 JsonlWatcher ref-count → 0 时关闭底层 watcher

---

## 11. Host API 使用面

插件只通过 `context.api` 操作宿主，不直接 import 宿主模块：

| API | 用途 |
|-----|------|
| `api.terminal.getActiveTerminal()` | 获取当前活跃 tab |
| `api.terminal.getTerminals()` | 枚举所有 tab |
| `api.terminal.getPid(sessionId)` | 拿到 tab 的 shell pid（进程检测入口） |
| `api.terminal.write(sessionId, data)` | PtyInjector 底层 |
| `api.terminal.focus(sessionId)` | 注入后自动聚焦 |
| `api.terminal.onDidOpenTerminal / onDidCloseTerminal` | 维护 knownTerminals |
| `api.ui.registerPanel(opts, onEvent)` | 注册右侧边栏面板 |
| `api.ui.setPanelData(panelId, sections)` | 刷新面板内容 |
| `api.ui.showNotification / showConfirm / showInputBox / showForm / showMessage` | 用户交互弹窗 |
| `api.commands.registerCommand(id, handler)` | 注册命令面板可调用命令 |
| `api.events.emit / on` | 插件与宿主的事件总线（用于 tab 激活变化） |

---

## 12. 国际化

```typescript
import { setLanguage, t } from './i18n';
setLanguage('zh');           // 或 'en' / 'es'
t().launchClaudeButton       // → "启动 Claude" / "Launch Claude" / "Iniciar Claude"
```

所有用户可见文本走 `src/locales/*`。`t()` 是 getter，每次调用返回当前语言对应的字符串表。

---

## 13. 构建

```bash
npm install
npm run build          # esbuild → dist/extension.js
npm run pack           # build + tar.czf claude-code-power.tgz
```

### 构建输出

```
dist/
└── extension.js       # Main 进程入口（CJS bundle）
```

esbuild 配置：
- platform: `node`
- format: `cjs`
- target: 对齐 Electron 的 Node 版本
- external: `electron`（由宿主提供）
- chokidar / pidtree / uuid → 打包进去

### 安装到 TermCat

将 `claude-code-power.tgz` 放到 TermCat 用户数据目录的 `plugins/claude-code-power/` 下，或直接复制 `dist/` 整个目录。

---

## 14. 安全与隐私

| 项 | 策略 |
|----|------|
| API Key / Auth Token | 仅写入 `~/.termcat/plugins/claude_code_power/{presets.json, active.env}`，mode 600 |
| 显示掩码 | `maskSecret`：前 6 位 + `...` + 后 4 位（长度 ≤ 10 → `***`） |
| 不回车 | 所有向 PTY 的写入永远不带 `\r`，用户手动按 Enter |
| 不装 hook | 不修改 `~/.claude/settings.json.hooks`，不污染 Claude 的 hook 链 |
| 不连网 | 插件不建立任何 HTTP / WebSocket 连接 |
| settings.json 补丁式写 | `writeDefaultPermissionMode` 只改 `permissions.defaultMode`，保留其他键 |

---

## 15. 与宿主的层级关系

```
termcat_client base (http/logger/i18n)
  ↓
core (plugin/terminal/pty …)
  ↓
plugins/ (plugin-manager / plugin-api)
  ↓
plugins/external (claude_code_power)  ← 本插件
```

**原则**：
- 插件是 Electron Main 进程里的**动态加载模块**，通过 `context.api` 访问宿主
- 插件不直接 import 宿主 `src/` 下任何模块，仅通过 API 约定交互
- UI 侧通过 **声明式 section 树** 由宿主渲染，插件不持有 React 组件

---

## 16. 开发速查

| 场景 | 关键文件 |
|------|----------|
| 新增 drive 模式 | `data/types.ts → PermissionMode` + `data/settings-reader.ts → isPermissionMode` + `ui/panel-layout.ts → DRIVE_OPTIONS` |
| 新增 Preset 字段 | `actions/preset-types.ts → Preset` + `migratePreset` + `preset-store.ts → generateActiveEnv` |
| 修改 JSONL 解析 | `data/jsonl-parser.ts → normalizeEvents` + `data/types.ts → NormalizedEvent` |
| 修改检测间隔 | `detector/process-watcher.ts → TICK_MS` |
| 新增 slash 命令 | `actions/commands.ts → SLASH` |
| 修改面板布局 | `ui/panel-layout.ts → buildPanelSections` |
| 新增面板事件 | `ui/event-handlers.ts → handlePanelEvent` + 模板侧 emit |
| 新增翻译键 | `src/locales/zh.ts` + `en.ts` + `es.ts` |
| 修改 PTY 注入行为 | `actions/pty-inject.ts → PtyInjector` |
| 添加 Tool 分类 | `data/jsonl-parser.ts → classifyTool` + `data/types.ts → ToolKind` |

---

## 17. 与 `local-ops-aiagent` 的区别

这两个都是 TermCat 的外部插件，但职责完全不同：

| 对比项 | claude_code_power | local-ops-aiagent |
|--------|-------------------|-------------------|
| 定位 | 增强已运行的 claude | 提供自己的 AI 运维能力 |
| 进程模型 | 单进程（Main） | 双进程（Main + fork 子进程） |
| 网络 | 无 | 子进程 WS + HTTP 监听 127.0.0.1 |
| AI 调用 | 不调用 | 直连 OpenAI / Anthropic 等 |
| 数据源 | `~/.claude/projects/*.jsonl` | 用户输入 + AI 响应 |
| UI 面板 | 右侧边栏（sidebar-right） | 复用宿主 ai-ops 面板 |
| 是否需要 License | 否 | X-Agent / Code 模式需购买 Agent 能力包 |

---

## 参考文档索引

| 文档 | 内容 |
|------|------|
| `README.md` | 快速介绍、安装方式、存储位置 |
| `方案设计/20260419-claude-code-power适配插件方案设计.md` | 详细方案设计 |
| `termcat_client/claude_refs/ARCHITECTURE.md` | 宿主架构（Electron 三进程 / 插件系统 / UI 贡献点） |
| `termcat_client_plugin/local-ops-aiagent/claude_refs/ARCHITECTURE.md` | 姊妹插件架构 |

---

**项目**: claude_code_power (TermCat 外部插件)
**版本**: 1.0.0
**最后更新**: 2026-04-21
