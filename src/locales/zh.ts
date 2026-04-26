export const zh = {
  // Panel chrome
  panelTitle: 'Claude Code Power',

  // State banners
  noClaudeDetected: '未检测到 Claude Code',
  noClaudeDetectedHint: '在当前终端输入 claude 启动会话',
  orText: '—— 或者 ——',
  launchClaudeButton: '▶ 启动 Claude',
  sessionEndedBanner: '会话已结束 — 显示最近一次 session 内容',
  claudeNotInstalled: 'Claude Code 未安装',
  claudeNotInstalledHint: '请先访问 https://code.claude.com 安装命令行工具',
  noPresetTitle: '还没有配置任何 Preset',
  noPresetHint: '点击下方按钮创建第一个模型配置',
  createPresetButton: '创建 Preset',
  claudeDataPermissionError: '无法访问 Claude Code 数据目录 (~/.claude)',
  retry: '重试',

  // Drive mode
  driveModeLabel: 'Drive 模式',
  driveMode_default: 'Default · 每次编辑前问',
  driveMode_acceptEdits: 'Accept Edits · 自动编辑',
  driveMode_plan: 'Plan · 只研究不改文件',
  driveMode_auto: 'Auto · Claude 自判',
  driveMode_bypassPermissions: 'Bypass · 跳过所有权限（需启动参数）',
  cycleDriveModeTooltip: '切到下一个模式（等同 Shift+Tab）',
  driveSyncSourceSession: '会话内',
  driveSyncSourceDefault: '默认',
  driveLampSynced: '已同步',
  driveLampPending: '待确认 — 请在终端按 Enter',
  driveLampWarning: '未生效 — 请手动执行',
  confirmWriteDefaultMode: '将默认模式改为「{mode}」？这会写入 ~/.claude/settings.json。',
  cannotEnterBypass: 'bypassPermissions 无法通过键盘切换。请退出 claude 后用 `--dangerously-skip-permissions` 重启',
  cannotLeaveBypass: '当前处于 bypassPermissions 模式，无法通过键盘切换出来。请退出 claude 后重启',
  cannotCycleBypass: '当前处于 bypassPermissions 模式，无法通过键盘循环。请退出 claude 后重启',
  unknownMode: '未知模式：{mode}',
  unknownModePair: '未知模式：{from} / {to}',
  writeSettingsFailed: '写入 settings 失败：{err}',

  // Session selector
  sessionLabel: '会话',

  // Preset
  presetLabel: 'Preset',
  manageButton: '管理',
  editPresetTooltip: '编辑当前 Preset',
  presetActivatedNextLaunch: '已激活「{name}」，下次 claude 启动生效',
  confirmRestartForPreset: '此 Preset 改变了认证或端点，需要重启 claude。将在输入框注入 exit（不回车），按 Enter 后退出当前会话，再用新 Preset 启动。',
  editPresetTitle: '编辑 Preset: {name}',
  createPresetTitle: '创建 Preset',
  presetFormDescription: '填写启动 Claude Code 所需的环境变量。除名称外其余字段均为可选。',
  presetFieldName: 'Preset 名称',
  presetFieldNamePlaceholder: '例如：Anthropic 官方 / 公司代理 / Claude Pro',
  presetFieldApiKey: 'ANTHROPIC_API_KEY（可选）',
  presetFieldApiKeyPlaceholder: 'sk-ant-... · 留空跳过',
  presetFieldAuthToken: 'ANTHROPIC_AUTH_TOKEN（可选）',
  presetFieldAuthTokenPlaceholder: 'OAuth token · 留空跳过',
  presetFieldBaseUrl: 'ANTHROPIC_BASE_URL（可选）',
  presetFieldBaseUrlPlaceholder: 'https://api.anthropic.com · 留空使用默认',
  presetFieldModel: 'Model（可选）',
  presetFieldModelPlaceholder: 'sonnet / opus / haiku / claude-sonnet-4-5 · 留空使用 Claude 默认',
  save: '保存',
  presetUpdated: '已更新 Preset「{name}」',
  presetCreated: '已创建 Preset「{name}」',
  noActivePresetSelected: '当前未选中任何 Preset',

  // History tab
  tabHistory: '历史',
  tabCallDetails: '调用详情',
  emptyHistory: '尚无历史 — 第一次输入 prompt 后会在这里出现',
  undoButtonTooltip: '回滚到此条',
  confirmRewind: '保留到第 {target} 条，丢弃后续 {n} 个 prompt 及其工具结果。磁盘文件由 Claude Code 的 checkpoint 机制负责恢复，本插件不参与。',
  toolCountSummary: '{count} 次工具',
  expandTooltip: '展开',
  gotoTurnTooltip: '跳转到调用详情并定位该提问',

  // Call details
  contextSectionTitle: '加载的上下文',
  badgeSkill: 'Skill',
  badgeMcp: 'MCP',
  badgeAgent: 'Agent',
  clickToViewFileContent: '点击查看文件内容',

  // Turn detail panel
  detailBackButton: '← 返回列表',
  detailUndoButton: '回滚到此条之前',
  detailUndoDisabled: '回滚仅对当前运行中的会话可用',
  detailPromptLabel: '提问内容',
  detailStatsLabel: '统计',
  detailStatsTool: '工具调用',
  detailStatsSkill: 'Skill',
  detailStatsMcp: 'MCP',
  detailStatsTask: 'Sub-agent',
  detailStatsRule: '规则文件',
  detailSkillsTitle: '调用的 Skill',
  detailMcpsTitle: '调用的 MCP',
  detailRulesTitle: '加载的规则 / 上下文文件',
  detailToolsTitle: '所有工具调用',
  detailEmpty: '—',

  // Notifications
  terminalNotFound: '未找到终端 — 请切换到跑 claude 的 tab',
  presetTestOk: '连接测试通过',
  presetTestFailed: '连接测试失败：{reason}',
  undoCompleted: '已回滚',

  // Generic
  cancel: '取消',
  confirm: '确认',
};

export type LocaleKeys = typeof zh;
