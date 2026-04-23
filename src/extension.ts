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
import type { PermissionMode, PromptTurn } from './data/types';
import { buildPanelSections } from './ui/panel-layout';
import { handlePanelEvent } from './ui/event-handlers';
import { computeTurnStats, extractToolFilePath, type PromptTurnStats } from './data/types';
import type { SessionMeta } from './core/types';
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
    showMessage(options: { title?: string; content: string; format?: 'plain' | 'pre' | 'code'; closeText?: string }): Promise<void>;
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
      showNotification: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') =>
        api.ui.showNotification(msg, type),
      confirmRewind: (target: number, steps: number) =>
        fmt(t().confirmRewind, { target, n: steps }),
      manualHint: (steps: number) => fmt(t().rewindManualHint, { n: steps }),
      supportsNumericArg: false,
    },
    presetApplyDeps: {
      showConfirm: (msg: string) => api.ui.showConfirm(msg),
      showNotification: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') =>
        api.ui.showNotification(msg, type),
      messageNextLaunch: (name: string) => fmt(t().presetActivatedNextLaunch, { name }),
      messageRestartPrompt: t().confirmRestartForPreset,
    },
  };
}
