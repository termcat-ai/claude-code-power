import type { PermissionMode, PromptTurn, PromptTurnStats, ToolUse } from '../data/types';
import { extractToolFilePath, isFileTool, isFileReadTool, isFileWriteTool } from '../data/types';
import type { AppState, PerTabState, SessionMeta } from '../core/types';
import type { Preset } from '../actions/preset-types';
import { authSummary } from '../actions/preset-types';
import { turnsToMsgBlocks } from './msg-block-adapter';
import { type Locale } from '../locales';

export type SectionDescriptor = {
  id?: string;
  template: string;
  data: unknown;
  collapsible?: boolean;
  collapsed?: boolean;
  variant?: 'default' | 'compact' | 'card' | 'nested';
  fill?: boolean;
};

export interface LayoutInput {
  state: AppState;
  t: Locale;
  activeTab: PerTabState | null;
  sessions: SessionMeta[];
  selectedSessionFile: string | null;
  liveSessionFile: string | null;
  turns: PromptTurn[];
  turnsStats: PromptTurnStats[];
  /** Set of turn indices the user has expanded. */
  expandedTurns: Set<number>;
  /** Pending "goto turn" request — triggers tab switch + msg-viewer scroll. */
  goto: { nonce: number; blockId: string } | null;
  driveModeEffective: PermissionMode | null;
  driveSource: 'session' | 'default';
  presets: Preset[];
  activePresetId: string | null;
  claudeInstalled: boolean;
}

// Label lookup for a PermissionMode. `bypassPermissions` is included so the
// panel can render a sensible label when claude happens to be in that mode
// (entered via `--dangerously-skip-permissions`), but it is never a cycle
// target — the cycle button rotates default → acceptEdits → plan → auto.
function driveModeLabel(mode: PermissionMode, t: Locale): string {
  switch (mode) {
    case 'default': return t.driveMode_default;
    case 'acceptEdits': return t.driveMode_acceptEdits;
    case 'plan': return t.driveMode_plan;
    case 'auto': return t.driveMode_auto;
    case 'bypassPermissions': return t.driveMode_bypassPermissions;
  }
}

function headerSection(input: LayoutInput): SectionDescriptor {
  const { t, activeTab } = input;
  // Keep only a short basename of cwd to avoid wrapping the title.
  const cwd = activeTab?.detectedCwd ?? '';
  const cwdShort = cwd ? cwd.split('/').filter(Boolean).slice(-2).join('/') : '';
  const badgeByStatus: Record<string, { text: string; color: string }> = {
    idle: { text: '·', color: 'muted' },
    active: { text: '●', color: 'success' },
    'active-idle': { text: '○', color: 'warning' },
    stale: { text: '~', color: 'warning' },
  };
  const badge = activeTab ? badgeByStatus[activeTab.status] : undefined;
  return {
    id: 'header',
    template: 'header',
    data: {
      title: t.panelTitle,
      subtitle: cwdShort,
      icon: 'sparkles',
      badge,
      actions: [
        { id: 'launchClaude', icon: 'play', tooltip: t.launchClaudeButton },
      ],
    },
  };
}

