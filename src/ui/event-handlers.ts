import type { PermissionMode } from '../data/types';
import { setDriveMode, cycleDriveMode, type DriveModeDeps } from '../actions/drive-mode';
import { rewindTo, type RewindDeps } from '../actions/rewind';
import { applyPreset, type PresetApplyDeps } from '../actions/preset-apply';
import { injectLaunchCommand } from '../actions/launch';
import type { PtyInjector } from '../actions/pty-inject';
import type { Store } from '../core/state';
import type { PresetStore } from '../actions/preset-store';
import type { Preset } from '../actions/preset-types';
import { t, fmt } from '../i18n';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { v4: uuidv4 } = require('uuid') as { v4: () => string };

/** Shared create/edit flow. `existing` means "edit existing preset". */
async function presetEditorFlow(deps: HandlersDeps, existing?: Preset): Promise<void> {
  const isEdit = !!existing;
  const L = t();
  const result = await deps.showForm({
    title: isEdit ? fmt(L.editPresetTitle, { name: existing!.name }) : L.createPresetTitle,
    description: L.presetFormDescription,
    fields: [
      {
        id: 'name',
        label: L.presetFieldName,
        placeholder: L.presetFieldNamePlaceholder,
        required: true,
        value: existing?.name,
      },
      {
        id: 'apiKey',
        label: L.presetFieldApiKey,
        type: 'password',
        placeholder: L.presetFieldApiKeyPlaceholder,
        value: existing?.apiKey,
      },
      {
        id: 'authToken',
        label: L.presetFieldAuthToken,
        type: 'password',
        placeholder: L.presetFieldAuthTokenPlaceholder,
        value: existing?.authToken,
      },
      {
        id: 'baseUrl',
        label: L.presetFieldBaseUrl,
        placeholder: L.presetFieldBaseUrlPlaceholder,
        value: existing?.baseUrl,
      },
      {
        id: 'model',
        label: L.presetFieldModel,
        placeholder: L.presetFieldModelPlaceholder,
        value: existing?.model,
      },
    ],
    submitText: L.save,
  });
  if (!result) return;

  const { name, apiKey, authToken, baseUrl, model } = result;

  const preset: Preset = {
    id: existing?.id ?? uuidv4(),
    name: name.trim(),
    apiKey: apiKey?.trim() || undefined,
    authToken: authToken?.trim() || undefined,
    baseUrl: baseUrl?.trim() || undefined,
    model: model?.trim() || undefined,
    // Preserve these fields when editing — flow doesn't expose them yet.
    maxTokens: existing?.maxTokens,
    extraEnv: existing?.extraEnv,
  };
  await deps.presetStore.upsert(preset);
  // If the edited preset is the active one, update active.env immediately.
  const currentActive = deps.presetStore.getActive();
  if (!isEdit || currentActive?.id === preset.id) {
    await deps.presetStore.setActive(preset.id);
    await deps.presetStore.writeActiveEnv(preset);
    deps.store.setActivePresetId(preset.id);
  }
  deps.store.setStage('Ready');
  deps.onPresetChanged();
  deps.showNotification(
    fmt(isEdit ? t().presetUpdated : t().presetCreated, { name: preset.name }),
    'success',
  );
}

async function createPresetFlow(deps: HandlersDeps): Promise<void> {
  return presetEditorFlow(deps);
}

async function editActivePresetFlow(deps: HandlersDeps): Promise<void> {
  const active = deps.presetStore.getActive();
  if (!active) {
    deps.showNotification(t().noActivePresetSelected, 'warning');
    return;
  }
  return presetEditorFlow(deps, active);
}

export interface PanelEvent {
  panelId: string;
  sectionId: string;
  eventId: string;
  payload?: unknown;
}

export interface HandlersDeps {
  store: Store;
  injector: PtyInjector;
  presetStore: PresetStore;
  driveDeps: Omit<DriveModeDeps, 'store' | 'injector' | 'currentMode'>;
  getCurrentPermissionMode: () => PermissionMode;
  rewindDeps: Omit<RewindDeps, 'injector'>;
  presetApplyDeps: Omit<PresetApplyDeps, 'store' | 'injector' | 'presetStore'>;
  getCurrentTurnCount: () => number;
  showNotification: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  showInputBox: (options: { title?: string; placeholder?: string; value?: string; password?: boolean }) => Promise<string | undefined>;
  showForm: (options: {
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
    }>;
    submitText?: string;
    cancelText?: string;
  }) => Promise<Record<string, string> | undefined>;
  terminalNotFoundMessage: string;
  onPresetChanged: () => void;
  /** Resolve the absolute file path for a given tool call in a turn (file-ops only). */
  getToolFilePath: (turnIndex: number, toolIndex: number) => string | null;
  /** Read file + open a modal viewer. */
  openRuleFileModal: (filePath: string) => Promise<void>;
  /** Return the msg-viewer block id (e.g. "user-<uuid>") for a given turn index. */
  getUserBlockIdForTurn: (turnIndex: number) => string | null;
}

/**
 * Route a panel onEvent callback to the right action.
 *
 * Known events:
 *   - 'field-change' on section 'drive' / 'preset'
 *   - 'launchClaude' on header
 *   - 'undo' on list item (sectionId='history')
 */
