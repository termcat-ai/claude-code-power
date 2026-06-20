/** Claude Code permission modes. Matches claude's JSONL `permissionMode` field. */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';

/** Tab-level detection status. */
export type TabStatus = 'idle' | 'active' | 'active-idle' | 'stale';

/** Classified tool-use source. */
export type ToolKind = 'builtin' | 'skill' | 'mcp' | 'task';

export interface ToolUse {
  id: string;
  name: string;
  input: unknown;
  output?: unknown;
  isError?: boolean;
  kind: ToolKind;
}

export type NormalizedEvent =
  | {
      kind: 'user-prompt';
      uuid: string;
      parentUuid: string | null;
      ts: number;
      permissionMode: PermissionMode | null;
      text: string;
    }
  | {
      kind: 'assistant-msg';
      uuid: string;
      parentUuid: string | null;
      ts: number;
      text: string;
      toolUses: ToolUse[];
      /**
       * Total input tokens = raw + cache_creation + cache_read.
       * Represents full context size sent to the model this API call.
       */
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    }
  | {
      kind: 'attachment';
      uuid: string;
      parentUuid: string | null;
      ts: number;
      hookEvent: string;
      content: string;
    }
  | {
      // Placeholder for records we don't surface (tool_result echoes, snapshots,
      // etc.) but whose uuid is referenced by other events' parentUuid so the
      // chain walk wouldn't break.
      kind: 'chain-link';
      uuid: string;
      parentUuid: string | null;
      ts: number;
    };

/** A user prompt together with all assistant/tool events that answered it on the main branch. */
export interface PromptTurn {
  index: number; // 1-based, chronological
  userEvent: Extract<NormalizedEvent, { kind: 'user-prompt' }>;
  assistantEvents: Array<Extract<NormalizedEvent, { kind: 'assistant-msg' }>>;
  attachments: Array<Extract<NormalizedEvent, { kind: 'attachment' }>>;
}

/** Summary statistics for a prompt turn — used in the history list badge row. */
export interface SkillInfo {
  /** Skill identifier — either `namespace:slug` (via Skill tool input) or folder name. */
  name: string;
  /** Absolute path to the skill's base directory (if known). */
  baseDir?: string;
  /** First heading / title line from the skill's SKILL.md (if loaded via slash command). */
  title?: string;
  /** Short description (first non-empty body line after title, truncated). */
  description?: string;
  /** How the skill was invoked: 'tool' (Skill tool_use) or 'slash' (/xxx command load). */
  source: 'tool' | 'slash';
}

export interface PromptTurnStats {
  totalToolUses: number;
  skillCount: number;
  mcpCount: number;
  taskCount: number;
  builtinCount: number;
  /** Distinct rule/context file paths touched this turn (CLAUDE.md / SKILL.md / AGENTS.md). */
  ruleFiles: string[];
  /** Distinct skill names invoked (e.g. 'superpowers:tdd'). */
  skills: string[];
  /** Richer per-skill info (keyed by skill name). */
  skillInfos: SkillInfo[];
  /** Distinct MCP server names used (e.g. 'context7'). */
  mcpServers: string[];
  /**
   * Input tokens from the last assistant API call (represents context size at
   * end of turn). 0 if unavailable (older JSONL without usage field).
   */
  inputTokens: number;
  /** Sum of output tokens across all assistant API calls in the turn. */
  outputTokens: number;
  /** Sum of cache-read input tokens across all assistant API calls. */
  cacheReadTokens: number;
  /** Sum of cache-write (cache_creation) input tokens across all assistant API calls. */
  cacheWriteTokens: number;
}

/** Session-wide context — rule files / skills loaded at session start via hooks. */
export interface SessionContext {
  /** Rule files auto-loaded at session start (CLAUDE.md / AGENTS.md / GEMINI.md / SKILL.md). */
  ruleFiles: string[];
  /** Task tool names used historically — also includes 'Task' / 'Agent'. */
  taskToolNames?: string[];
}

