import { EventBus } from './event-bus';
import {
  initialAppState,
  type AppState,
  type PendingDrive,
  type PerTabState,
  type SessionMeta,
} from './types';

/**
 * AppState container. Holds mutable state + an event bus. Callers mutate via
 * the provided methods so change events fire consistently.
 *
 * Events emitted:
 *   - `state:tab-change`    (sessionId)
 *   - `state:active-change` (sessionId | null)
 *   - `state:drive-pending` (sessionId | null)  — fired when pendingDrive is set/cleared for a tab
 *   - `state:preset-change` (presetId | null)
 *   - `state:stage-change`  (Stage)
 */
export class Store {
  readonly bus = new EventBus();
  private state: AppState = initialAppState();

  getState(): AppState {
    return this.state;
  }

  setStage(stage: AppState['stage']): void {
    if (this.state.stage === stage) return;
    this.state.stage = stage;
    this.bus.emit('state:stage-change', stage);
  }

  setActivePresetId(id: string | null): void {
    if (this.state.activePresetId === id) return;
    this.state.activePresetId = id;
    this.bus.emit('state:preset-change', id);
  }

  setActiveTab(sessionId: string | null): void {
    if (this.state.activeTabSessionId === sessionId) return;
    this.state.activeTabSessionId = sessionId;
    this.bus.emit('state:active-change', sessionId);
  }

  upsertTab(state: PerTabState): void {
    this.state.perTabStates.set(state.sessionId, state);
    this.bus.emit('state:tab-change', state.sessionId);
  }

  removeTab(sessionId: string): void {
    if (!this.state.perTabStates.has(sessionId)) return;
    this.state.perTabStates.delete(sessionId);
    this.state.pendingDrive.delete(sessionId);
    this.bus.emit('state:tab-change', sessionId);
  }

  setPendingDrive(sessionId: string, pending: PendingDrive | null): void {
    if (pending) this.state.pendingDrive.set(sessionId, pending);
    else this.state.pendingDrive.delete(sessionId);
    this.bus.emit('state:drive-pending', sessionId);
  }

  getPendingDrive(sessionId: string): PendingDrive | null {
    return this.state.pendingDrive.get(sessionId) ?? null;
  }

  setSessionsForProjectDir(projectDir: string, sessions: SessionMeta[]): void {
    this.state.sessionsByProjectDir.set(projectDir, sessions);
    this.bus.emit('state:sessions-change', projectDir);
  }

  getSessionsForProjectDir(projectDir: string): SessionMeta[] {
    return this.state.sessionsByProjectDir.get(projectDir) ?? [];
  }

  setSelectedSessionFile(tabSessionId: string, filePath: string | null): void {
    if (filePath === null) this.state.selectedSessionFileByTab.delete(tabSessionId);
    else this.state.selectedSessionFileByTab.set(tabSessionId, filePath);
    // Reset turn detail + expansions + rule viewers when switching session.
    this.state.selectedTurnIndexByTab.delete(tabSessionId);
    this.state.expandedTurnsByTab.delete(tabSessionId);
    this.state.viewingRuleFileByTab.delete(tabSessionId);
    this.bus.emit('state:selected-session-change', tabSessionId);
  }

  getSelectedSessionFile(tabSessionId: string): string | null {
    return this.state.selectedSessionFileByTab.get(tabSessionId) ?? null;
  }

  setSelectedTurnIndex(tabSessionId: string, index: number | null): void {
    if (index === null) this.state.selectedTurnIndexByTab.delete(tabSessionId);
    else this.state.selectedTurnIndexByTab.set(tabSessionId, index);
    this.bus.emit('state:selected-turn-change', tabSessionId);
  }

  getSelectedTurnIndex(tabSessionId: string): number | null {
    return this.state.selectedTurnIndexByTab.get(tabSessionId) ?? null;
  }

  toggleExpandedTurn(tabSessionId: string, turnIndex: number): void {
    let set = this.state.expandedTurnsByTab.get(tabSessionId);
    if (!set) {
      set = new Set();
      this.state.expandedTurnsByTab.set(tabSessionId, set);
    }
    if (set.has(turnIndex)) set.delete(turnIndex);
    else set.add(turnIndex);
    this.bus.emit('state:expanded-turns-change', tabSessionId);
  }

  getExpandedTurns(tabSessionId: string): Set<number> {
    return this.state.expandedTurnsByTab.get(tabSessionId) ?? new Set();
  }

  clearExpandedTurns(tabSessionId: string): void {
    if (this.state.expandedTurnsByTab.delete(tabSessionId)) {
      this.bus.emit('state:expanded-turns-change', tabSessionId);
    }
  }

  /** Toggle rule-file viewer for (tab, turn). Passing same file closes it. */
  toggleRuleFileView(tabSessionId: string, turnIndex: number, filePath: string): void {
    let per = this.state.viewingRuleFileByTab.get(tabSessionId);
    if (!per) {
      per = new Map();
      this.state.viewingRuleFileByTab.set(tabSessionId, per);
    }
    if (per.get(turnIndex) === filePath) per.delete(turnIndex);
    else per.set(turnIndex, filePath);
    this.bus.emit('state:viewing-rule-change', tabSessionId);
  }

  getViewingRuleFile(tabSessionId: string, turnIndex: number): string | null {
    return this.state.viewingRuleFileByTab.get(tabSessionId)?.get(turnIndex) ?? null;
  }

  getAllViewingRules(tabSessionId: string): Map<number, string> {
    return this.state.viewingRuleFileByTab.get(tabSessionId) ?? new Map();
  }

  /** Request jump-to-block in the call-details tab for a given turn. */
  requestGoto(tabSessionId: string, blockId: string): void {
    this.state.gotoCounter += 1;
    this.state.gotoByTab.set(tabSessionId, { nonce: this.state.gotoCounter, blockId });
    this.bus.emit('state:goto-change', tabSessionId);
  }

  getGoto(tabSessionId: string): { nonce: number; blockId: string } | null {
    return this.state.gotoByTab.get(tabSessionId) ?? null;
  }
}
