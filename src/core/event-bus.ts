type Listener<T = unknown> = (payload: T) => void;

/** Minimal string-keyed event bus with unsubscribe handles. */
export class EventBus {
  private listeners = new Map<string, Array<Listener<unknown>>>();

  on<T = unknown>(event: string, cb: Listener<T>): { dispose: () => void } {
    const list = this.listeners.get(event) ?? [];
    list.push(cb as Listener<unknown>);
    this.listeners.set(event, list);
    return {
      dispose: () => {
        const arr = this.listeners.get(event);
        if (!arr) return;
        const idx = arr.indexOf(cb as Listener<unknown>);
        if (idx >= 0) arr.splice(idx, 1);
      },
    };
  }

  emit<T = unknown>(event: string, payload: T): void {
    const list = this.listeners.get(event);
    if (!list) return;
    for (const cb of list.slice()) {
      try {
        cb(payload);
      } catch {
        // swallow — one listener should not break the bus
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
