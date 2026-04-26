import type { LocaleKeys } from './zh';

export const en: LocaleKeys = {
  // Panel chrome
  panelTitle: 'Claude Code Power',

  // State banners
  noClaudeDetected: 'Claude Code not detected',
  noClaudeDetectedHint: 'Run `claude` in the current terminal to start a session',
  orText: '—— or ——',
  launchClaudeButton: '▶ Launch Claude',
  sessionEndedBanner: 'Session ended — showing the most recent session contents',
  claudeNotInstalled: 'Claude Code is not installed',
  claudeNotInstalledHint: 'Visit https://code.claude.com to install the CLI first',
  noPresetTitle: 'No preset configured yet',
  noPresetHint: 'Click the button below to create your first model configuration',
  createPresetButton: 'Create Preset',
  claudeDataPermissionError: 'Cannot access Claude Code data directory (~/.claude)',
  retry: 'Retry',

  // Drive mode
  driveModeLabel: 'Drive Mode',
  driveMode_default: 'Default · Ask before each edit',
  driveMode_acceptEdits: 'Accept Edits · Auto-edit',
  driveMode_plan: 'Plan · Research only, no changes',
  driveMode_auto: 'Auto · Claude decides',
  driveMode_bypassPermissions: 'Bypass · Skip all permissions (launch flag required)',
  cycleDriveModeTooltip: 'Switch to the next mode (same as Shift+Tab)',
  driveSyncSourceSession: 'session',
  driveSyncSourceDefault: 'default',
  driveLampSynced: 'Synced',
  driveLampPending: 'Pending — press Enter in the terminal',
  driveLampWarning: 'Not applied — please run manually',
  confirmWriteDefaultMode: 'Change the default mode to "{mode}"? This will write to ~/.claude/settings.json.',
  cannotEnterBypass: 'bypassPermissions cannot be toggled via keyboard. Exit claude and relaunch with `--dangerously-skip-permissions`',
  cannotLeaveBypass: 'Currently in bypassPermissions mode — cannot leave via keyboard. Please exit claude and restart',
  cannotCycleBypass: 'Currently in bypassPermissions mode — cannot cycle via keyboard. Please exit claude and restart',
  unknownMode: 'Unknown mode: {mode}',
  unknownModePair: 'Unknown mode: {from} / {to}',
  writeSettingsFailed: 'Failed to write settings: {err}',

  // Session selector
  sessionLabel: 'Session',

  // Preset
  presetLabel: 'Preset',
  manageButton: 'Manage',
  editPresetTooltip: 'Edit current preset',
  presetActivatedNextLaunch: 'Activated "{name}" — takes effect on next claude launch',
  confirmRestartForPreset: 'This preset changes auth or endpoint and requires a claude restart. `exit` will be pre-filled in the input (not auto-sent); press Enter to quit the current session, then relaunch with the new preset.',
  editPresetTitle: 'Edit Preset: {name}',
  createPresetTitle: 'Create Preset',
  presetFormDescription: 'Fill in the environment variables needed to launch Claude Code. All fields except the name are optional.',
  presetFieldName: 'Preset Name',
  presetFieldNamePlaceholder: 'e.g. Anthropic Official / Corporate Proxy / Claude Pro',
  presetFieldApiKey: 'ANTHROPIC_API_KEY (optional)',
  presetFieldApiKeyPlaceholder: 'sk-ant-... · leave empty to skip',
  presetFieldAuthToken: 'ANTHROPIC_AUTH_TOKEN (optional)',
  presetFieldAuthTokenPlaceholder: 'OAuth token · leave empty to skip',
  presetFieldBaseUrl: 'ANTHROPIC_BASE_URL (optional)',
  presetFieldBaseUrlPlaceholder: 'https://api.anthropic.com · leave empty for default',
  presetFieldModel: 'Model (optional)',
  presetFieldModelPlaceholder: 'sonnet / opus / haiku / claude-sonnet-4-5 · leave empty for Claude default',
  save: 'Save',
  presetUpdated: 'Preset "{name}" updated',
  presetCreated: 'Preset "{name}" created',
  noActivePresetSelected: 'No preset is currently selected',

  // History tab
  tabHistory: 'History',
  tabCallDetails: 'Call Details',
  emptyHistory: 'No history yet — your first prompt will appear here',
  undoButtonTooltip: 'Rewind to this turn',
  confirmRewind: 'Keep up to turn #{target}, discarding the following {n} prompts and their tool results. File recovery is handled by Claude Code\'s checkpoint mechanism — this plugin is not involved.',
  toolCountSummary: '{count} tool call(s)',
  expandTooltip: 'Expand',
  gotoTurnTooltip: 'Jump to call details and focus this prompt',

  // Call details
  contextSectionTitle: 'Loaded context',
  badgeSkill: 'Skill',
  badgeMcp: 'MCP',
  badgeAgent: 'Agent',
  clickToViewFileContent: 'Click to view file contents',

  // Turn detail panel
  detailBackButton: '← Back to list',
  detailUndoButton: 'Rewind before this turn',
  detailUndoDisabled: 'Rewind is only available for the currently running session',
  detailPromptLabel: 'Prompt',
  detailStatsLabel: 'Stats',
  detailStatsTool: 'Tool calls',
  detailStatsSkill: 'Skill',
  detailStatsMcp: 'MCP',
  detailStatsTask: 'Sub-agent',
  detailStatsRule: 'Rule files',
  detailSkillsTitle: 'Skills invoked',
  detailMcpsTitle: 'MCPs invoked',
  detailRulesTitle: 'Rule / context files loaded',
  detailToolsTitle: 'All tool calls',
  detailEmpty: '—',

  // Notifications
  terminalNotFound: 'Terminal not found — switch to the tab running claude',
  presetTestOk: 'Connection test passed',
  presetTestFailed: 'Connection test failed: {reason}',
  undoCompleted: 'Rewind complete',

  // Generic
  cancel: 'Cancel',
  confirm: 'Confirm',
};
