export interface RawCapture {
  requestId: string;
  /** ms epoch — when the request arrived at the proxy. */
  captureTs: number;
  /** Full request body (system / messages / tools / model …). API key is NOT stored here; it was in headers. */
  request: Record<string, unknown>;
  upstreamUrl: string;
  /** `msg_xxx` id from the Anthropic response, if available. */
  responseMessageId: string | null;
  /** Raw SSE body exactly as received from upstream (before any parsing). */
  rawResponseSse: string | null;
  responseTs: number | null;
}

const MAX_CAPTURES = 200;

export class CaptureStore {
  private byId = new Map<string, RawCapture>();
  /** msg_xxx → requestId, for fast lookup after JSONL match. */
  private byMsgId = new Map<string, string>();

  add(capture: RawCapture): void {
    this.byId.set(capture.requestId, capture);
    if (capture.responseMessageId) {
      this.byMsgId.set(capture.responseMessageId, capture.requestId);
    }
    // LRU trim: evict oldest entry once over cap.
    if (this.byId.size > MAX_CAPTURES) {
      const oldest = this.byId.keys().next().value as string | undefined;
      if (oldest) {
        const old = this.byId.get(oldest);
        if (old?.responseMessageId) this.byMsgId.delete(old.responseMessageId);
        this.byId.delete(oldest);
      }
    }
  }

  updateResponse(
    requestId: string,
    update: {
      rawResponseSse: string;
      responseMessageId: string | null;
      responseTs: number;
    },
  ): void {
    const cap = this.byId.get(requestId);
    if (!cap) return;
    cap.rawResponseSse = update.rawResponseSse;
    cap.responseMessageId = update.responseMessageId;
    cap.responseTs = update.responseTs;
    if (update.responseMessageId) {
      this.byMsgId.set(update.responseMessageId, requestId);
    }
  }

  getByRequestId(id: string): RawCapture | null {
    return this.byId.get(id) ?? null;
  }

  /** Find captures whose `captureTs` falls within [from, to] (inclusive). */
  getByTimeRange(from: number, to: number): RawCapture[] {
    const out: RawCapture[] = [];
    for (const cap of this.byId.values()) {
      if (cap.captureTs >= from && cap.captureTs <= to) out.push(cap);
    }
    return out;
  }

  getByMessageId(msgId: string): RawCapture | null {
    const id = this.byMsgId.get(msgId);
    return id ? (this.byId.get(id) ?? null) : null;
  }

  clear(): void {
    this.byId.clear();
    this.byMsgId.clear();
  }

  size(): number {
    return this.byId.size;
  }
}