export function computeTurnStats(
  turn: PromptTurn,
  _sessionContext: SessionContext = { ruleFiles: [] },
): PromptTurnStats {
  const stats: PromptTurnStats = {
    totalToolUses: 0,
    skillCount: 0,
    mcpCount: 0,
    taskCount: 0,
    builtinCount: 0,
    ruleFiles: [],
    skills: [],
    skillInfos: [],
    mcpServers: [],
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  const skillSet = new Set<string>();
  const skillInfoMap = new Map<string, SkillInfo>();
  const mcpSet = new Set<string>();

  for (const msg of turn.assistantEvents) {
    // Sum all API calls in the turn. inputTokens counts only fresh tokens
    // (raw + cache_creation) per call, so summing gives the real total
    // without counting the same cached context N times.
    stats.inputTokens += msg.inputTokens ?? 0;
    stats.outputTokens += msg.outputTokens ?? 0;
    stats.cacheReadTokens += msg.cacheReadTokens ?? 0;
    stats.cacheWriteTokens += (msg as { cacheWriteTokens?: number }).cacheWriteTokens ?? 0;
    for (const tu of msg.toolUses) {
      stats.totalToolUses++;
      switch (tu.kind) {
        case 'skill': {
          stats.skillCount++;
          const input = tu.input;
          const skill =
            input && typeof input === 'object' ? (input as { skill?: string }).skill ?? '' : '';
          if (skill) {
            skillSet.add(skill);
            if (!skillInfoMap.has(skill)) {
              skillInfoMap.set(skill, { name: skill, source: 'tool' });
            }
          }
          break;
        }
        case 'mcp': {
          stats.mcpCount++;
          const parts = tu.name.split('__');
          if (parts[1]) mcpSet.add(parts[1]);
          break;
        }
        case 'task':
          stats.taskCount++;
          break;
        default:
          stats.builtinCount++;
      }
    }
  }

  // Slash-command skill loads arrive as `isMeta=true` user records (surfaced
  // as hookEvent='UserMeta' attachments). Content starts with:
  //   "Base directory for this skill: /path/to/skill-name
  //
  //    # Title
  //    **Quick Start:** ..."
  // — extract name, path, title, and a short description line.
  for (const att of turn.attachments) {
    if (att.hookEvent !== 'UserMeta') continue;
    const m = att.content.match(/Base directory for this skill:\s*(\S+)/);
    if (!m) continue;
    const skillPath = m[1];
    const skillName = skillPath.split('/').pop() || skillPath;
    skillSet.add(skillName);

    // Everything after the "Base directory..." line is the skill body.
    const body = att.content.slice(att.content.indexOf(m[0]) + m[0].length).trimStart();
    const lines = body.split('\n');
    let title: string | undefined;
    let description: string | undefined;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (!title && line.startsWith('#')) {
        title = line.replace(/^#+\s*/, '').trim();
        continue;
      }
      if (title && !description) {
        const clean = line.replace(/^\*\*[^*]+\*\*:?\s*/, '').replace(/^\*\s*/, '').trim();
        if (clean.length > 4) {
          description = clean.length > 160 ? clean.slice(0, 157) + '...' : clean;
          break;
        }
      }
    }
    const prev = skillInfoMap.get(skillName);
    skillInfoMap.set(skillName, {
      name: skillName,
      baseDir: skillPath,
      title: title ?? prev?.title,
      description: description ?? prev?.description,
      source: prev?.source ?? 'slash',
    });
    if (!prev) stats.skillCount++;
  }

  stats.skills = [...skillSet];
  stats.skillInfos = [...skillInfoMap.values()];
  stats.mcpServers = [...mcpSet];
  stats.ruleFiles = [];
  return stats;
}

/**
 * Extract a file path from a tool_use's `input` if it's a file-reading / editing
 * tool. Returns null for tools that don't target a specific file.
 */
export function extractToolFilePath(tu: ToolUse): string | null {
  if (!tu.input || typeof tu.input !== 'object') return null;
  const input = tu.input as Record<string, unknown>;
  const FILE_KEYS = ['file_path', 'path', 'notebook_path', 'filepath'];
  for (const k of FILE_KEYS) {
    const v = input[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/** Built-in tools that read files without modifying them. */
const FILE_READ_TOOL_NAMES = new Set(['Read', 'NotebookRead']);

/** Built-in tools that write or modify files on disk. */
const FILE_WRITE_TOOL_NAMES = new Set([
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
]);

/** Union of both file read + write tools. */
const FILE_TOOL_NAMES = new Set([
  ...FILE_READ_TOOL_NAMES,
  ...FILE_WRITE_TOOL_NAMES,
]);

export function isFileTool(tu: ToolUse): boolean {
  if (FILE_TOOL_NAMES.has(tu.name)) return true;
  return extractToolFilePath(tu) !== null;
}

/** True iff the tool modifies file contents on disk. */
export function isFileWriteTool(tu: ToolUse): boolean {
  return FILE_WRITE_TOOL_NAMES.has(tu.name);
}

/**
 * True iff the tool only reads files. Also matches MCP / custom tools that
 * carry a file path but aren't explicitly write tools — erring toward "read"
 * so ambiguous file-path tools don't get flagged as destructive.
 */
export function isFileReadTool(tu: ToolUse): boolean {
  if (FILE_READ_TOOL_NAMES.has(tu.name)) return true;
  if (FILE_WRITE_TOOL_NAMES.has(tu.name)) return false;
  return extractToolFilePath(tu) !== null;
}