export async function handlePanelEvent(
  e: PanelEvent,
  deps: HandlersDeps,
): Promise<void> {
  const { sectionId, eventId, payload } = e;

  // ─────────────────────────────────────────────────────────────
  // Events fired from inside a `tabs` section arrive with sectionId='tabs'
  // (upstream TabsTemplate forwards its own onEvent unchanged). Route these
  // by eventId alone — they are unique within our panel.
  // ─────────────────────────────────────────────────────────────

  // Turn-header chevron clicked → toggle expansion.
  if (eventId === 'toggleExpand') {
    const p = payload as { itemId?: string } | undefined;
    const target = p?.itemId ? Number(p.itemId) : NaN;
    if (!Number.isFinite(target) || target <= 0) return;
    const sid = deps.store.getState().activeTabSessionId;
    if (!sid) return;
    deps.store.toggleExpandedTurn(sid, target);
    deps.onPresetChanged();
    return;
  }

  // Tool row clicked → open file content modal (file-ops only).
  if (eventId === 'list:select') {
    const p = payload as { id?: string } | undefined;
    if (!p?.id) return;
    const toolMatch = p.id.match(/^(\d+)-tool-(\d+)$/);
    if (toolMatch) {
      const turnIdx = Number(toolMatch[1]);
      const toolIdx = Number(toolMatch[2]);
      const filePath = deps.getToolFilePath(turnIdx, toolIdx);
      if (filePath) await deps.openRuleFileModal(filePath);
      return;
    }
    return;
  }

  if (eventId === 'undo') {
    const p = payload as { itemId?: string } | undefined;
    const target = p?.itemId ? Number(p.itemId) : NaN;
    if (!Number.isFinite(target) || target <= 0) return;
    await triggerRewind(target, deps);
    return;
  }

  // "Goto" arrow on a turn header → jump to call-details tab and scroll to
  // the matching user-prompt block.
  if (eventId === 'gotoTurn') {
    const p = payload as { itemId?: string } | undefined;
    const target = p?.itemId ? Number(p.itemId) : NaN;
    if (!Number.isFinite(target) || target <= 0) return;
    const sid = deps.store.getState().activeTabSessionId;
    if (!sid) return;
    const blockId = deps.getUserBlockIdForTurn(target);
    if (!blockId) return;
    deps.store.requestGoto(sid, blockId);
    deps.onPresetChanged();
    return;
  }

  // ─────────────────────────────────────────────────────────────
  // Top-level sections (sectionId is reliable because they are not
  // nested inside another template).
  // ─────────────────────────────────────────────────────────────

  // Combined compact controls form — route by field id.
  if (eventId === 'field-change' || eventId === 'form:change') {
    const p = payload as { id?: string; fieldId?: string; value?: string } | undefined;
    const fieldId = p?.id ?? p?.fieldId;
    const sid = deps.store.getState().activeTabSessionId;
    if (!sid || !fieldId) return;

    if (fieldId === 'driveMode' && p?.value) {
      const mode = p.value as PermissionMode;
      // Idempotency: some form templates emit both 'field-change' and
      // 'form:change' for the same user action. Reading the current mode
      // *after* the first call picks up the just-set pending mode, so the
      // second call computes steps=0 and no-ops.
      const currentMode = deps.getCurrentPermissionMode();
      if (currentMode === mode) return;
      await setDriveMode(sid, mode, {
        store: deps.store,
        injector: deps.injector,
        currentMode,
        ...deps.driveDeps,
      });
      return;
    }
    if (fieldId === 'session') {
      deps.store.setSelectedSessionFile(sid, p?.value || null);
      deps.onPresetChanged();
      return;
    }
    if (fieldId === 'preset' && p?.value) {
      await applyPreset(p.value, {
        store: deps.store,
        injector: deps.injector,
        presetStore: deps.presetStore,
        ...deps.presetApplyDeps,
      });
      return;
    }
  }

  if (sectionId === 'header' && eventId === 'launchClaude') {
    const sid = deps.store.getState().activeTabSessionId;
    if (!sid) {
      deps.showNotification(deps.terminalNotFoundMessage, 'warning');
      return;
    }
    await injectLaunchCommand(sid, deps.presetStore.activeEnvPath(), deps.injector);
    return;
  }

  if (eventId === 'createPreset') {
    await createPresetFlow(deps);
    return;
  }
  if (eventId === 'editPreset') {
    await editActivePresetFlow(deps);
    return;
  }

  if (eventId === 'cycleDriveMode') {
    const sid = deps.store.getState().activeTabSessionId;
    if (!sid) {
      deps.showNotification(deps.terminalNotFoundMessage, 'warning');
      return;
    }
    await cycleDriveMode(sid, {
      store: deps.store,
      injector: deps.injector,
      currentMode: deps.getCurrentPermissionMode(),
      ...deps.driveDeps,
    });
    return;
  }
}

async function triggerRewind(targetTurn: number, deps: HandlersDeps): Promise<void> {
  const sid = deps.store.getState().activeTabSessionId;
  if (!sid) {
    deps.showNotification(deps.terminalNotFoundMessage, 'warning');
    return;
  }
  const current = deps.getCurrentTurnCount();
  await rewindTo(sid, current, targetTurn, {
    injector: deps.injector,
    ...deps.rewindDeps,
  });
}
