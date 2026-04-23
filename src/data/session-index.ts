import type { NormalizedEvent, PermissionMode, PromptTurn } from './types';

const DEFAULT_MAX_TURNS = 2000;

/**
 * In-memory index over the events of a single Claude Code session JSONL.
 *
 * Responsibilities:
 *  - Deduplicate and insert events by uuid.
 *  - Build a parentUuid DAG, then derive the "main branch" by walking from
 *    the latest leaf back to the root. Events on abandoned branches (after
 *    `/rewind`) don't appear in the main branch.
 *  - Group main-branch events into PromptTurns (one per user prompt).
 */
export class SessionIndex {
  private events = new Map<string, NormalizedEvent>();
  /** uuid → earliest insertion order (used to break ties between leaves with same ts). */
  private order = new Map<string, number>();
  private seq = 0;
  /** Cached main branch; invalidated on any insert. */
  private mainBranchCache: NormalizedEvent[] | null = null;
  private turnsCache: PromptTurn[] | null = null;

  constructor(private readonly maxTurns = DEFAULT_MAX_TURNS) {}

  addEvents(events: NormalizedEvent[]): void {
    if (!events.length) return;
    let added = false;
    for (const e of events) {
      if (this.events.has(e.uuid)) continue;
      this.events.set(e.uuid, e);
      this.order.set(e.uuid, this.seq++);
      added = true;
    }
    if (added) {
      this.mainBranchCache = null;
      this.turnsCache = null;
    }
  }

  clear(): void {
    this.events.clear();
    this.order.clear();
    this.seq = 0;
    this.mainBranchCache = null;
    this.turnsCache = null;
  }

  size(): number {
    return this.events.size;
  }

  /**
   * Pick the leaf with the latest timestamp (ties: later insertion order wins);
   * walk via parentUuid until we hit a node whose parent is absent → that's
   * the main-branch root. Reverse to return in chronological order.
   */
  getMainBranch(): NormalizedEvent[] {
    if (this.mainBranchCache) return this.mainBranchCache;
    if (this.events.size === 0) {
      this.mainBranchCache = [];
      return this.mainBranchCache;
    }

    // Leaves = nodes that are not referenced as parent by anyone.
    const referenced = new Set<string>();
    for (const e of this.events.values()) {
      if (e.parentUuid) referenced.add(e.parentUuid);
    }
    let leafUuid: string | null = null;
    let leafKey = -Infinity;
    for (const e of this.events.values()) {
      if (referenced.has(e.uuid)) continue;
      const ord = this.order.get(e.uuid) ?? 0;
      // Compose a ranking: primary by ts, secondary by insertion order.
      const key = e.ts * 1e6 + ord;
      if (key > leafKey) {
        leafKey = key;
        leafUuid = e.uuid;
      }
    }
    // Fallback: if referenced==size (e.g. cycles or incomplete), pick latest by ts.
    if (!leafUuid) {
      let latestTs = -Infinity;
      for (const e of this.events.values()) {
        if (e.ts > latestTs) {
          latestTs = e.ts;
          leafUuid = e.uuid;
        }
      }
    }

    const branch: NormalizedEvent[] = [];
    const visited = new Set<string>();
    let cursor: string | null | undefined = leafUuid;
    while (cursor) {
      if (visited.has(cursor)) break;
      visited.add(cursor);
      const e = this.events.get(cursor);
      if (!e) break;
      branch.push(e);
      cursor = e.parentUuid;
    }
    branch.reverse();
    // LRU truncate from the head (keep most recent N turns worth).
    // Conservative estimate: average 3 events per turn → cap events at maxTurns*3.
    const maxEvents = this.maxTurns * 3;
    const trimmed = branch.length > maxEvents ? branch.slice(branch.length - maxEvents) : branch;
    this.mainBranchCache = trimmed;
    return trimmed;
  }

  /** Group main-branch events into prompt turns. */
  getPromptTurns(): PromptTurn[] {
    if (this.turnsCache) return this.turnsCache;
    const branch = this.getMainBranch();
    const turns: PromptTurn[] = [];
    let current: PromptTurn | null = null;

    // Attachments that precede the first user prompt (SessionStart hook output
    // with CLAUDE.md / skill context). These apply to every turn, so we
    // attach them to turn #1 as a visible baseline.
    const preFirstAttachments: Array<Extract<NormalizedEvent, { kind: 'attachment' }>> = [];

    for (const e of branch) {
      if (e.kind === 'chain-link') continue; // invisible passthrough
      if (e.kind === 'user-prompt') {
        if (current) turns.push(current);
        current = { index: turns.length + 1, userEvent: e, assistantEvents: [], attachments: [] };
        if (turns.length === 0 && preFirstAttachments.length) {
          current.attachments.push(...preFirstAttachments);
          preFirstAttachments.length = 0;
        }
      } else if (current) {
        if (e.kind === 'assistant-msg') current.assistantEvents.push(e);
        else if (e.kind === 'attachment') current.attachments.push(e);
      } else if (e.kind === 'attachment') {
        preFirstAttachments.push(e);
      }
    }
    if (current) turns.push(current);

    // Cap at maxTurns (keep most recent).
    const out = turns.length > this.maxTurns ? turns.slice(turns.length - this.maxTurns) : turns;
    // Re-index contiguously so UI indices match displayed #.
    const reindexed = out.map((t, i) => ({ ...t, index: i + 1 + (turns.length - out.length) }));
    this.turnsCache = reindexed;
    return reindexed;
  }

  /**
   * Latest permissionMode seen on the main branch. Checks both the standalone
   * `permission-mode` attachment events (Claude Code >= 2.1) and the legacy
   * inline permissionMode field on user-prompt events.
   */
  getLatestPermissionMode(): PermissionMode | null {
    const branch = this.getMainBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const e = branch[i];
      if (e.kind === 'attachment' && e.hookEvent === 'PermissionMode') {
        return e.content as PermissionMode;
      }
      if (e.kind === 'user-prompt' && e.permissionMode) return e.permissionMode;
    }
    return null;
  }

  /** Latest event timestamp across the whole (not just main-branch) index. */
  getLatestEventTs(): number | null {
    let latest: number | null = null;
    for (const e of this.events.values()) {
      if (latest === null || e.ts > latest) latest = e.ts;
    }
    return latest;
  }
}
