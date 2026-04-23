import type { NormalizedEvent, PermissionMode, ToolUse, ToolKind } from './types';

/**
 * One raw JSONL line after JSON.parse. Claude Code has no public schema, so we
 * accept a loose Record and defensively extract known fields.
 */
export type RawRecord = Record<string, unknown>;

/** Parse a single line; returns null for blank lines, parse failures, or unknown top-level shapes. */
export function parseJsonlLine(line: string): RawRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed);
    return obj && typeof obj === 'object' ? (obj as RawRecord) : null;
  } catch {
    return null;
  }
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asTimestamp(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Date.parse(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function classifyTool(name: string): ToolKind {
  if (name === 'Skill') return 'skill';
  if (name.startsWith('mcp__')) return 'mcp';
  if (name === 'Task') return 'task';
  return 'builtin';
}

/**
 * Extract tool_use blocks from an assistant message. Claude Code's assistant
 * message content is an array of blocks: text / tool_use / etc. We take only
 * `tool_use` blocks and map to the internal ToolUse shape.
 */
function extractToolUses(message: unknown): ToolUse[] {
  if (!message || typeof message !== 'object') return [];
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const result: ToolUse[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: unknown; id?: unknown; name?: unknown; input?: unknown };
    if (b.type !== 'tool_use') continue;
    const name = asString(b.name);
    if (!name) continue;
    result.push({
      id: asString(b.id, `anon-${result.length}`),
      name,
      input: b.input,
      kind: classifyTool(name),
    });
  }
  return result;
}

function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n\n');
}

function extractUserText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const m = message as { content?: unknown };
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    const parts: string[] = [];
    for (const block of m.content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as { type?: unknown; text?: unknown };
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    }
    return parts.join('\n\n');
  }
  return '';
}

/**
 * A `type="user"` record can represent either a real human prompt or a
 * tool_result being fed back into the conversation. The distinguisher is the
 * message content: real prompts have a string content or text blocks; tool
 * results have a content array of `tool_result` blocks.
 */
function isToolResultRecord(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every(
    (b) => b && typeof b === 'object' && (b as { type?: unknown }).type === 'tool_result',
  );
}

/**
 * Slash-command invocations are serialized as XML-like wrappers:
 *   <command-message>uml</command-message>
 *   <command-name>/uml</command-name>
 *   <command-args>画一个用户登录流程</command-args>
 * Collapse these into a single "/uml 画一个用户登录流程" string so the history
 * row shows the command as the user typed it rather than the raw tags.
 *
 * Also strips stdout/stderr wrappers like `<local-command-stdout>...</...>` if
 * they slipped through (they shouldn't appear on user events, but defensive).
 */
function cleanCommandWrappers(text: string): string {
  const nameMatch = text.match(/<command-name>([^<]+)<\/command-name>/);
  const argsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  if (nameMatch) {
    const name = nameMatch[1].trim();
    const args = argsMatch ? argsMatch[1].trim() : '';
    return args ? `${name} ${args}` : name;
  }
  // Drop any remaining tag-only lines.
  return text
    .replace(/<(local-)?command-(?:name|message|args|stdout|stderr|status)>[\s\S]*?<\/(local-)?command-[^>]+>/g, '')
    .trim();
}

function extractPermissionMode(rec: RawRecord): PermissionMode | null {
  const v = rec.permissionMode;
  if (v === 'default' || v === 'acceptEdits' || v === 'plan' || v === 'bypassPermissions') return v;
  return null;
}

/**
 * Turn a raw record into a NormalizedEvent, or null if it's a shape we don't
 * care about (snapshots, sidechain turns, malformed). Caller is responsible
 * for aggregating `null` skips.
 */
