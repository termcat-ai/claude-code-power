import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const RULE_NAMES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'];

/**
 * Return the absolute paths of all rule / context files Claude Code would
 * auto-load for the given cwd, based on current behavior:
 *
 *   1. Global user memory:  ~/.claude/CLAUDE.md | AGENTS.md | GEMINI.md
 *   2. Walk from `cwd` up to the user's home (inclusive), at each level pick
 *      CLAUDE.md / AGENTS.md / GEMINI.md that exist.
 *   3. Project-local `.claude/*.md`: all markdown files in `<cwd>/.claude/`.
 *
 * Only files that actually exist on disk are returned. Duplicates are removed.
 */
export function findLoadedRuleFiles(cwd: string): string[] {
  const found = new Set<string>();
  const home = os.homedir();

  // 1. Global
  for (const name of RULE_NAMES) {
    const p = path.join(home, '.claude', name);
    if (existsSyncSafe(p)) found.add(p);
  }
  // Also global `.claude/*.md` (e.g. global custom rules)
  addAllMdInDir(path.join(home, '.claude'), found, { topLevelOnly: true });

  // 2. Walk from cwd up to $HOME
  const resolved = path.resolve(cwd);
  let cur = resolved;
  const stop = home + path.sep;
  for (;;) {
    for (const name of RULE_NAMES) {
      const p = path.join(cur, name);
      if (existsSyncSafe(p)) found.add(p);
    }
    // stop at $HOME or when we can't go up
    if (cur === home || cur === path.parse(cur).root) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    if (!(parent + path.sep).startsWith(stop) && parent !== home) {
      // Went outside home — still include the $HOME entry itself but stop.
      // (Already handled by global step above.)
      break;
    }
    cur = parent;
  }

  // 3. Project-local `.claude/*.md`
  addAllMdInDir(path.join(resolved, '.claude'), found);

  return [...found].sort();
}

function existsSyncSafe(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function addAllMdInDir(dir: string, into: Set<string>, opts?: { topLevelOnly?: boolean }): void {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name.endsWith('.md')) {
        into.add(full);
      } else if (!opts?.topLevelOnly && e.isDirectory() && e.name !== 'projects') {
        // Recurse one level into subdirs like `.claude/rules/`
        try {
          const sub = fs.readdirSync(full, { withFileTypes: true });
          for (const s of sub) {
            if (s.isFile() && s.name.endsWith('.md')) {
              into.add(path.join(full, s.name));
            }
          }
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* dir missing — fine */
  }
}
