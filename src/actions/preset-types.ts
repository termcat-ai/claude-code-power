export interface Preset {
  id: string;
  name: string;
  /** ANTHROPIC_API_KEY. Either this, or `authToken`, or both may be set. */
  apiKey?: string;
  /** ANTHROPIC_AUTH_TOKEN. */
  authToken?: string;
  /** ANTHROPIC_BASE_URL. */
  baseUrl?: string;
  /** Model id exported as ANTHROPIC_MODEL (and usable by `/model` slash). Optional. */
  model?: string;
  maxTokens?: number;
  extraEnv?: Record<string, string>;
}

export interface PresetsFile {
  version: 1;
  activePresetId: string | null;
  presets: Preset[];
}

export function emptyPresetsFile(): PresetsFile {
  return { version: 1, activePresetId: null, presets: [] };
}

/** Mask a secret for display/logging. */
export function maskSecret(value: string | undefined): string {
  if (!value) return '';
  if (value.length <= 10) return '***';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

/**
 * Migrate an older Preset that used `authType` + `authValue` into the new
 * split-fields shape. No-op for already-new records.
 */
export function migratePreset(raw: unknown): Preset {
  const r = raw as Record<string, unknown>;
  const base: Preset = {
    id: String(r.id ?? ''),
    name: String(r.name ?? ''),
    model: typeof r.model === 'string' && r.model ? r.model : undefined,
    apiKey: typeof r.apiKey === 'string' ? r.apiKey : undefined,
    authToken: typeof r.authToken === 'string' ? r.authToken : undefined,
    baseUrl: typeof r.baseUrl === 'string' ? r.baseUrl : undefined,
    maxTokens: typeof r.maxTokens === 'number' ? r.maxTokens : undefined,
    extraEnv: r.extraEnv && typeof r.extraEnv === 'object' ? (r.extraEnv as Record<string, string>) : undefined,
  };
  // Legacy: authType + authValue
  if (!base.apiKey && !base.authToken && typeof r.authValue === 'string' && r.authValue) {
    if (r.authType === 'auth_token') base.authToken = r.authValue;
    else base.apiKey = r.authValue;
  }
  return base;
}

/** Single display token summarizing which auth field(s) are set. */
export function authSummary(preset: Preset): string {
  const parts: string[] = [];
  if (preset.apiKey) parts.push(maskSecret(preset.apiKey));
  if (preset.authToken) parts.push(`token:${maskSecret(preset.authToken)}`);
  return parts.length ? parts.join(' + ') : '(no auth)';
}