function formatSessionLabel(s: SessionMeta): string {
  const dt = new Date(s.mtimeMs);
  const time = `${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
  const preview = s.firstPromptPreview ? ` · ${s.firstPromptPreview.slice(0, 30)}` : '';
  const count = s.promptCount > 0 ? ` (${s.promptCount})` : '';
  return `${time}${preview}${count}`;
}

/**
 * Unified compact form: Preset / Drive / Session rows, all left-aligned on
 * the `w-14` label column.
 *
 * Drive is rendered as a `text` field with `disabled: true` — form templates
 * don't have a read-only display type, and using disabled text gives us a
 * non-editable row that visually aligns with the adjacent selects. The cycle
 * button lives in the row's trailing actions, not in the label, so it
 * stays visually separated from the mode text.
 */
function compactControlsSection(input: LayoutInput): SectionDescriptor {
  const { t, sessions, selectedSessionFile, liveSessionFile, state, activeTab, driveModeEffective, presets, activePresetId } = input;

  const sessionEffective = selectedSessionFile ?? liveSessionFile ?? sessions[0]?.filePath ?? '';
  const sessionOptions = sessions.length
    ? sessions.map((s) => ({
        label: s.filePath === liveSessionFile ? `● ${formatSessionLabel(s)}` : formatSessionLabel(s),
        value: s.filePath,
      }))
    : [{ label: '—', value: '' }];

  const pending = activeTab ? state.pendingDrive.get(activeTab.sessionId) : null;
  const driveValue: PermissionMode = pending?.mode ?? driveModeEffective ?? 'default';

  const presetOptions = presets.map((p) => ({
    label: p.model
      ? `${p.name} · ${p.model}  (${authSummary(p)})`
      : `${p.name}  (${authSummary(p)})`,
    value: p.id,
  }));
  if (!presetOptions.length) presetOptions.push({ label: t.noPresetTitle, value: '' });

  return {
    id: 'controls',
    template: 'form',
    variant: 'compact',
    data: {
      fields: [
        {
          id: 'preset',
          type: 'select',
          label: t.presetLabel,
          value: activePresetId ?? '',
          options: presetOptions,
          trailingActions: activePresetId
            ? [
                { id: 'editPreset', icon: 'settings', tooltip: t.editPresetTooltip },
                { id: 'createPreset', icon: 'plus', tooltip: t.createPresetButton },
              ]
            : [{ id: 'createPreset', icon: 'plus', tooltip: t.createPresetButton }],
        },
        {
          id: 'driveMode',
          type: 'text',
          label: t.driveModeLabel,
          value: driveModeLabel(driveValue, t),
          disabled: true,
          trailingActions: [
            {
              id: 'cycleDriveMode',
              icon: 'refresh-cw',
              tooltip: t.cycleDriveModeTooltip,
            },
          ],
        },
        {
          id: 'session',
          type: 'select',
          label: t.sessionLabel,
          value: sessionEffective,
          options: sessionOptions,
        },
      ],
    },
  };
}

/**
 * Build stats as real lucide-icon badges matching the expanded sub-list icons.
 * Reads use file-text in info/cyan; writes use file-pen in success/green to
 * distinguish at a glance without being as loud as a danger/red.
 */
function statsInlineBadges(
  stats: PromptTurnStats,
  fileReadCount: number,
  fileWriteCount: number,
): Array<{ icon: string; text: string; color: string }> {
  const out: Array<{ icon: string; text: string; color: string }> = [];
  if (stats.totalToolUses > 0) out.push({ icon: 'wrench', text: String(stats.totalToolUses), color: 'muted' });
  if (fileReadCount > 0) out.push({ icon: 'file-text', text: String(fileReadCount), color: 'info' });
  if (fileWriteCount > 0) out.push({ icon: 'file-pen', text: String(fileWriteCount), color: 'success' });
  if (stats.skills.length > 0) out.push({ icon: 'sparkles', text: String(stats.skills.length), color: 'primary' });
  if (stats.mcpServers.length > 0) out.push({ icon: 'plug', text: String(stats.mcpServers.length), color: 'warning' });
  if (stats.taskCount > 0) out.push({ icon: 'bot', text: String(stats.taskCount), color: 'muted' });
  return out;
}

/**
 * Dump the tool_use input object as a short multi-line string (up to ~600
 * chars) — used as a hover tooltip so users can read truncated paths / full
 * commands / full MCP args.
 */
function fullInputPreview(input: unknown): string {
  if (!input) return '';
  if (typeof input === 'string') return input.length > 600 ? input.slice(0, 597) + '...' : input;
  if (typeof input !== 'object') return String(input);
  try {
    const lines: string[] = [];
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      const val = typeof v === 'string' ? v : JSON.stringify(v);
      lines.push(`${k}: ${val}`);
    }
    const joined = lines.join('\n');
    return joined.length > 600 ? joined.slice(0, 597) + '...' : joined;
  } catch {
    return '';
  }
}

function summarizeToolUse(tu: ToolUse): string {
  // Extract a short, readable hint for the tool call.
  const input = tu.input && typeof tu.input === 'object' ? (tu.input as Record<string, unknown>) : null;
  const pick = (k: string) => (input && typeof input[k] === 'string' ? (input[k] as string) : null);
  const hint =
    pick('file_path') ||
    pick('path') ||
    pick('pattern') ||
    pick('command') ||
    pick('query') ||
    pick('prompt') ||
    pick('description') ||
    pick('url') ||
    '';
  const short = hint.length > 80 ? hint.slice(0, 77) + '...' : hint;
  return short ? `${tu.name}: ${short}` : tu.name;
}

function buildItemTooltip(turn: PromptTurn, stats: PromptTurnStats, t: Locale): string | undefined {
  const lines: string[] = [];

  // Skills
  lines.push(`${t.detailSkillsTitle} (${stats.skills.length}):`);
  if (stats.skills.length) {
    for (const s of stats.skills) lines.push(`  · ${s}`);
  } else {
    lines.push(`  ${t.detailEmpty}`);
  }
  lines.push('');

  // MCP
  lines.push(`${t.detailMcpsTitle} (${stats.mcpServers.length}):`);
  if (stats.mcpServers.length) {
    for (const m of stats.mcpServers) lines.push(`  · ${m}`);
  } else {
    lines.push(`  ${t.detailEmpty}`);
  }
  lines.push('');

  // Rule files
  lines.push(`${t.detailRulesTitle} (${stats.ruleFiles.length}):`);
  if (stats.ruleFiles.length) {
    for (const f of stats.ruleFiles) lines.push(`  · ${f}`);
  } else {
    lines.push(`  ${t.detailEmpty}`);
  }
  lines.push('');

  // Full tool list
  const allTools = turn.assistantEvents.flatMap((a) => a.toolUses);
  lines.push(`${t.detailToolsTitle} (${allTools.length}):`);
  if (allTools.length) {
    const MAX = 30;
    for (let i = 0; i < Math.min(allTools.length, MAX); i++) {
      const tu = allTools[i];
      const marker = tu.isError ? '✕' : '·';
      lines.push(`  ${marker} ${summarizeToolUse(tu)}`);
    }
    if (allTools.length > MAX) {
      lines.push(`  ... (${allTools.length - MAX} more)`);
    }
  } else {
    lines.push(`  ${t.detailEmpty}`);
  }

  return lines.join('\n');
}

/** Single-turn header (clickable to toggle expansion) + its inline detail sections. */
function turnSections(
  turn: PromptTurn,
  stats: PromptTurnStats,
  expanded: boolean,
  canUndo: boolean,
  t: Locale,
): SectionDescriptor[] {
  const preview = turn.userEvent.text.replace(/\n+/g, ' ').slice(0, 140);
  const fullPrompt = turn.userEvent.text.length > 1000
    ? turn.userEvent.text.slice(0, 997) + '...'
    : turn.userEvent.text;
  const fileReadCount = turn.assistantEvents.reduce(
    (acc, a) => acc + a.toolUses.filter(isFileReadTool).length,
    0,
  );
  const fileWriteCount = turn.assistantEvents.reduce(
    (acc, a) => acc + a.toolUses.filter(isFileWriteTool).length,
    0,
  );
  const header: SectionDescriptor = {
    id: `turn-${turn.index}`,
    template: 'list',
    data: {
      items: [
        {
          id: String(turn.index),
          label: `#${turn.index}  ${preview || '(empty prompt)'}`,
          inlineBadges: statsInlineBadges(stats, fileReadCount, fileWriteCount),
          tooltip: fullPrompt,
          leadingAction: {
            id: 'toggleExpand',
            icon: expanded ? 'chevron-down' : 'chevron-right',
            tooltip: expanded ? t.detailBackButton : t.expandTooltip,
          },
          actions: (() => {
            const acts: Array<{ id: string; icon: string; tooltip: string }> = [
              { id: 'gotoTurn', icon: 'arrow-right', tooltip: t.gotoTurnTooltip },
            ];
            if (canUndo) acts.push({ id: 'undo', icon: 'rotate-ccw', tooltip: t.undoButtonTooltip });
            return acts;
          })(),
        },
      ],
      selectable: false,
      itemHeight: 52,
    },
  };
  if (!expanded) return [header];

  const out: SectionDescriptor[] = [header];

  // Skills — show name + title/description + source badge; tooltip has full info.
  if (stats.skillInfos.length) {
    out.push({
      id: `turn-${turn.index}-skills`,
      template: 'list',
      variant: 'nested',
      data: {
        items: stats.skillInfos.map((info, i) => {
          const label = info.title ? `${info.name} · ${info.title}` : info.name;
          const description = info.description || info.baseDir || '';
          const tooltipLines = [info.name];
          if (info.title) tooltipLines.push(info.title);
          if (info.description) tooltipLines.push('', info.description);
          if (info.baseDir) tooltipLines.push('', info.baseDir);
          return {
            id: `${turn.index}-skill-${i}`,
            label,
            description,
            icon: 'sparkles',
            color: 'primary',
            badge:
              info.source === 'slash'
                ? { text: '/cmd', color: 'info' }
                : { text: 'tool', color: 'primary' },
            tooltip: tooltipLines.join('\n'),
          };
        }),
      },
    });
  }

  // MCPs
  if (stats.mcpServers.length) {
    out.push({
      id: `turn-${turn.index}-mcps`,
      template: 'list',
      variant: 'nested',
      data: {
        items: stats.mcpServers.map((s, i) => ({
          id: `${turn.index}-mcp-${i}`,
          label: s,
          icon: 'plug',
          color: 'warning',
          tooltip: s,
        })),
      },
    });
  }

  // Full tool list — file-ops use a file icon and are clickable (opens content
  // in a modal). Selectable; click handler in extension routes by item id.
  const allTools = turn.assistantEvents.flatMap((a) => a.toolUses);
  if (allTools.length) {
    out.push({
      id: `turn-${turn.index}-tools`,
      template: 'list',
      variant: 'nested',
      data: {
        items: allTools.map((tu, i) => {
          const summary = summarizeToolUse(tu);
          const filePath = extractToolFilePath(tu);
          const openable = isFileTool(tu) && !!filePath;
          const isWrite = isFileWriteTool(tu);
          const fullInput = fullInputPreview(tu.input);
          const tooltipParts = [
            `${tu.name}${tu.kind !== 'builtin' ? ` · ${tu.kind}` : ''}`,
            summary,
          ];
          if (openable) tooltipParts.push('', t.clickToViewFileContent);
          if (fullInput) tooltipParts.push('', fullInput);
          return {
            id: `${turn.index}-tool-${i}`,
            label: tu.name,
            description: summary,
            icon: isWrite
              ? 'file-pen'
              : openable
              ? 'file-text'
              : tu.kind === 'skill'
              ? 'sparkles'
              : tu.kind === 'mcp'
              ? 'plug'
              : tu.kind === 'task'
              ? 'bot'
              : 'wrench',
            color: tu.isError ? 'danger' : isWrite ? 'success' : openable ? 'info' : 'muted',
            badge: tu.isError ? { text: 'error', color: 'danger' } : undefined,
            tooltip: tooltipParts.filter(Boolean).join('\n'),
          };
        }),
        maxVisibleItems: 30,
        virtualScroll: true,
        selectable: true,
      },
    });
  }

  // If all four lists are empty, leave a placeholder so user sees "nothing to expand".
  if (
    stats.skills.length === 0 &&
    stats.mcpServers.length === 0 &&
    stats.ruleFiles.length === 0 &&
    allTools.length === 0
  ) {
    out.push({
      id: `turn-${turn.index}-empty`,
      template: 'text',
      data: { content: t.detailEmpty, format: 'plain', color: 'muted' },
    });
  }

  return out;
}

