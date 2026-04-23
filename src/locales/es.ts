import type { LocaleKeys } from './zh';

export const es: LocaleKeys = {
  // Panel chrome
  panelTitle: 'Claude Code Power',

  // State banners
  noClaudeDetected: 'Claude Code no detectado',
  noClaudeDetectedHint: 'Ejecuta `claude` en la terminal actual para iniciar una sesión',
  orText: '—— o ——',
  launchClaudeButton: '▶ Iniciar Claude',
  sessionEndedBanner: 'Sesión terminada — mostrando el contenido de la última sesión',
  claudeNotInstalled: 'Claude Code no está instalado',
  claudeNotInstalledHint: 'Visita https://code.claude.com para instalar la CLI primero',
  noPresetTitle: 'Aún no hay ningún preset configurado',
  noPresetHint: 'Haz clic en el botón de abajo para crear tu primera configuración de modelo',
  createPresetButton: 'Crear Preset',
  claudeDataPermissionError: 'No se puede acceder al directorio de datos de Claude Code (~/.claude)',
  retry: 'Reintentar',

  // Drive mode
  driveModeLabel: 'Modo Drive',
  driveMode_default: 'Default · Preguntar antes de cada edición',
  driveMode_acceptEdits: 'Accept Edits · Edición automática',
  driveMode_plan: 'Plan · Solo investigar, sin cambios',
  driveMode_auto: 'Auto · Claude decide',
  driveMode_bypassPermissions: 'Bypass · Omitir todos los permisos (requiere flag al iniciar)',
  cycleDriveModeTooltip: 'Cambiar al siguiente modo (equivalente a Shift+Tab)',
  driveSyncSourceSession: 'sesión',
  driveSyncSourceDefault: 'predeterminado',
  driveLampSynced: 'Sincronizado',
  driveLampPending: 'Pendiente — presiona Enter en la terminal',
  driveLampWarning: 'No aplicado — ejecuta manualmente',
  confirmWriteDefaultMode: '¿Cambiar el modo predeterminado a «{mode}»? Esto se escribirá en ~/.claude/settings.json.',
  cannotEnterBypass: 'bypassPermissions no se puede cambiar desde el teclado. Sal de claude y reinícialo con `--dangerously-skip-permissions`',
  cannotLeaveBypass: 'Actualmente en modo bypassPermissions — no se puede salir desde el teclado. Por favor sal de claude y reinícialo',
  cannotCycleBypass: 'Actualmente en modo bypassPermissions — no se puede ciclar desde el teclado. Por favor sal de claude y reinícialo',
  unknownMode: 'Modo desconocido: {mode}',
  unknownModePair: 'Modo desconocido: {from} / {to}',
  writeSettingsFailed: 'Error al escribir settings: {err}',

  // Session selector
  sessionLabel: 'Sesión',

  // Preset
  presetLabel: 'Preset',
  manageButton: 'Administrar',
  editPresetTooltip: 'Editar preset actual',
  presetActivatedNextLaunch: 'Activado «{name}» — surte efecto en el próximo inicio de claude',
  confirmRestartForPreset: 'Este preset cambia la autenticación o el endpoint y requiere reiniciar claude. Se inyectará `exit` en el campo de entrada (sin enviar); presiona Enter para salir de la sesión actual y reinicia con el nuevo preset.',
  editPresetTitle: 'Editar Preset: {name}',
  createPresetTitle: 'Crear Preset',
  presetFormDescription: 'Rellena las variables de entorno necesarias para iniciar Claude Code. Todos los campos excepto el nombre son opcionales.',
  presetFieldName: 'Nombre del Preset',
  presetFieldNamePlaceholder: 'ej. Anthropic Oficial / Proxy Corporativo / Claude Pro',
  presetFieldApiKey: 'ANTHROPIC_API_KEY (opcional)',
  presetFieldApiKeyPlaceholder: 'sk-ant-... · dejar vacío para omitir',
  presetFieldAuthToken: 'ANTHROPIC_AUTH_TOKEN (opcional)',
  presetFieldAuthTokenPlaceholder: 'OAuth token · dejar vacío para omitir',
  presetFieldBaseUrl: 'ANTHROPIC_BASE_URL (opcional)',
  presetFieldBaseUrlPlaceholder: 'https://api.anthropic.com · dejar vacío para usar el predeterminado',
  presetFieldModel: 'Modelo (opcional)',
  presetFieldModelPlaceholder: 'sonnet / opus / haiku / claude-sonnet-4-5 · dejar vacío para el predeterminado de Claude',
  save: 'Guardar',
  presetUpdated: 'Preset «{name}» actualizado',
  presetCreated: 'Preset «{name}» creado',
  noActivePresetSelected: 'No hay ningún preset seleccionado',

  // History tab
  tabHistory: 'Historial',
  tabCallDetails: 'Detalles de llamadas',
  emptyHistory: 'Aún no hay historial — tu primer prompt aparecerá aquí',
  undoButtonTooltip: 'Retroceder a este turno',
  confirmRewind: 'Mantener hasta el turno #{target}, descartando los siguientes {n} prompts y sus resultados de herramientas. La recuperación de archivos la maneja el mecanismo de checkpoint de Claude Code — este plugin no participa.',
  rewindManualHint: 'Continúa el rewind en claude {n} vez/veces más',
  toolCountSummary: '{count} llamada(s) a herramienta',
  expandTooltip: 'Expandir',
  gotoTurnTooltip: 'Ir a los detalles de la llamada y enfocar este prompt',

  // Call details
  contextSectionTitle: 'Contexto cargado',
  badgeSkill: 'Skill',
  badgeMcp: 'MCP',
  badgeAgent: 'Agent',
  clickToViewFileContent: 'Haz clic para ver el contenido del archivo',

  // Turn detail panel
  detailBackButton: '← Volver a la lista',
  detailUndoButton: 'Retroceder antes de este turno',
  detailUndoDisabled: 'Rewind solo disponible para la sesión en ejecución',
  detailPromptLabel: 'Prompt',
  detailStatsLabel: 'Estadísticas',
  detailStatsTool: 'Llamadas a herramientas',
  detailStatsSkill: 'Skill',
  detailStatsMcp: 'MCP',
  detailStatsTask: 'Sub-agent',
  detailStatsRule: 'Archivos de reglas',
  detailSkillsTitle: 'Skills invocadas',
  detailMcpsTitle: 'MCPs invocados',
  detailRulesTitle: 'Archivos de reglas / contexto cargados',
  detailToolsTitle: 'Todas las llamadas a herramientas',
  detailEmpty: '—',

  // Notifications
  terminalNotFound: 'Terminal no encontrada — cambia a la pestaña que ejecuta claude',
  presetTestOk: 'Prueba de conexión exitosa',
  presetTestFailed: 'Prueba de conexión fallida: {reason}',
  undoCompleted: 'Rewind completado',

  // Generic
  cancel: 'Cancelar',
  confirm: 'Confirmar',
};