export function normalizeRecord(rec: RawRecord): NormalizedEvent | null {
  const uuid = asString(rec.uuid);
  if (!uuid) return null;
  const parentUuid = typeof rec.parentUuid === 'string' ? rec.parentUuid : null;
  const ts = asTimestamp(rec.timestamp);

  const topType = rec.type;
  const isSidechain = rec.isSidechain === true;
  if (isSidechain) return null;

  if (topType === 'user') {
    // Meta events (isMeta=true) are system-injected context — typically
    // skill docs loaded by a slash command. Never real user prompts. We keep
    // them as attachments so we can mine them for skill references, but they
    // never render as a turn.
    if (rec.isMeta === true) {
      const text = extractUserText(rec.message) || '';
      return {
        kind: 'attachment',
        uuid,
        parentUuid,
        ts,
        hookEvent: 'UserMeta',
        content: text,
      };
    }
    // tool_result echoes — the assistant's tool output being fed back into
    // the conversation. Chain-link stub so the parentUuid walk doesn't break.
    if (isToolResultRecord(rec.message)) {
      return { kind: 'chain-link', uuid, parentUuid, ts };
    }
    let text = extractUserText(rec.message);
    if (!text) return { kind: 'chain-link', uuid, parentUuid, ts };
    // Slash-command invocations arrive wrapped in XML-like tags:
    //   <command-message>NAME</command-message>
    //   <command-name>/NAME</command-name>
    //   <command-args>ARGS</command-args>
    // Flatten to a human-readable "/NAME ARGS" for the history title.
    text = cleanCommandWrappers(text);
    return {
      kind: 'user-prompt',
      uuid,
      parentUuid,
      ts,
      permissionMode: extractPermissionMode(rec),
      text,
    };
  }

  // Standalone permission-mode events (new in Claude Code >= 2.1.x).
  // We surface them as a synthetic "user-prompt"-less signal: emit an attachment
  // so SessionIndex can see it on the main branch, but actual mode reading uses
  // getLatestPermissionMode which walks the branch.
  if (topType === 'permission-mode') {
    const mode = extractPermissionMode(rec);
    if (!mode) return null;
    return {
      kind: 'attachment',
      uuid,
      parentUuid,
      ts,
      hookEvent: 'PermissionMode',
      content: mode,
    };
  }

  if (topType === 'assistant') {
    return {
      kind: 'assistant-msg',
      uuid,
      parentUuid,
      ts,
      text: extractAssistantText(rec.message),
      toolUses: extractToolUses(rec.message),
    };
  }

  if (topType === 'attachment') {
    const att = rec.attachment as
      | { hookEvent?: unknown; content?: unknown; stdout?: unknown; type?: unknown }
      | undefined;
    if (!att) return null;
    const hookEvent = asString(att.hookEvent);

    // Different attachment shapes:
    //   hook_success:           stdout = JSON string { hookSpecificOutput: { additionalContext } }
    //   hook_additional_context: content = Array<string>
    //   skill_listing / tool delta: content = string (already extracted text)
    let content = '';
    if (typeof att.content === 'string') {
      content = att.content;
    } else if (Array.isArray(att.content)) {
      content = (att.content as unknown[])
        .filter((v) => typeof v === 'string')
        .join('\n\n');
    }
    if (!content && typeof att.stdout === 'string') {
      // hook_success: dig additionalContext out of the JSON stdout.
      try {
        const parsed = JSON.parse(att.stdout);
        const ac = parsed?.hookSpecificOutput?.additionalContext;
        if (typeof ac === 'string') content = ac;
        else if (Array.isArray(ac))
          content = ac.filter((v) => typeof v === 'string').join('\n\n');
        else content = att.stdout; // fall back to raw
      } catch {
        content = att.stdout;
      }
    }

    return {
      kind: 'attachment',
      uuid,
      parentUuid,
      ts,
      hookEvent,
      content,
    };
  }

  // Any other record with a parentUuid is kept as a chain-link stub so the
  // parentUuid graph stays intact. Records with no parentUuid (snapshots,
  // last-prompt metadata, etc.) can be safely dropped.
  if (parentUuid) {
    return { kind: 'chain-link', uuid, parentUuid, ts };
  }
  return null;
}

/** Apply `normalizeRecord` to a batch and drop nulls. */
export function normalizeEvents(records: RawRecord[]): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  for (const r of records) {
    const n = normalizeRecord(r);
    if (n) out.push(n);
  }
  return out;
}
