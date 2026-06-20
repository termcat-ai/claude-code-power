/**
 * Claude Code Power — plugin entry.
 *
 * Runs in Electron Main process. Wires detector / data / actions / UI
 * and registers a sidebar-right panel called 'claude-code-power'.
 */

import { setLanguage, t, fmt } from './i18n';
import { Store } from './core/state';
import { JsonlWatcher } from './data/jsonl-watcher';
import { SessionIndex } from './data/session-index';
import { SettingsReader } from './data/settings-reader';
import { projectDir } from './data/project-hash';
import { Detector, type TerminalHandle } from './detector/process-watcher';
import { PtyInjector } from './actions/pty-inject';
import { PresetStore } from './actions/preset-store';
import { reapPendingDriveTimeouts } from './actions/drive-mode';
import { injectLaunchCommand } from './actions/launch';
import type { PermissionMode, PromptTurn, NormalizedEvent } from './data/types';
import { buildPanelSections } from './ui/panel-layout';
import { handlePanelEvent } from './ui/event-handlers';
import { computeTurnStats, extractToolFilePath, type PromptTurnStats } from './data/types';
import type { SessionMeta } from './core/types';
import { CaptureStore } from './proxy/capture-store';
import { ProxyServer } from './proxy/proxy-server';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Host API shape (structural subset of termcat_client plugin-api.ts)
// ---------------------------------------------------------------------------
export interface PluginContext {
  pluginId: string;
  pluginPath: string;
  subscriptions: Array<{ dispose: () => void }>;
  logger: {
    info(msg: string, data?: Record<string, unknown>): void;
    warn(msg: string, data?: Record<string, unknown>): void;
    error(msg: string, data?: Record<string, unknown>): void;
    debug(msg: string, data?: Record<string, unknown>): void;
  };
  storagePath: string;
  /** Host plugin API proxy — injected by plugin-manager via Object.assign. */
  api?: HostAPI;
}

interface HostTerminalInfo {
  sessionId: string;
  hostId: string;
  title: string;
  isActive: boolean;
}

