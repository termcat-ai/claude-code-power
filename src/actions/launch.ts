import type { PtyInjector } from './pty-inject';

/** Build the shell command used to launch claude with the plugin's active.env. */
export function buildLaunchCommand(envPath: string): string {
  // Single-quote the path to tolerate spaces / unicode.
  const quoted = "'" + envPath.replaceAll("'", "'\\''") + "'";
  return `set -a; source ${quoted}; set +a; claude`;
}

/**
 * Inject and run the launch command in the target terminal.
 * Unlike other plugin writes (which stop at the input line for user review),
 * the launch button is an explicit "start now" gesture — sending CR here is
 * the intended behaviour.
 */
export async function injectLaunchCommand(
  sessionId: string,
  envPath: string,
  injector: PtyInjector,
): Promise<void> {
  await injector.sendLine(sessionId, buildLaunchCommand(envPath));
}
