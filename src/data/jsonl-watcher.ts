import * as fs from 'fs';
import * as path from 'path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { NormalizedEvent } from './types';
import { normalizeEvents, parseJsonlLine, type RawRecord } from './jsonl-parser';

interface FileState {
  byteOffset: number;
  corrupted: boolean;
  consecutiveFailures: number;
  /** Lines that arrived within the current backpressure window. */
  buffered: NormalizedEvent[];
  flushTimer: NodeJS.Timeout | null;
  lastFlushAt: number;
}

type EventListener = (filePath: string, events: NormalizedEvent[]) => void;
type CorruptListener = (filePath: string) => void;

const MAX_CONSECUTIVE_FAILURES = 50;
const BACKPRESSURE_WINDOW_MS = 200;
const LARGE_BURST_THRESHOLD = 200; // lines per flush window → always coalesce

/**
 * Watches all `*.jsonl` files under a Claude Code project directory and emits
 * normalized events incrementally. Each file maintains its own byte offset so
 * that chokidar fs events trigger only a delta read.
 */
export class JsonlWatcher {
  private watcher: FSWatcher | null = null;
  private fileStates = new Map<string, FileState>();
  private listeners: EventListener[] = [];
  private corruptListeners: CorruptListener[] = [];
  private refCount = 0;

  constructor(private readonly projectDir: string) {}

  /** Increment refcount; first caller starts the underlying watcher. */
  acquire(): void {
    this.refCount++;
    if (this.refCount === 1) this.start();
  }

  /** Decrement refcount; last caller stops the watcher. */
  release(): void {
    this.refCount = Math.max(0, this.refCount - 1);
    if (this.refCount === 0) this.stop();
  }

  onEvents(cb: EventListener): { dispose: () => void } {
    this.listeners.push(cb);
    return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== cb); } };
  }

  onCorrupt(cb: CorruptListener): { dispose: () => void } {
    this.corruptListeners.push(cb);
    return { dispose: () => { this.corruptListeners = this.corruptListeners.filter((l) => l !== cb); } };
  }

  /** Existing `.jsonl` files in the project dir (useful for detector mtime scan). */
  listExistingJsonlFiles(): Promise<string[]> {
    return fs.promises
      .readdir(this.projectDir)
      .then((names) =>
        names.filter((n) => n.endsWith('.jsonl')).map((n) => path.join(this.projectDir, n)),
      )
      .catch(() => []);
  }

  private start(): void {
    this.watcher = chokidar.watch(path.join(this.projectDir, '*.jsonl'), {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 20 },
    });

    this.watcher.on('add', (p) => this.handleChange(p));
    this.watcher.on('change', (p) => this.handleChange(p));
    this.watcher.on('unlink', (p) => this.fileStates.delete(p));
    this.watcher.on('error', () => {
      /* swallow — chokidar is noisy about EPERM on macOS sleep wake */
    });
  }

  private stop(): void {
    this.watcher?.close().catch(() => {});
    this.watcher = null;
    for (const state of this.fileStates.values()) {
      if (state.flushTimer) clearTimeout(state.flushTimer);
    }
    this.fileStates.clear();
  }

  private getOrInit(filePath: string): FileState {
    let s = this.fileStates.get(filePath);
    if (!s) {
      s = {
        byteOffset: 0,
        corrupted: false,
        consecutiveFailures: 0,
        buffered: [],
        flushTimer: null,
        lastFlushAt: 0,
      };
      this.fileStates.set(filePath, s);
    }
    return s;
  }

  private async handleChange(filePath: string): Promise<void> {
    const state = this.getOrInit(filePath);
    if (state.corrupted) return;

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      return; // file disappeared between event and stat — chokidar will send unlink
    }

    // File truncated (rotation / re-create) — reset offset
    if (stat.size < state.byteOffset) state.byteOffset = 0;
    if (stat.size === state.byteOffset) return; // nothing new

    const start = state.byteOffset;
    state.byteOffset = stat.size;

    const lines = await readLines(filePath, start, stat.size);
    if (!lines.length) return;

    const records: RawRecord[] = [];
    for (const line of lines) {
      const rec = parseJsonlLine(line);
      if (rec) {
        records.push(rec);
        state.consecutiveFailures = 0;
      } else if (line.trim()) {
        state.consecutiveFailures++;
        if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          state.corrupted = true;
          for (const cb of this.corruptListeners) cb(filePath);
          return;
        }
      }
    }

    const events = normalizeEvents(records);
    if (!events.length) return;

    state.buffered.push(...events);

    // Coalesce bursts into a single flush window.
    const shouldCoalesce = state.buffered.length > LARGE_BURST_THRESHOLD;
    if (state.flushTimer) return; // already scheduled
    const delay = shouldCoalesce ? BACKPRESSURE_WINDOW_MS : 0;
    state.flushTimer = setTimeout(() => {
      state.flushTimer = null;
      const payload = state.buffered;
      state.buffered = [];
      state.lastFlushAt = Date.now();
      for (const cb of this.listeners) cb(filePath, payload);
    }, delay);
  }
}

/**
 * Read bytes [start, end) from a file and split on '\n'. Partial final line
 * is returned as a single element; caller can decide to keep or drop.
 *
 * Note: this re-reads synchronously from a stream because `fs.read` on a
 * small slice is cleanest here. Chokidar's awaitWriteFinish already ensures
 * we're not reading half-written content.
 */
async function readLines(filePath: string, start: number, end: number): Promise<string[]> {
  return new Promise<string[]>((resolve) => {
    const buf: Buffer[] = [];
    const stream = fs.createReadStream(filePath, { start, end: Math.max(start, end - 1) });
    stream.on('data', (chunk) => buf.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
    stream.on('end', () => {
      const text = Buffer.concat(buf).toString('utf-8');
      if (!text) resolve([]);
      else resolve(text.split('\n'));
    });
    stream.on('error', () => resolve([]));
  });
}