interface HostAPI {
  terminal: {
    getActiveTerminal(): Promise<HostTerminalInfo | null>;
    getTerminals(): Promise<HostTerminalInfo[]>;
    getPid(sessionId: string): Promise<number | null>;
    write(sessionId: string, data: string): Promise<void>;
    focus(sessionId: string): Promise<void>;
    onDidOpenTerminal(cb: (t: HostTerminalInfo) => void): { dispose: () => void };
    onDidCloseTerminal(cb: (t: HostTerminalInfo) => void): { dispose: () => void };
  };
  ui: {
    registerPanel(
      opts: unknown,
      onEvent?: (sectionId: string, eventId: string, payload: unknown) => void,
    ): { dispose: () => void };
    setPanelData(panelId: string, sections: unknown[]): void;
    updateSection(panelId: string, sectionId: string, data: unknown): void;
    showNotification(message: string, type?: 'info' | 'success' | 'warning' | 'error'): void;
    showConfirm(message: string, options?: { confirmText?: string; cancelText?: string }): Promise<boolean>;
    showInputBox(options: { title?: string; placeholder?: string; value?: string; password?: boolean }): Promise<string | undefined>;
    showMessage(options: {
      title?: string;
      content?: string;
      format?: 'plain' | 'pre' | 'code';
      tabs?: Array<{ label: string; content: string; format?: 'plain' | 'pre' | 'code' }>;
      closeText?: string;
    }): Promise<void>;
    showForm(options: {
      title?: string;
      description?: string;
      fields: Array<{
        id: string;
        label: string;
        type?: 'text' | 'password' | 'textarea' | 'select';
        value?: string;
        placeholder?: string;
        required?: boolean;
        hint?: string;
        options?: Array<{ label: string; value: string }>;
      }>;
      submitText?: string;
      cancelText?: string;
    }): Promise<Record<string, string> | undefined>;
  };
  commands: {
    registerCommand(id: string, handler: (...args: unknown[]) => unknown): { dispose: () => void };
  };
  events: {
    emit(name: string, data?: unknown): void;
    on(name: string, cb: (...args: unknown[]) => void): { dispose: () => void };
  };
  i18n: {
    getLanguage(): Promise<string>;
    onDidChangeLanguage(cb: (language: string) => void): { dispose: () => void };
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const PANEL_ID = 'claude-code-power';
const UI_REFRESH_DEBOUNCE_MS = 200;

// ---------------------------------------------------------------------------
// Module state (per-plugin-instance)
// ---------------------------------------------------------------------------
const disposables: Array<{ dispose: () => void }> = [];

/** Populated in activate() from context.api. Guarded by a runtime check. */
let api!: HostAPI;

// Per project-dir watcher, ref-counted.
const watchers = new Map<string, JsonlWatcher>();
// Per session-file SessionIndex.
const indices = new Map<string, SessionIndex>();
// Active terminals we're tracking.
const knownTerminals = new Map<string, HostTerminalInfo>();

let store: Store;
let presetStore: PresetStore;
let settingsReader: SettingsReader;
let detector: Detector;
let injector: PtyInjector;
let pluginLogger: PluginContext['logger'];

let captureStore: CaptureStore;
let proxyServer: ProxyServer;

let uiRefreshTimer: NodeJS.Timeout | null = null;
let driveReapTimer: NodeJS.Timeout | null = null;
let defaultPermissionMode: PermissionMode = 'default';

// ---------------------------------------------------------------------------
// Activate / deactivate
// ---------------------------------------------------------------------------
export async function activate(context: PluginContext): Promise<void> {
  pluginLogger = context.logger;
  pluginLogger.info('plugin.activate');
  if (!context.api) {
    throw new Error('Plugin context is missing .api — host did not inject plugin API.');
  }
  api = context.api;

  // Sync UI language with the host. The renderer forwards its I18nContext
  // via `plugin:i18n:language-change`; we seed from getLanguage() on
  // activate, then follow onDidChangeLanguage.
  try {
    const initialLang = await api.i18n.getLanguage();
    if (typeof initialLang === 'string') setLanguage(initialLang);
  } catch {
    setLanguage('zh');
  }
  disposables.push(
    api.i18n.onDidChangeLanguage((lang: unknown) => {
      if (typeof lang === 'string') {
        setLanguage(lang);
        flushPanelDataNow();
      }
    }),
  );

  store = new Store();
  presetStore = new PresetStore();
  settingsReader = new SettingsReader();
  captureStore = new CaptureStore();
  proxyServer = new ProxyServer(captureStore, () => {
    const active = presetStore.getActive();
    return active?.baseUrl || 'https://api.anthropic.com';
  });

  // Load presets + default permission mode.
  await presetStore.load();
  const presets = presetStore.list();
  store.setStage(presets.length === 0 ? 'NoPreset' : 'Ready');
  store.setActivePresetId(presetStore.getActive()?.id ?? null);
  defaultPermissionMode = await settingsReader.readDefaultPermissionMode();

  // External settings changes refresh UI.
  disposables.push(
    settingsReader.watch(async () => {
      defaultPermissionMode = await settingsReader.readDefaultPermissionMode();
      scheduleUiRefresh();
    }),
    presetStore.onDidChange(() => {
      store.setActivePresetId(presetStore.getActive()?.id ?? null);
      store.setStage(presetStore.list().length === 0 ? 'NoPreset' : 'Ready');
      scheduleUiRefresh();
    }),
  );

  // PTY injector uses host API directly.
  injector = new PtyInjector(
    (sid, data) => api.terminal.write(sid, data),
    (sid) => api.terminal.focus(sid),
  );

  // Register the panel with an onEvent callback that routes to actions.
  try {
    const panel = api.ui.registerPanel(
      {
        id: PANEL_ID,
        title: t().panelTitle,
        icon: 'sparkles',
        slot: 'sidebar-right',
        defaultSize: 380,
        defaultVisible: false,
        priority: 20,
        sections: [],
      },
      (sectionId, eventId, payload) => {
        void handlePanelEvent(
          { panelId: PANEL_ID, sectionId, eventId, payload },
          buildHandlerDeps(),
        ).catch((err) => pluginLogger.error('plugin.panel-event.failed', { err: String(err) }));
      },
    );
    disposables.push(panel);
  } catch (err) {
    pluginLogger.error('plugin.panel.register_failed', { err: String(err) });
  }

  // Commands
  disposables.push(
    api.commands.registerCommand('claude-code-power.togglePanel', () => {
      api.events.emit(`panel:toggle:${PANEL_ID}`);
    }),
    api.commands.registerCommand('claude-code-power.launchClaude', async () => {
      const active = await api.terminal.getActiveTerminal();
      if (!active) {
        api.ui.showNotification(t().terminalNotFound, 'warning');
        return;
      }
      const preset = presetStore.getActive();
      if (!preset) {
        api.ui.showNotification(t().noPresetTitle, 'info');
        return;
      }
      await presetStore.writeActiveEnv(preset);
      await injectLaunchCommand(active.sessionId, presetStore.activeEnvPath(), injector);
    }),
  );

  // Terminal lifecycle
  const onOpen = api.terminal.onDidOpenTerminal((term) => {
    knownTerminals.set(term.sessionId, term);
    detector.triggerNow();
  });
  const onClose = api.terminal.onDidCloseTerminal((term) => {
    knownTerminals.delete(term.sessionId);
    store.removeTab(term.sessionId);
    scheduleUiRefresh();
  });
  disposables.push(onOpen, onClose);

  // Seed existing terminals.
  try {
    const existing = await api.terminal.getTerminals();
    for (const term of existing) knownTerminals.set(term.sessionId, term);
    const active = existing.find((t) => t.isActive);
    if (active) store.setActiveTab(active.sessionId);
  } catch {
    /* best-effort */
  }

  // Active-tab change from host (user clicked a tab / focused a pane).
  // Push immediately — bypassing the 200ms debounce that data events use —
  // so the panel snaps to the new tab's content rather than lagging behind
  // the user's gesture.
  disposables.push(
    api.events.on('terminal:active-change', (sessionId: unknown) => {
      if (typeof sessionId === 'string') store.setActiveTab(sessionId);
      flushPanelDataNow();
    }),
  );

  // Detector drives per-tab state.
  detector = new Detector({
    getKnownSessions: () =>
      Array.from(knownTerminals.values()).map((term) => {
        const handle: TerminalHandle = {
          sessionId: term.sessionId,
          getPid: () => api.terminal.getPid(term.sessionId),
        };
        return handle;
      }),
    getActiveSessionId: () => store.getState().activeTabSessionId,
    onTabState: (tabState) => {
      store.upsertTab(tabState);
      if (tabState.detectedCwd) ensureWatcher(tabState.detectedCwd);

      // Host emits 'terminal:active-change' on tab/pane focus, so we only
      // seed an initial active tab here when none is set yet — never override
      // the user's explicit focus based on where claude happens to be running.
      if (!store.getState().activeTabSessionId) {
        store.setActiveTab(tabState.sessionId);
      }
      scheduleUiRefresh();
    },
  });
  detector.start();

  // Reap stale pending-drive timeouts every 5s.
  driveReapTimer = setInterval(() => {
    const timedOut = reapPendingDriveTimeouts(store);
    if (timedOut.length) scheduleUiRefresh();
  }, 5000);

  // Initial render
  scheduleUiRefresh();

  // Register dispose handlers
  disposables.push(
    { dispose: () => detector?.stop() },
    {
      dispose: () => {
        if (driveReapTimer) clearInterval(driveReapTimer);
        if (uiRefreshTimer) clearTimeout(uiRefreshTimer);
        for (const w of watchers.values()) w.release();
        watchers.clear();
        indices.clear();
      },
    },
    {
      dispose: () => {
        if (proxyServer.getPort() !== null) {
          // Best-effort: restore active.env without proxy override.
          const active = presetStore.getActive();
          if (active) {
            presetStore.writeActiveEnv(active).catch(() => {});
          }
          proxyServer.stop().catch(() => {});
          store.setProxyEnabled(false);
        }
      },
    },
  );

  context.subscriptions.push(...disposables);
}

export async function deactivate(): Promise<void> {
  for (const d of disposables.splice(0)) {
    try {
      d.dispose();
    } catch {
      /* swallow */
    }
  }
}

// ---------------------------------------------------------------------------
// JSONL watcher management
// ---------------------------------------------------------------------------
function ensureWatcher(cwd: string): void {
  const dir = projectDir(cwd);
  if (watchers.has(dir)) return;
  const w = new JsonlWatcher(dir);
  w.onEvents((filePath, events) => {
    let idx = indices.get(filePath);
    if (!idx) {
      idx = new SessionIndex();
      indices.set(filePath, idx);
    }
    idx.addEvents(events);

    // JSONL is the authoritative record of the mode (what claude actually
    // used for the last prompt). If a new permissionMode lands, drop the
    // locally-tracked pending drive — matching or not, the JSONL wins.
    // When it does not match, the user is effectively informed that the
    // Shift+Tab we sent didn't land where they asked.
    const active = store.getState().activeTabSessionId;
    const pending = active ? store.getPendingDrive(active) : null;
    if (pending) {
      const latest = idx.getLatestPermissionMode();
      if (latest) store.setPendingDrive(active!, null);
    }
    scheduleUiRefresh();
  });
  w.onCorrupt((filePath) => {
    pluginLogger.warn('plugin.jsonl.corrupt', { file: filePath });
  });
  w.acquire();
  watchers.set(dir, w);
}

// ---------------------------------------------------------------------------
// UI refresh
// ---------------------------------------------------------------------------
function scheduleUiRefresh(): void {
  if (uiRefreshTimer) return;
  uiRefreshTimer = setTimeout(() => {
    uiRefreshTimer = null;
    try {
      pushPanelData();
    } catch (err) {
      pluginLogger.error('plugin.ui.refresh_failed', { err: String(err) });
    }
  }, UI_REFRESH_DEBOUNCE_MS);
}

/**
 * Immediate refresh for user-driven events (tab switch) where the 200ms
 * debounce would feel sluggish. Cancels any pending debounced push and
 * runs pushPanelData synchronously.
 */
function flushPanelDataNow(): void {
  if (uiRefreshTimer) {
    clearTimeout(uiRefreshTimer);
    uiRefreshTimer = null;
  }
  try {
    pushPanelData();
  } catch (err) {
    pluginLogger.error('plugin.ui.refresh_failed', { err: String(err) });
  }
}

function selectedSessionFileForTab(tabSid: string): string | null {
  const state = store.getState();
  const userSel = store.getSelectedSessionFile(tabSid);
  const tab = state.perTabStates.get(tabSid);
  if (userSel) return userSel;
  return tab?.sessionFile ?? null;
}

function pushPanelData(): void {
  const state = store.getState();
  const activeSid = state.activeTabSessionId;
  const activeTab = activeSid ? state.perTabStates.get(activeSid) ?? null : null;

  // Enumerate all sessions in the active tab's projectDir (if any).
  let sessions: SessionMeta[] = [];
  let liveSessionFile: string | null = null;
  if (activeTab?.detectedCwd) {
    const dir = projectDir(activeTab.detectedCwd);
    sessions = listSessionsInDir(dir);
    store.setSessionsForProjectDir(dir, sessions);
    liveSessionFile = activeTab.sessionFile;
  }

  // What is the user viewing? User selection > live > latest-by-mtime.
  const userSelected = activeSid ? store.getSelectedSessionFile(activeSid) : null;
  const selectedSessionFile =
    userSelected && sessions.some((s) => s.filePath === userSelected)
      ? userSelected
      : liveSessionFile ?? sessions[0]?.filePath ?? null;

  // Ensure a watcher exists for the projectDir so the selected session's
  // events flow in (detector only asks for the live session's JSONL path;
  // a user-picked historical session shares the same watcher).
  if (activeTab?.detectedCwd) ensureWatcher(activeTab.detectedCwd);

  // Derive turns + stats for the selected session.
  let turns: PromptTurn[] = [];
  let turnsStats: PromptTurnStats[] = [];
  if (selectedSessionFile) {
    let idx = indices.get(selectedSessionFile);
    if (!idx) {
      // Watcher hasn't processed this file yet — best-effort seed parse so
      // the UI shows content on first selection rather than an empty list.
      const seeded = parseSessionFileSync(selectedSessionFile);
      if (seeded) {
        indices.set(selectedSessionFile, seeded);
        idx = seeded;
      }
    }
    if (idx) {
      turns = idx.getPromptTurns();
      turnsStats = turns.map((turn) => computeTurnStats(turn));
    }
  }

  // Drive mode effective
  let driveModeEffective: PermissionMode | null = null;
  let driveSource: 'session' | 'default' = 'default';
  if (selectedSessionFile) {
    const idx = indices.get(selectedSessionFile);
    const sessionMode = idx?.getLatestPermissionMode();
    if (sessionMode) {
      driveModeEffective = sessionMode;
      driveSource = 'session';
    }
  }
  if (!driveModeEffective) {
    driveModeEffective = defaultPermissionMode;
    driveSource = 'default';
  }

  const expandedTurns = activeSid ? store.getExpandedTurns(activeSid) : new Set<number>();
  const goto = activeSid ? store.getGoto(activeSid) : null;

  const sections = buildPanelSections({
    state,
    t: t(),
    activeTab,
    sessions,
    selectedSessionFile,
    liveSessionFile,
    turns,
    turnsStats,
    expandedTurns,
    goto,
    driveModeEffective,
    driveSource,
    presets: presetStore.list(),
    activePresetId: presetStore.getActive()?.id ?? null,
    claudeInstalled: true,
    proxyPort: proxyServer.getPort(),
  });
  api.ui.setPanelData(PANEL_ID, sections);
}

// ---------------------------------------------------------------------------
// Session enumeration
// ---------------------------------------------------------------------------
function listSessionsInDir(dir: string): SessionMeta[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const out: SessionMeta[] = [];
  for (const name of names) {
    const filePath = path.join(dir, name);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(filePath).mtimeMs;
    } catch {
      continue;
    }
    const sessionId = name.replace(/\.jsonl$/, '');
    const idx = indices.get(filePath);
    const turns = idx?.getPromptTurns() ?? [];
    const firstPromptPreview =
      turns[0]?.userEvent.text.replace(/\n+/g, ' ').slice(0, 60) ?? undefined;
    out.push({ filePath, sessionId, mtimeMs, firstPromptPreview, promptCount: turns.length });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/**
 * One-shot synchronous parse of a full JSONL file. Used when the user
 * selects a historical session that the incremental watcher hasn't yet
 * seen — we read it once, stuff events into a SessionIndex, and let the
 * watcher take over for any future appends.
 */
function parseSessionFileSync(filePath: string): SessionIndex | null {
  const text = readSyncSafe(filePath);
  if (!text) return null;
  // The parser is ESM-style imported at the top; re-inline logic via the
  // JsonlWatcher helpers would be cleaner, but a local loop keeps things
  // synchronous.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { parseJsonlLine, normalizeEvents } = require('./data/jsonl-parser') as typeof import('./data/jsonl-parser');
  const records = [];
  for (const line of text.split('\n')) {
    const r = parseJsonlLine(line);
    if (r) records.push(r);
  }
  const events = normalizeEvents(records);
  const idx = new SessionIndex();
  idx.addEvents(events);
  return idx;
}

function readSyncSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Raw turn data builder (for "view raw" modal)
// ---------------------------------------------------------------------------

/**
 * Re-read the JSONL and reconstruct the messages array up to turn N plus
 * the raw API responses for that turn. Returns a pretty-printed JSON string
 * suitable for showMessage({ format: 'pre' }).
 *
 * Note: Claude Code's system prompt and tool-definitions are never written
 * to the JSONL, so they cannot be included here.
 */
type RawTab = { label: string; content: string; format: 'pre' };
type RawGroup = { label: string; tabs: RawTab[] };
type RawResult = { tabs: RawTab[] } | { groups: RawGroup[] };

function fmtN(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

/**
 * Merge a raw Anthropic SSE stream into a human-readable string.
 * Collects text deltas, tool_use inputs, and usage stats.
 */
function mergeResponseSse(rawSse: string): string {
  type Block = { type: 'text'; text: string } | { type: 'tool_use'; name: string; input: string };
  const blocks = new Map<number, Block>();
  let model = '';
  let inputTokens = 0, outputTokens = 0, cacheRead = 0;
  let stopReason = '';

  for (const line of rawSse.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    let d: Record<string, unknown>;
    try { d = JSON.parse(line.slice(6)) as Record<string, unknown>; } catch { continue; }

    if (d.type === 'message_start') {
      const msg = d.message as Record<string, unknown> | undefined;
      model = (msg?.model as string) ?? '';
      const u = msg?.usage as Record<string, number> | undefined;
      if (u) {
        inputTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        cacheRead = u.cache_read_input_tokens ?? 0;
      }
    }
    if (d.type === 'content_block_start') {
      const idx = d.index as number;
      const cb = d.content_block as Record<string, unknown> | undefined;
      if (cb?.type === 'text') blocks.set(idx, { type: 'text', text: '' });
      else if (cb?.type === 'tool_use') blocks.set(idx, { type: 'tool_use', name: (cb.name as string) ?? '', input: '' });
    }
    if (d.type === 'content_block_delta') {
      const idx = d.index as number;
      const blk = blocks.get(idx);
      const delta = d.delta as Record<string, unknown> | undefined;
      if (blk?.type === 'text' && delta?.type === 'text_delta') blk.text += (delta.text as string) ?? '';
      if (blk?.type === 'tool_use' && delta?.type === 'input_json_delta') blk.input += (delta.partial_json as string) ?? '';
    }
    if (d.type === 'message_delta') {
      const delta = d.delta as Record<string, unknown> | undefined;
      stopReason = (delta?.stop_reason as string) ?? '';
      const u = d.usage as Record<string, number> | undefined;
      if (u?.output_tokens) outputTokens = u.output_tokens;
    }
  }

  const out: string[] = [];
  // Header
  const meta: string[] = [];
  if (model) meta.push(`model: ${model}`);
  if (inputTokens > 0) meta.push(`in: ${fmtN(inputTokens)}`);
  if (outputTokens > 0) meta.push(`out: ${fmtN(outputTokens)}`);
  if (cacheRead > 0) meta.push(`cache: ${fmtN(cacheRead)}`);
  if (stopReason) meta.push(`stop: ${stopReason}`);
  out.push(`# ${meta.join('  |  ')}`);

  // Content blocks in index order
  const SEP = '─'.repeat(60);
  for (const [, blk] of [...blocks.entries()].sort(([a], [b]) => a - b)) {
    out.push('');
    if (blk.type === 'text') {
      out.push(blk.text || '(empty text block)');
    } else {
      out.push(`${SEP}`);
      out.push(`[TOOL USE: ${blk.name}]`);
      try { out.push(JSON.stringify(JSON.parse(blk.input), null, 2)); }
      catch { out.push(blk.input || '{}'); }
      out.push(SEP);
    }
  }

  if (blocks.size === 0) out.push('\n(no content blocks found — response may still be streaming)');
  return out.join('\n');
}

/** Extract token usage from a raw Anthropic SSE stream. */
function parseUsageFromSse(rawSse: string): { input: number; output: number; cacheRead: number } | null {
  let input = 0, output = 0, cacheRead = 0, found = false;
  for (const line of rawSse.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const d = JSON.parse(line.slice(6)) as Record<string, unknown>;
      if (d.type === 'message_start') {
        const u = (d.message as Record<string, unknown> | undefined)?.usage as Record<string, number> | undefined;
        if (u) {
          input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
          cacheRead = u.cache_read_input_tokens ?? 0;
          found = true;
        }
      }
      if (d.type === 'message_delta') {
        const u = d.usage as Record<string, number> | undefined;
        if (u?.output_tokens) output = u.output_tokens;
      }
    } catch { /* skip malformed lines */ }
  }
  return found ? { input, output, cacheRead } : null;
}

/**
 * Format a JSONL assistant `message` object into a human-readable merged string.
 * Used when SSE stream is unavailable (JSONL reconstruction path).
 */
function formatAssistantMsgFromJsonl(msg: Record<string, unknown>): string {
  const out: string[] = [];
  const meta: string[] = [];
  if (msg.model) meta.push(`model: ${msg.model as string}`);
  const usage = msg.usage as Record<string, number> | undefined;
  if (usage) {
    const inp = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
    if (inp) meta.push(`in: ${fmtN(inp)}`);
    if (usage.output_tokens) meta.push(`out: ${fmtN(usage.output_tokens)}`);
    if (usage.cache_read_input_tokens) meta.push(`cache: ${fmtN(usage.cache_read_input_tokens)}`);
  }
  if (msg.stop_reason) meta.push(`stop: ${msg.stop_reason as string}`);
  out.push(`# ${meta.join('  |  ')}`);
  out.push('# (JSONL reconstruction — SSE stream not stored; enable proxy to capture stream)');

  const content = msg.content as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(content)) return out.join('\n');

  const SEP = '─'.repeat(60);
  for (const block of content) {
    out.push('');
    if (block.type === 'text') {
      out.push((block.text as string) ?? '');
    } else if (block.type === 'tool_use') {
      out.push(SEP);
      out.push(`[TOOL USE: ${block.name as string}]`);
      try { out.push(JSON.stringify(block.input, null, 2)); }
      catch { out.push(String(block.input)); }
      out.push(SEP);
    }
  }
  if (content.length === 0) out.push('\n(no content blocks)');
  return out.join('\n');
}

function getRawTurnParts(turnIndex: number, sessionFilePath: string): RawResult {
  const err = (msg: string): RawResult => ({ tabs: [{ label: 'Error', content: msg, format: 'pre' }] });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { parseJsonlLine } = require('./data/jsonl-parser') as typeof import('./data/jsonl-parser');

  const rawText = readSyncSafe(sessionFilePath);
  if (!rawText) return err('Error: could not read session file');

  const rawByUuid = new Map<string, Record<string, unknown>>();
  for (const line of rawText.split('\n')) {
    const r = parseJsonlLine(line);
    if (r && typeof r.uuid === 'string') rawByUuid.set(r.uuid, r);
  }

  const idx = indices.get(sessionFilePath);
  if (!idx) return err('Error: session not indexed');

  const turns = idx.getPromptTurns();
  const turn = turns.find((t) => t.index === turnIndex);
  if (!turn) return err(`Error: turn ${turnIndex} not found`);

  const lastAsstUuid = turn.assistantEvents[turn.assistantEvents.length - 1]?.uuid ?? null;
  const stopUuid = lastAsstUuid ?? turn.userEvent.uuid;

  const messages: Array<Record<string, unknown>> = [];
  for (const e of idx.getMainBranch()) {
    const raw = rawByUuid.get(e.uuid);
    if (!raw) continue;
    const topType = raw.type;
    if (topType === 'user' && !raw.isMeta) {
      const msg = raw.message as Record<string, unknown> | undefined;
      if (msg) messages.push({ role: 'user', content: msg.content });
    } else if (topType === 'assistant') {
      const msg = raw.message as Record<string, unknown> | undefined;
      if (msg) {
        messages.push({
          role: 'assistant',
          model: msg.model,
          content: msg.content,
          stop_reason: msg.stop_reason,
          usage: msg.usage,
        });
      }
    }
    if (e.uuid === stopUuid) break;
  }

  const apiResponses = turn.assistantEvents
    .map((ae) => rawByUuid.get(ae.uuid)?.message)
    .filter(Boolean);

  // Prefer proxy capture data (includes system prompt + tool definitions).
  // A single user turn may trigger multiple API calls (tool-use rounds), so
  // collect ALL captures in the window [userTs-5s, lastAsstTs+30s] and show
  // each one as a numbered section.
  const userTs = turn.userEvent.ts ?? 0;
  const lastAsstTs = turn.assistantEvents[turn.assistantEvents.length - 1]?.ts ?? userTs;
  const captures = captureStore
    .getByTimeRange(userTs - 5_000, lastAsstTs + 30_000)
    .sort((a, b) => a.captureTs - b.captureTs);

  if (captures.length > 0) {
    try {
      const makeTabs = (c: (typeof captures)[0]): RawTab[] => {
        const ts = new Date(c.captureTs).toISOString();
        const upstreamNote = `# ${ts}  upstream: ${c.upstreamUrl}\n\n`;
        const reqJson = JSON.stringify(c.request, null, 2);

        const usage = c.rawResponseSse ? parseUsageFromSse(c.rawResponseSse) : null;
        // fresh input = total - cache_read (= input_tokens + cache_creation_input_tokens)
        const freshIn = usage ? usage.input - usage.cacheRead : 0;
        const upSuffix = usage
          ? `  · in:${fmtN(freshIn)}${usage.cacheRead > 0 ? ` cache:${fmtN(usage.cacheRead)}` : ''}`
          : '';
        const outSuffix = usage ? `  · out:${fmtN(usage.output)}` : '';

        const rawSse = c.rawResponseSse ?? '(not yet captured)';
        const merged = c.rawResponseSse ? mergeResponseSse(c.rawResponseSse) : '(not yet captured)';
        return [
          { label: `${t().rawTabRequest}${upSuffix}`, content: upstreamNote + reqJson, format: 'pre' },
          { label: `${t().rawTabResponseStream}${outSuffix}`, content: rawSse, format: 'pre' },
          { label: `${t().rawTabResponseMerged}${outSuffix}`, content: merged, format: 'pre' },
        ];
      };
      // Single call → flat tabs (上行 / 下行).
      // Multiple calls → two-level: level-1 = 调用 N, level-2 = 上行 / 下行.
      if (captures.length === 1) {
        return { tabs: makeTabs(captures[0]) };
      }
      return {
        groups: captures.map((c, i) => ({ label: `调用 ${i + 1}`, tabs: makeTabs(c) })),
      };
    } catch { /* fall through to JSONL path */ }
  }

  // Fallback: JSONL reconstruction — per-call grouping.
  // Walk the main branch again, accumulating cumulative messages. Each time we
  // encounter an assistant event that belongs to this turn, snapshot the upstream
  // messages (= what was sent to the API) and the response message (= what came back).
  try {
    const JSONL_NOTE = '# JSONL reconstruction — system prompt and tool definitions not stored\n# Enable the proxy to capture the full SSE stream.\n\n';
    type CallEntry = { upstream: object[]; responseMsg: Record<string, unknown> };
    const callEntries: CallEntry[] = [];
    const cumMsgs: object[] = [];
    const turnAssistantUuids = new Set(turn.assistantEvents.map((ae) => ae.uuid));

    for (const e of idx.getMainBranch()) {
      const raw = rawByUuid.get(e.uuid);
      if (!raw) continue;
      if (raw.type === 'user' && !raw.isMeta) {
        const msg = raw.message as Record<string, unknown> | undefined;
        if (msg) cumMsgs.push({ role: 'user', content: msg.content });
      } else if (raw.type === 'assistant') {
        const msg = raw.message as Record<string, unknown> | undefined;
        if (msg) {
          if (turnAssistantUuids.has(e.uuid)) {
            callEntries.push({ upstream: [...cumMsgs], responseMsg: msg });
          }
          cumMsgs.push({ role: 'assistant', content: msg.content });
        }
      }
      if (e.uuid === stopUuid) break;
    }

    if (callEntries.length === 0) return err('Error: no assistant events found in JSONL');

    const makeJsonlTabs = (entry: CallEntry): RawTab[] => {
      const upJson = JSON.stringify(entry.upstream, null, 2);
      const usage = entry.responseMsg.usage as Record<string, number> | undefined;
      const freshIn = usage ? (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) : 0;
      const cacheRead = usage?.cache_read_input_tokens ?? 0;
      const out = usage?.output_tokens ?? 0;
      const upSuffix = freshIn > 0 || cacheRead > 0
        ? `  · in:${fmtN(freshIn)}${cacheRead > 0 ? ` cache:${fmtN(cacheRead)}` : ''}`
        : '';
      const outSuffix = out > 0 ? `  · out:${fmtN(out)}` : '';
      return [
        { label: `${t().rawTabRequest}${upSuffix}`, content: JSONL_NOTE + upJson, format: 'pre' },
        { label: `${t().rawTabResponseMerged}${outSuffix}`, content: formatAssistantMsgFromJsonl(entry.responseMsg), format: 'pre' },
      ];
    };

    if (callEntries.length === 1) return { tabs: makeJsonlTabs(callEntries[0]) };
    return { groups: callEntries.map((entry, i) => ({ label: `调用 ${i + 1}`, tabs: makeJsonlTabs(entry) })) };
  } catch {
    return err('Error: failed to serialize raw data');
  }
}

// ---------------------------------------------------------------------------
// Shared handler deps
// ---------------------------------------------------------------------------
function buildHandlerDeps() {
  return {
    store,
    injector,
    presetStore,
    getCurrentTurnCount: () => {
      const activeSid = store.getState().activeTabSessionId;
      const tab = activeSid ? store.getState().perTabStates.get(activeSid) : null;
      if (!tab?.sessionFile) return 0;
      const idx = indices.get(tab.sessionFile);
      return idx ? idx.getPromptTurns().length : 0;
    },
    getCurrentPermissionMode: (): PermissionMode => {
      const activeSid = store.getState().activeTabSessionId;
      // Prefer the plugin's locally-tracked pending mode — it reflects the
      // most recent mode the user picked in the panel, and is more up-to-date
      // than JSONL (which only records on user prompts). This also makes the
      // code idempotent against duplicate 'field-change' / 'form:change'
      // events from the form template.
      const pending = activeSid ? store.getPendingDrive(activeSid) : null;
      if (pending) return pending.mode;
      const tab = activeSid ? store.getState().perTabStates.get(activeSid) : null;
      if (tab?.sessionFile) {
        const idx = indices.get(tab.sessionFile);
        const sessionMode = idx?.getLatestPermissionMode();
        if (sessionMode) return sessionMode;
      }
      return defaultPermissionMode;
    },
    openRuleFileModal: async (filePath: string) => {
      let content = '';
      try {
        const MAX = 200 * 1024; // cap at 200KB
        content = fs.readFileSync(filePath, 'utf-8');
        if (content.length > MAX) {
          content = content.slice(0, MAX) + `\n\n... (truncated, full size ${content.length} bytes)`;
        }
      } catch (err) {
        content = `Failed to read file: ${String(err)}`;
      }
      await api.ui.showMessage({ title: filePath, content, format: 'pre' });
    },
    getUserBlockIdForTurn: (turnIndex: number) => {
      const activeSid = store.getState().activeTabSessionId;
      if (!activeSid) return null;
      const selected = selectedSessionFileForTab(activeSid);
      if (!selected) return null;
      const idx = indices.get(selected);
      if (!idx) return null;
      const turn = idx.getPromptTurns().find((t) => t.index === turnIndex);
      if (!turn) return null;
      return `user-${turn.userEvent.uuid}`;
    },
    openRawTurnModal: async (turnIndex: number) => {
      const activeSid = store.getState().activeTabSessionId;
      const sessionFile = activeSid ? selectedSessionFileForTab(activeSid) : null;
      if (!sessionFile) {
        api.ui.showNotification(t().terminalNotFound, 'warning');
        return;
      }
      const result = getRawTurnParts(turnIndex, sessionFile);
      await api.ui.showMessage({ title: `Turn #${turnIndex} — Raw`, ...result });
    },
    getToolFilePath: (turnIndex: number, toolIndex: number) => {
      const activeSid = store.getState().activeTabSessionId;
      if (!activeSid) return null;
      const selected = selectedSessionFileForTab(activeSid);
      if (!selected) return null;
      const idx = indices.get(selected);
      if (!idx) return null;
      const turn = idx.getPromptTurns().find((t) => t.index === turnIndex);
      if (!turn) return null;
      const allTools = turn.assistantEvents.flatMap((a) => a.toolUses);
      const tu = allTools[toolIndex];
      if (!tu) return null;
      return extractToolFilePath(tu);
    },
    showNotification: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') =>
      api.ui.showNotification(msg, type),
    showInputBox: (options: { title?: string; placeholder?: string; value?: string; password?: boolean }) =>
      api.ui.showInputBox(options),
    showForm: (options: Parameters<typeof api.ui.showForm>[0]) => api.ui.showForm(options),
    terminalNotFoundMessage: t().terminalNotFound,
    onPresetChanged: () => scheduleUiRefresh(),
    driveDeps: {
      settings: settingsReader,
      showConfirm: (msg: string) => api.ui.showConfirm(msg),
      showNotification: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') =>
        api.ui.showNotification(msg, type),
      confirmWriteDefault: (mode: PermissionMode) =>
        fmt(t().confirmWriteDefaultMode, { mode }),
    },
    rewindDeps: {
      showConfirm: (msg: string) => api.ui.showConfirm(msg),
      confirmRewind: (target: number, steps: number) =>
        fmt(t().confirmRewind, { target, n: steps }),
    },
    presetApplyDeps: {
      showConfirm: (msg: string) => api.ui.showConfirm(msg),
      showNotification: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') =>
        api.ui.showNotification(msg, type),
      messageNextLaunch: (name: string) => fmt(t().presetActivatedNextLaunch, { name }),
      messageRestartPrompt: t().confirmRestartForPreset,
      getProxyOverrideUrl: () => {
        const port = proxyServer.getPort();
        return port !== null ? `http://127.0.0.1:${port}` : null;
      },
    },
    toggleProxy: async (enable: boolean) => {
      if (enable) {
        try {
          const port = await proxyServer.start();
          const proxyUrl = `http://127.0.0.1:${port}`;
          const active = presetStore.getActive();
          if (active) {
            await presetStore.writeActiveEnv(active, { overrideBaseUrl: proxyUrl });
          }
          store.setProxyEnabled(true);
          scheduleUiRefresh();
          const activeSid = store.getState().activeTabSessionId;
          const activeTab = activeSid ? store.getState().perTabStates.get(activeSid) : null;
          const claudeRunning = activeTab?.status === 'active' || activeTab?.status === 'active-idle';
          api.ui.showNotification(fmt(t().proxyStarted, { port }), claudeRunning ? 'warning' : 'success');
        } catch (err) {
          api.ui.showNotification(`Proxy start failed: ${String(err)}`, 'error');
        }
      } else {
        await proxyServer.stop();
        const active = presetStore.getActive();
        if (active) {
          await presetStore.writeActiveEnv(active);
        }
        store.setProxyEnabled(false);
        scheduleUiRefresh();
        api.ui.showNotification(t().proxyStopped, 'info');
      }
    },
  };
}
