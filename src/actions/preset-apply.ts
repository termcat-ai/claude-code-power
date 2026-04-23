import type { Store } from '../core/state';
import type { PtyInjector } from './pty-inject';
import type { PresetStore } from './preset-store';
import type { Preset } from './preset-types';
import { SLASH } from './commands';

export interface PresetDiff {
  restartRequired: boolean;
  onlyModelChanged: boolean;
}

const RESTART_FIELDS: Array<keyof Preset> = ['apiKey', 'authToken', 'baseUrl', 'maxTokens', 'extraEnv'];

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function diffPreset(current: Preset | null, target: Preset): PresetDiff {
  if (!current) return { restartRequired: true, onlyModelChanged: false };
  const restartRequired = RESTART_FIELDS.some((f) => !deepEqual(current[f], target[f]));
  const modelChanged = current.model !== target.model;
  return { restartRequired, onlyModelChanged: modelChanged && !restartRequired };
}

export interface PresetApplyDeps {
  store: Store;
  injector: PtyInjector;
  presetStore: PresetStore;
  showNotification: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  showConfirm: (message: string) => Promise<boolean>;
  messageNextLaunch: (name: string) => string;
  messageRestartPrompt: string;
}

export async function applyPreset(presetId: string, deps: PresetApplyDeps): Promise<void> {
  const target = deps.presetStore.get(presetId);
  if (!target) return;

  const current = deps.presetStore.getActive();
  await deps.presetStore.setActive(target.id);
  await deps.presetStore.writeActiveEnv(target);
  deps.store.setActivePresetId(target.id);

  const activeSid = deps.store.getState().activeTabSessionId;
  const tab = activeSid ? deps.store.getState().perTabStates.get(activeSid) : null;
  const running = tab && (tab.status === 'active' || tab.status === 'active-idle');
  if (!activeSid || !running) {
    deps.showNotification(deps.messageNextLaunch(target.name), 'success');
    return;
  }

  const diff = diffPreset(current, target);
  if (diff.onlyModelChanged) {
    // Empty model → fall through to full restart path so the user gets an
    // explicit choice rather than a silent `/model ` with no argument.
    if (target.model) {
      await deps.injector.fillLine(activeSid, `${SLASH.MODEL} ${target.model}`);
      return;
    }
  }
  if (diff.restartRequired) {
    const confirmed = await deps.showConfirm(deps.messageRestartPrompt);
    if (!confirmed) return;
    await deps.injector.fillLine(activeSid, SLASH.EXIT);
  }
}