/** Build the history tab's section list: one header per turn + expanded detail sections inline. */
function historySections(input: LayoutInput): SectionDescriptor[] {
  const { t, turns, turnsStats, selectedSessionFile, liveSessionFile, expandedTurns } = input;
  if (!turns.length) {
    return [
      {
        id: 'history-empty',
        template: 'text',
        data: { content: t.emptyHistory, format: 'plain', color: 'muted' },
      },
    ];
  }
  const canUndo =
    !!liveSessionFile && (selectedSessionFile === null || selectedSessionFile === liveSessionFile);
  const sections: SectionDescriptor[] = [];
  const reversed = turns.slice().reverse();
  for (let i = 0; i < reversed.length; i++) {
    const turn = reversed[i];
    const stats = turnsStats[turns.length - 1 - i];
    sections.push(...turnSections(turn, stats, expandedTurns.has(turn.index), canUndo, t));
  }
  return sections;
}

function callDetailSection(input: LayoutInput): SectionDescriptor {
  const { turns, t, goto } = input;
  const blocks = turnsToMsgBlocks(turns);
  return {
    id: 'calldetail',
    template: 'msg-viewer',
    fill: true,
    data: {
      blocks,
      language: 'zh',
      autoScroll: true,
      emptyTitle: t.emptyHistory,
      scrollToBlockId: goto?.blockId,
      scrollNonce: goto?.nonce,
    },
  };
}

