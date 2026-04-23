import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { PermissionMode } from './types';

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

function isPermissionMode(v: unknown): v is PermissionMode {
  return (
    v === 'default' ||
    v === 'acceptEdits' ||
    v === 'plan' ||
    v === 'auto' ||
    v === 'bypassPermissions'
  );
}

/**
 * Read/patch `~/.claude/settings.json` atomically.
 * - Preserves unrelated keys (we only touch permissions.defaultMode).
 * - Exposes external-modification events so the UI can refresh if the user
 *   edits the file directly.
 */
export class SettingsReader {
  private watcher: FSWatcher | null = null;
  private externalChangeListeners: Array<() => void> = [];
  private lastWrittenMtime = 0;

  async readDefaultPermissionMode(): Promise<PermissionMode> {
    try {
      const text = await fs.promises.readFile(SETTINGS_PATH, 'utf-8');
      const obj = JSON.parse(text);
      const candidate = obj?.permissions?.defaultMode;
      if (isPermissionMode(candidate)) return candidate;
    } catch {
      // file missing / unreadable / invalid json → fallback
    }
    return 'default';
  }

  async writeDefaultPermissionMode(mode: PermissionMode): Promise<void> {
    let existing: Record<string, unknown> = {};
    try {
      const text = await fs.promises.readFile(SETTINGS_PATH, 'utf-8');
      existing = JSON.parse(text);
      if (typeof existing !== 'object' || existing === null) existing = {};
    } catch {
      // missing file — will create
    }

    const permissions = (existing.permissions ?? {}) as Record<string, unknown>;
    permissions.defaultMode = mode;
    existing.permissions = permissions;

    const serialized = JSON.stringify(existing, null, 2) + '\n';
    const tmp = SETTINGS_PATH + '.tc-tmp';
    await fs.promises.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
    await fs.promises.writeFile(tmp, serialized, 'utf-8');
    await fs.promises.rename(tmp, SETTINGS_PATH);
    try {
      const stat = await fs.promises.stat(SETTINGS_PATH);
      this.lastWrittenMtime = stat.mtimeMs;
    } catch {
      /* best-effort */
    }
  }

  watch(cb: () => void): { dispose: () => void } {
    this.externalChangeListeners.push(cb);
    if (!this.watcher) {
      this.watcher = chokidar.watch(SETTINGS_PATH, { persistent: true, ignoreInitial: true });
      this.watcher.on('change', async () => {
        try {
          const stat = await fs.promises.stat(SETTINGS_PATH);
          // Skip echo from our own write.
          if (Math.abs(stat.mtimeMs - this.lastWrittenMtime) < 5) return;
        } catch {
          /* ignore */
        }
        for (const l of this.externalChangeListeners) l();
      });
    }
    return {
      dispose: () => {
        this.externalChangeListeners = this.externalChangeListeners.filter((l) => l !== cb);
        if (this.externalChangeListeners.length === 0 && this.watcher) {
          this.watcher.close().catch(() => {});
          this.watcher = null;
        }
      },
    };
  }
}
