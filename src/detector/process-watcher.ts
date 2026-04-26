import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
// `pidtree` is CJS — import default and call as a function.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pidtree = require('pidtree') as (
  pid: number,
  opts?: { root?: boolean },
) => Promise<number[]>;

import type { TabStatus } from '../data/types';
import type { PerTabState } from '../core/types';
import { cwdFromProjectDirLeaf, encodeCwd } from '../data/project-hash';

const execFileAsync = promisify(execFile);

const TICK_MS = 5000;
const JSONL_FRESH_MS = 60_000;
const STALE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

export interface TerminalHandle {
  sessionId: string;
  getPid: () => Promise<number | null>;
}

interface Listeners {
  onTabState: (state: PerTabState) => void;
  getKnownSessions: () => TerminalHandle[];
  getActiveSessionId: () => string | null;
}

/**
 * Polls the system for claude processes under each known terminal's shell pid,
 * plus checks JSONL freshness to decide between active / active-idle / stale.
 * Results are pushed to `onTabState`.
 */
export class Detector {
  private interval: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: Listeners) {}

  start(): void {
    if (this.interval) return;
    // Run one tick immediately, then on interval.
    void this.tick();
    this.interval = setInterval(() => void this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  /** Trigger an immediate tick (e.g. after active tab changes). */
  triggerNow(): void {
    void this.tick();
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const terminals = this.deps.getKnownSessions();
      if (!terminals.length) return;

      // Global process list once per tick, shared across all tabs.
      const processes = await listProcesses().catch(() => [] as ProcessRow[]);
      const byPid = new Map<number, ProcessRow>();
      for (const p of processes) byPid.set(p.pid, p);

      for (const term of terminals) {
        const shellPid = await term.getPid().catch(() => null);
        const claudePid = await this.findClaudeInSubtree(shellPid, byPid);
        let cwd: string | null = null;
        let sessionFile: string | null = null;
        let status: TabStatus = 'idle';

        if (claudePid != null) {
          // Pointer file ~/.claude/sessions/<pid>.json carries the authoritative
          // sessionId AND cwd for this claude pid. Prefer it over lsof/mtime —
          // when multiple tabs run claude in the same cwd, mtime-based selection
          // races and the wrong JSONL gets bound to each tab.
          const pointer = await this.readSessionPointer(claudePid);
          cwd =
            pointer?.cwd ??
            (await this.resolveCwd(claudePid).catch(() => null));
          const { mtimeMs, file } = await this.resolveSessionFile(pointer?.sessionId ?? null, cwd);
          sessionFile = file;
          const now = Date.now();
          const fresh = mtimeMs && now - mtimeMs < JSONL_FRESH_MS;
          status = fresh ? 'active' : 'active-idle';
        } else {
          // No claude process — might still be Stale if there's been recent activity.
          const { mtimeMs } = await this.latestJsonlGlobal();
          if (mtimeMs && Date.now() - mtimeMs < STALE_WINDOW_MS) status = 'stale';
          else status = 'idle';
        }

        const state: PerTabState = {
          sessionId: term.sessionId,
          shellPid,
          claudePid,
          detectedCwd: cwd,
          sessionFile,
          status,
          lastCheckedAt: Date.now(),
        };
        this.deps.onTabState(state);
      }
    } finally {
      this.running = false;
    }
  }

  private async findClaudeInSubtree(
    shellPid: number | null,
    byPid: Map<number, ProcessRow>,
  ): Promise<number | null> {
    if (!shellPid) return null;
    let descendants: number[] = [];
    try {
      descendants = await pidtree(shellPid);
    } catch {
      // pidtree errors on closed pid; fall back to a ppid traversal
      descendants = this.walkDescendants(shellPid, byPid);
    }
    for (const pid of descendants) {
      const entry = byPid.get(pid);
      if (!entry) continue;
      if (entry.name === 'claude' || /(^|\/)claude$/.test(entry.name)) return pid;
      if (entry.cmd && /\bclaude\b/.test(entry.cmd) && !/claude-/.test(entry.cmd)) {
        // crude check — avoid matching `claude-pay-attention.sh` etc.
      }
    }
    return null;
  }

  private walkDescendants(
    rootPid: number,
    byPid: Map<number, { pid: number; ppid: number }>,
  ): number[] {
    // Build ppid → children index once
    const children = new Map<number, number[]>();
    for (const p of byPid.values()) {
      const arr = children.get(p.ppid) ?? [];
      arr.push(p.pid);
      children.set(p.ppid, arr);
    }
    const result: number[] = [];
    const stack = [rootPid];
    while (stack.length) {
      const pid = stack.pop()!;
      const kids = children.get(pid);
      if (!kids) continue;
      for (const c of kids) {
        result.push(c);
        stack.push(c);
      }
    }
    return result;
  }

  private async resolveCwd(pid: number): Promise<string | null> {
    if (process.platform === 'linux') {
      try {
        return await fs.promises.readlink(`/proc/${pid}/cwd`);
      } catch {
        return null;
      }
    }
    if (process.platform === 'darwin') {
      try {
        const { stdout } = await execFileAsync('lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn'], {
          timeout: 2000,
        });
        // lsof -Fn emits lines prefixed with 'n/path'; take the first n-line
        for (const line of stdout.split('\n')) {
          if (line.startsWith('n')) return line.slice(1);
        }
      } catch {
        /* fall through */
      }
    }
    // Windows or fallback: try latest mtime jsonl across ~/.claude/projects to
    // reverse-derive cwd.
    const { leaf } = await this.latestJsonlGlobal();
    return leaf ? cwdFromProjectDirLeaf(leaf) : null;
  }

  /**
   * Read ~/.claude/sessions/<pid>.json — Claude Code 2.1.x writes one of these
   * per running claude process, carrying the live sessionId and cwd. Returns
   * null if the file is missing (older claude) or malformed.
   */
  private async readSessionPointer(
    claudePid: number,
  ): Promise<{ sessionId: string; cwd: string | null } | null> {
    const file = path.join(os.homedir(), '.claude', 'sessions', `${claudePid}.json`);
    try {
      const raw = await fs.promises.readFile(file, 'utf-8');
      const j = JSON.parse(raw) as { sessionId?: unknown; cwd?: unknown };
      if (typeof j.sessionId !== 'string' || !j.sessionId) return null;
      return {
        sessionId: j.sessionId,
        cwd: typeof j.cwd === 'string' ? j.cwd : null,
      };
    } catch {
      return null;
    }
  }

  /**
   * Resolve the JSONL path for this tab. Pointer-derived sessionId wins (exact
   * match by claude pid). Otherwise fall back to "latest mtime in projectDir",
   * which is racy when two tabs share a cwd.
   */
  private async resolveSessionFile(
    sessionId: string | null,
    cwd: string | null,
  ): Promise<{ mtimeMs: number | null; file: string | null }> {
    if (sessionId && cwd) {
      const file = path.join(
        os.homedir(),
        '.claude',
        'projects',
        encodeCwd(cwd),
        `${sessionId}.jsonl`,
      );
      try {
        const stat = await fs.promises.stat(file);
        return { mtimeMs: stat.mtimeMs, file };
      } catch {
        /* file not yet created — fall through to mtime fallback */
      }
    }
    return this.latestJsonlForCwd(cwd);
  }

  private async latestJsonlForCwd(
    cwd: string | null,
  ): Promise<{ mtimeMs: number | null; file: string | null }> {
    if (!cwd) return { mtimeMs: null, file: null };
    const dir = path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwd));
    try {
      const names = await fs.promises.readdir(dir);
      let latest: { mtimeMs: number; file: string } | null = null;
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        const full = path.join(dir, name);
        try {
          const stat = await fs.promises.stat(full);
          if (!latest || stat.mtimeMs > latest.mtimeMs) latest = { mtimeMs: stat.mtimeMs, file: full };
        } catch {
          /* ignore per-file errors */
        }
      }
      return latest ? latest : { mtimeMs: null, file: null };
    } catch {
      return { mtimeMs: null, file: null };
    }
  }

  private async latestJsonlGlobal(): Promise<{
    mtimeMs: number | null;
    file: string | null;
    leaf: string | null;
  }> {
    const rootDir = path.join(os.homedir(), '.claude', 'projects');
    let best: { mtimeMs: number; file: string; leaf: string } | null = null;
    try {
      const leaves = await fs.promises.readdir(rootDir);
      for (const leaf of leaves) {
        const sub = path.join(rootDir, leaf);
        let names: string[] = [];
        try {
          names = await fs.promises.readdir(sub);
        } catch {
          continue;
        }
        for (const n of names) {
          if (!n.endsWith('.jsonl')) continue;
          const full = path.join(sub, n);
          try {
            const stat = await fs.promises.stat(full);
            if (!best || stat.mtimeMs > best.mtimeMs) best = { mtimeMs: stat.mtimeMs, file: full, leaf };
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore */
    }
    return best ? best : { mtimeMs: null, file: null, leaf: null };
  }
}

// ---------------------------------------------------------------------------
// listProcesses — minimal, cross-platform ps replacement. Avoids depending on
// `ps-list` (ESM-only; breaks when bundled into a CJS plugin).
// ---------------------------------------------------------------------------

export interface ProcessRow {
  pid: number;
  ppid: number;
  name: string;
  cmd?: string;
}

async function listProcesses(): Promise<ProcessRow[]> {
  if (process.platform === 'win32') return listProcessesWindows();
  return listProcessesUnix();
}

async function listProcessesUnix(): Promise<ProcessRow[]> {
  // POSIX ps: pid, ppid, comm (just the executable name). Quiet headers with '=' suffix.
  // Using `-A` (all) + `-o` with three columns.
  const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid=,comm='], {
    maxBuffer: 8 * 1024 * 1024,
    timeout: 3000,
  });
  const rows: ProcessRow[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Split on the first two whitespace runs; the rest is the command.
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const cmdLine = match[3];
    // `comm` on macOS shows the basename; on Linux it's truncated at 15 chars.
    // Strip path components for a consistent `name`.
    const name = cmdLine.split(/[\\/]/).pop() ?? cmdLine;
    rows.push({ pid, ppid, name, cmd: cmdLine });
  }
  return rows;
}

async function listProcessesWindows(): Promise<ProcessRow[]> {
  // wmic is legacy-but-ubiquitous; output format is CSV-ish with blank lines.
  const { stdout } = await execFileAsync(
    'wmic',
    ['process', 'get', 'ProcessId,ParentProcessId,Name', '/format:csv'],
    { maxBuffer: 8 * 1024 * 1024, timeout: 3000 },
  );
  const rows: ProcessRow[] = [];
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
  // First line is header like: Node,Name,ParentProcessId,ProcessId
  const [headerLine, ...bodyLines] = lines;
  if (!headerLine) return rows;
  const headers = headerLine.split(',').map((h) => h.trim().toLowerCase());
  const idxName = headers.indexOf('name');
  const idxPpid = headers.indexOf('parentprocessid');
  const idxPid = headers.indexOf('processid');
  if (idxName < 0 || idxPpid < 0 || idxPid < 0) return rows;
  for (const line of bodyLines) {
    const cols = line.split(',');
    const pid = Number(cols[idxPid]);
    const ppid = Number(cols[idxPpid]);
    const name = (cols[idxName] ?? '').trim();
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    rows.push({ pid, ppid, name });
  }
  return rows;
}
