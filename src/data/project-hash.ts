import * as os from 'os';
import * as path from 'path';

/**
 * Claude Code encodes cwd into a flat directory name by replacing both '/'
 * and '_' with '-'. The root directory `~/.claude/projects/<encoded>` holds
 * one `.jsonl` per session.
 *
 * Examples (observed on disk):
 *   /Users/dum/work/foo                  → -Users-dum-work-foo
 *   /Users/dum/Vmware_Share/dum_dev/x    → -Users-dum-Vmware-Share-dum-dev-x
 *   /home/bob/src/a.b                    → -home-bob-src-a-b   (all non-[A-Za-z0-9] → '-')
 *
 * Older claude versions preserved '_'; the lookup is lossy so the detector
 * also falls back to the "most recent JSONL across all project dirs" heuristic.
 */
export function encodeCwd(cwd: string): string {
  const normalized = path.resolve(cwd).replace(/\/+$/, '') || '/';
  // Replace any character that isn't a latin letter or digit with '-'.
  // This matches current Claude Code behaviour (both '/' and '_' → '-', '.' → '-', etc).
  return normalized.replace(/[^A-Za-z0-9]/g, '-');
}

export function projectDir(cwd: string, homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.claude', 'projects', encodeCwd(cwd));
}

/**
 * Best-effort reverse map: given an encoded project-dir basename (the leaf
 * like `-Users-dum-work-foo`), reconstruct the original cwd by flipping '-'
 * back to '/'. This is a lossy inverse — a cwd that originally contained '-'
 * or '_' is indistinguishable from a '/' separator — but good enough for the
 * "most-recent-JSONL" fallback path in the detector.
 */
export function cwdFromProjectDirLeaf(leaf: string): string {
  if (!leaf.startsWith('-')) return leaf;
  return leaf.replaceAll('-', '/');
}