function notInstalledBanner(t: Locale): SectionDescriptor {
  return {
    id: 'banner-not-installed',
    template: 'notification',
    data: {
      items: [
        {
          id: 'not-installed',
          type: 'info',
          title: t.claudeNotInstalled,
          message: t.claudeNotInstalledHint,
        },
      ],
    },
  };
}

function idlePlaceholder(t: Locale): SectionDescriptor {
  return {
    id: 'idle',
    template: 'text',
    data: {
      content: `${t.noClaudeDetected}\n\n${t.noClaudeDetectedHint}\n${t.orText}\n${t.launchClaudeButton}`,
      format: 'plain',
      color: 'muted',
    },
  };
}

function staleBanner(t: Locale): SectionDescriptor {
  return {
    id: 'stale',
    template: 'notification',
    data: {
      items: [
        { id: 'stale', type: 'warning', message: t.sessionEndedBanner },
      ],
    },
  };
}

function tabsSection(input: LayoutInput): SectionDescriptor {
  const { t, goto } = input;
  return {
    id: 'tabs',
    template: 'tabs',
    fill: true,
    data: {
      // Default tab is "history"; when a goto is pending, force to
      // "calldetail" and bump the nonce so TabsTemplate re-syncs.
      activeTab: goto ? 'calldetail' : 'history',
      activeTabNonce: goto?.nonce,
      tabs: [
        { id: 'history', label: t.tabHistory, sections: historySections(input) },
        { id: 'calldetail', label: t.tabCallDetails, sections: [callDetailSection(input)] },
      ],
    },
  };
}

