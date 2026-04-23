/** All Claude Code slash literals in one place — easy to patch when Claude renames. */
export const SLASH = {
  MODEL: '/model',
  REWIND: '/rewind',
  EXIT: 'exit',
} as const;

/**
 * Key sequences delivered raw to the running claude (not the shell prompt).
 * Shift+Tab cycles permission modes inside claude: default → acceptEdits → plan → default.
 */
export const KEY = {
  SHIFT_TAB: '\x1b[Z',
} as const;

/**
 * The subset of permission modes that the claude UI cycles through on Shift+Tab,
 * in the exact order claude cycles them:
 *   default → acceptEdits → plan → auto → default
 *
 * `bypassPermissions` is deliberately excluded — it can only be entered by
 * launching claude with `--dangerously-skip-permissions`.
 *
 * If claude introduces a new mode or reorders, observe the JSONL
 * `permissionMode` field in `~/.claude/projects/<hash>/*.jsonl` to discover
 * the new string id, then update this constant.
 */
export const PERMISSION_CYCLE = ['default', 'acceptEdits', 'plan', 'auto'] as const;
export type CyclePermissionMode = (typeof PERMISSION_CYCLE)[number];
