# Claude Code Power

TermCat 的 Claude Code 适配插件。

当前终端运行 `claude` 时，右侧面板自动显示：

- **Drive 模式下拉**：`default` / `acceptEdits` / `plan` / `bypassPermissions` 四种权限模式的查看与切换
- **提问历史 + Undo**：按时间倒序列出当前 session 的每次 prompt，支持 `/rewind` 回滚到指定条
- **调用详情**：按 prompt 分组展示每次调用的 tool_use（内置 / Skill / MCP / Sub-agent）与加载的上下文文件
- **多套模型 Preset**：管理多组 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` 配置，一键切换

## 设计原则

- **只读本地文件**：数据全部来自 `~/.claude/projects/<hash>/*.jsonl` 与 `~/.claude/settings.json`，不装 hook，不改用户全局配置
- **写入一律"填入不回车"**：所有向终端注入的命令停在输入行，用户按 Enter 才执行
- **面板跟随激活 tab**：切 tab 面板内容跟着切；两个 tab 同时跑 claude 互不干扰

## 开发

```bash
npm install
npm run build          # 输出 dist/extension.js
npm run pack           # 打出 claude-code-power.tgz 可安装包
```

## 安装到 TermCat

把打好的 tgz 放到 TermCat 用户数据目录的 `plugins/claude-code-power/` 下即可（或复制 `dist/` 整个目录）。

## 存储位置

```
~/.termcat/plugins/claude_code_power/
├── presets.json    # mode 600
├── active.env      # mode 600
└── state.json
```

## 相关文档

- 方案设计：`方案设计/20260419-claude-code-power适配插件方案设计.md`
- 综合 spec：`docs/superpowers/specs/2026-04-19-claude-code-power-design.md`
- 宿主架构：`termcat_client/claude_refs/ARCHITECTURE.md`
