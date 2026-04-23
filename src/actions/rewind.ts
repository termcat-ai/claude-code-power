import type { PtyInjector } from './pty-inject';
import { SLASH } from './commands';

export interface RewindDeps {
  injector: PtyInjector;
  showConfirm: (message: string) => Promise<boolean>;
  showNotification: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  confirmRewind: (targetIndex: number, steps: number) => string;
  manualHint: (steps: number) => string;
  /** v1: default false — claude's `/rewind N` signature not confirmed. */
  supportsNumericArg?: boolean;
}

/**
 * Rewind to keep 1..targetIndex, discard targetIndex+1..currentIndex.
 * Steps = currentIndex - targetIndex.
 */
export async function rewindTo(
  sessionId: string,
  currentIndex: number,
  targetIndex: number,
  deps: RewindDeps,
): Promise<void> {
  const steps = currentIndex - targetIndex;
  if (steps <= 0) return;
  const confirmed = await deps.showConfirm(deps.confirmRewind(targetIndex, steps));
  if (!confirmed) return;

  if (deps.supportsNumericArg) {
    await deps.injector.fillLine(sessionId, `${SLASH.REWIND} ${steps}`);
  } else {
    await deps.injector.fillLine(sessionId, SLASH.REWIND);
    deps.showNotification(deps.manualHint(steps), 'info');
  }
}
