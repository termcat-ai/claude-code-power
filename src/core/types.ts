import type { PermissionMode, TabStatus } from '../data/types';

export type Stage = 'NoPreset' | 'Ready';

export interface PerTabState {
  sessionId: string;
  shellPid: number | null;
  claudePid: number | null;
  detectedCwd: string | null;
  /** JSONL of the live running session (latest mtime when claude is active). */
  sessionFile: string | null;
  status: TabStatus;
  lastCheckedAt: number;
}

export interface SessionMeta {
  /** Absolute path to the session's JSONL file. */
  filePath: string;
  /** Claude Code session id — derived from the filename (uuid before `.jsonl`). */
  sessionId: string;
  /** File mtime (ms epoch). */
  mtimeMs: number;
  /** Short preview of the first user prompt in the session (best-effort). */
  firstPromptPreview?: string;
  /** Number of user prompts on the main branch (0 if unknown / file unparsed yet). */
  promptCount: number;
}

export interface PendingDrive {
  mode: PermissionMode;
  /** ms since epoch; if `Date.now() > deadline` we treat it as timed out. */
  deadline: number;
}

export interface AppState {
  stage: Stage;
  activeTabSessionId: string | null;
  perTabStates: Map<string, PerTabState>;
  pendingDrive: Map<string, PendingDrive>;
  activePresetId: string | null;
  /** projectDir path → list of sessions (sorted newest-first). */
  sessionsByProjectDir: Map<string, SessionMeta[]>;
  /** terminal sessionId → user-selected session filePath (null = follow live). */
  selectedSessionFileByTab: Map<string, string | null>;
  /** terminal sessionId → clicked turn index (1-based) or null for list view. */
  selectedTurnIndexByTab: Map<string, number | null>;
  /** terminal sessionId → set of turn indices currently expanded in the history list. */
  expandedTurnsByTab: Map<string, Set<number>>;
  /** terminal sessionId → currently open rule-file viewer (turn index → file path). */
  viewingRuleFileByTab: Map<string, Map<number, string>>;
  /** terminal sessionId → pending "goto turn" request for the call-detail tab. */
  gotoByTab: Map<string, { nonce: number; blockId: string }>;
  /** Monotonic counter used to bump both tabs + msg-viewer scroll nonces. */
  gotoCounter: number;
}

export function initialAppState(): AppState {
  return {
    stage: 'NoPreset',
    activeTabSessionId: null,
    perTabStates: new Map(),
    pendingDrive: new Map(),
    activePresetId: null,
    sessionsByProjectDir: new Map(),
    selectedSessionFileByTab: new Map(),
    selectedTurnIndexByTab: new Map(),
    expandedTurnsByTab: new Map(),
    viewingRuleFileByTab: new Map(),
    gotoByTab: new Map(),
    gotoCounter: 0,
  };
}
