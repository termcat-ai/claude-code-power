import type { PtyInjector } from './pty-inject';
import { SLASH } from './commands';

export interface RewindDeps {
  injector: PtyInjector;
  showConfirm: (message: string) => Promise<boolean>;
  confirmRewind: (targetIndex: number, steps: number) => string;
}

/**
 * Rewind to keep 1..targetIndex, discard targetIndex+1..currentIndex.
 * Steps = currentIndex - targetIndex.
 *
 * Fills `/rewind` into the input line (no Enter) and focuses the terminal so
 * the user can immediately confirm and navigate claude's rewind menu. Numeric
 * argument (`/rewind N`) was tested in claude 2.1.120 and behaves identically
 * to `/rewind` (still opens the menu), so we don't pre-fill the count.
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
  await deps.injector.fillLine(sessionId, SLASH.REWIND);
}
