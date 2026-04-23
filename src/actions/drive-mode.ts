import type { PermissionMode } from '../data/types';
import type { Store } from '../core/state';
import type { PtyInjector } from './pty-inject';
import type { SettingsReader } from '../data/settings-reader';
import { KEY, PERMISSION_CYCLE, type CyclePermissionMode } from './commands';
import { t, fmt } from '../i18n';

// pendingDrive holds the plugin's locally-tracked "we just switched to X"
// state. Shift+Tab does not produce a JSONL event, so JSONL can only confirm
// the mode once the user sends their next prompt. Until then this pending
// state is the authoritative source. Keep it alive for an hour as a safety
// net in case the user never prompts again on this tab.
const PENDING_TIMEOUT_MS = 60 * 60 * 1000;

export interface DriveModeDeps {
  store: Store;
  injector: PtyInjector;
  settings: SettingsReader;
  showConfirm: (message: string) => Promise<boolean>;
  showNotification: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  confirmWriteDefault: (mode: PermissionMode) => string;
  /** Currently effective permission mode for the active tab (session-level, or default). */
  currentMode: PermissionMode;
}

function isCycleMode(m: PermissionMode): m is CyclePermissionMode {
  return (PERMISSION_CYCLE as readonly string[]).includes(m);
}

/**
 * Change the permission mode.
 *
 * When claude is running in the tab, we simulate the Shift+Tab keyboard cycle
 * (claude's real UX for switching modes — there is no slash command). We send
 * N Shift+Tab presses so the mode lands on the target.
 *
 * The cycle `default → acceptEdits → plan → default` excludes `bypassPermissions`,
 * which can only be entered by launching claude with `--dangerously-skip-permissions`.
 *
 * When claude is not running, we fall back to writing `permissions.defaultMode`
 * in `~/.claude/settings.json` after user confirmation.
 */
export async function setDriveMode(
  sessionId: string,
  mode: PermissionMode,
  deps: DriveModeDeps,
): Promise<void> {
  const tab = deps.store.getState().perTabStates.get(sessionId);
  const hasClaude = tab && (tab.status === 'active' || tab.status === 'active-idle');

  if (hasClaude) {
    if (mode === 'bypassPermissions') {
      deps.showNotification(t().cannotEnterBypass, 'warning');
      return;
    }
    if (deps.currentMode === 'bypassPermissions') {
      deps.showNotification(t().cannotLeaveBypass, 'warning');
      return;
    }
    if (!isCycleMode(mode) || !isCycleMode(deps.currentMode)) {
      deps.showNotification(
        fmt(t().unknownModePair, { from: deps.currentMode, to: mode }),
        'warning',
      );
      return;
    }
    const from = PERMISSION_CYCLE.indexOf(deps.currentMode);
    const to = PERMISSION_CYCLE.indexOf(mode);
    const steps = (to - from + PERMISSION_CYCLE.length) % PERMISSION_CYCLE.length;
    if (steps === 0) return; // already at target
    // Optimistically set pending BEFORE sending keys so the panel reflects
    // the target immediately — otherwise the UI waits for all pressKey gaps
    // (250ms each) to complete before reading the new mode.
    deps.store.setPendingDrive(sessionId, {
      mode,
      deadline: Date.now() + PENDING_TIMEOUT_MS,
    });
    // Important: press one-at-a-time with a small gap. Claude's input handler
    // coalesces identical escape sequences that arrive in the same write, so
    // sending `'\x1b[Z'.repeat(2)` lands as a single Shift+Tab.
    await deps.injector.pressKey(sessionId, KEY.SHIFT_TAB, steps);
    return;
  }

  const confirmed = await deps.showConfirm(deps.confirmWriteDefault(mode));
  if (!confirmed) return;
  try {
    await deps.settings.writeDefaultPermissionMode(mode);
  } catch (err) {
    deps.showNotification(fmt(t().writeSettingsFailed, { err: String(err) }), 'error');
  }
}

/**
 * Advance the permission mode by exactly one step in the Shift+Tab cycle.
 * Delegates to setDriveMode with target = next(current), so it always sends
 * a single Shift+Tab — no multi-press step accumulation bugs possible.
 */
export async function cycleDriveMode(
  sessionId: string,
  deps: DriveModeDeps,
): Promise<void> {
  const current = deps.currentMode;
  if (current === 'bypassPermissions') {
    deps.showNotification(t().cannotCycleBypass, 'warning');
    return;
  }
  if (!isCycleMode(current)) {
    deps.showNotification(fmt(t().unknownMode, { mode: current }), 'warning');
    return;
  }
  const idx = PERMISSION_CYCLE.indexOf(current);
  const next = PERMISSION_CYCLE[(idx + 1) % PERMISSION_CYCLE.length];
  await setDriveMode(sessionId, next, deps);
}

/** Periodically drop pending drives whose deadline passed. Returns sessionIds that timed out. */
export function reapPendingDriveTimeouts(store: Store): string[] {
  const now = Date.now();
  const timedOut: string[] = [];
  for (const [sessionId, pending] of store.getState().pendingDrive) {
    if (now >= pending.deadline) timedOut.push(sessionId);
  }
  for (const id of timedOut) store.setPendingDrive(id, null);
  return timedOut;
}
