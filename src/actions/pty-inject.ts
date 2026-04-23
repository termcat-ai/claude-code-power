type TerminalWrite = (sessionId: string, data: string) => Promise<void>;
type TerminalFocus = (sessionId: string) => Promise<void>;

const CTRL_U = '\x15';

/**
 * Sequentially writes to a PTY: Ctrl+U to clear the current input line,
 * then the new text, then asks the host to focus the xterm. No Enter is ever
 * sent — the user presses Enter themselves.
 *
 * Per-sessionId serialization: concurrent fillLine calls on the same session
 * are chained; this prevents interleaved Ctrl+U / text pairs from corrupting
 * each other.
 */
export class PtyInjector {
  private queues = new Map<string, Promise<void>>();

  constructor(
    private readonly write: TerminalWrite,
    private readonly focus: TerminalFocus,
  ) {}

  async fillLine(sessionId: string, text: string): Promise<void> {
    return this.enqueue(sessionId, async () => {
      await this.write(sessionId, CTRL_U);
      if (text) await this.write(sessionId, text);
      await this.focus(sessionId).catch(() => {});
    });
  }

  /** Ctrl+U + text + CR — explicit "run now" (used by the launch button). */
  async sendLine(sessionId: string, text: string): Promise<void> {
    return this.enqueue(sessionId, async () => {
      await this.write(sessionId, CTRL_U);
      if (text) await this.write(sessionId, text);
      await this.write(sessionId, '\r');
    });
  }

  /**
   * Send raw bytes (e.g. control / escape sequences) without any Ctrl+U or CR.
   * Used to deliver key presses like Shift+Tab (`\x1b[Z`) to a running claude.
   */
  async sendRaw(sessionId: string, data: string): Promise<void> {
    if (!data) return;
    return this.enqueue(sessionId, async () => {
      await this.write(sessionId, data);
      await this.focus(sessionId).catch(() => {});
    });
  }

  /**
   * Press the same key sequence `times` in a row, with a small gap between
   * presses. Needed because claude's input handler debounces consecutive
   * identical escape sequences when they arrive in a single write — e.g.
   * `'\x1b[Z\x1b[Z'` is often treated as one Shift+Tab, not two.
   */
  async pressKey(sessionId: string, key: string, times: number, gapMs = 250): Promise<void> {
    if (!key || times <= 0) return;
    return this.enqueue(sessionId, async () => {
      for (let i = 0; i < times; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, gapMs));
        await this.write(sessionId, key);
      }
      await this.focus(sessionId).catch(() => {});
    });
  }

  private enqueue(sessionId: string, op: () => Promise<void>): Promise<void> {
    const prev = this.queues.get(sessionId) ?? Promise.resolve();
    const next = prev.then(op, op);
    this.queues.set(
      sessionId,
      next.catch(() => {}),
    );
    return next;
  }
}