/** Single inline row: hint text on the left + "+ Create" button on the right. */
function noPresetInline(t: Locale): SectionDescriptor {
  return {
    id: 'no-preset-action',
    template: 'button-group',
    data: {
      layout: 'horizontal',
      buttons: [
        {
          id: 'createPreset',
          label: `${t.noPresetTitle} · ${t.createPresetButton}`,
          icon: 'plus',
          color: 'primary',
          variant: 'solid',
        },
      ],
    },
  };
}

export function buildPanelSections(input: LayoutInput): SectionDescriptor[] {
  const sections: SectionDescriptor[] = [headerSection(input)];

  if (!input.claudeInstalled) sections.push(notInstalledBanner(input.t));

  // Compact controls: preset / drive / session, all in one form for left-aligned labels.
  sections.push(compactControlsSection(input));

  if (!input.activeTab) {
    if (input.sessions.length === 0) sections.push(idlePlaceholder(input.t));
    else sections.push(tabsSection(input));
    return sections;
  }

  if (input.activeTab.status === 'idle' && input.sessions.length === 0) {
    sections.push(idlePlaceholder(input.t));
    return sections;
  }
  if (input.activeTab.status === 'stale') sections.push(staleBanner(input.t));

  sections.push(tabsSection(input));
  return sections;
}
