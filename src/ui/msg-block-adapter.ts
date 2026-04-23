import type { PromptTurn, ToolUse } from '../data/types';
import type { MsgBlock } from './msg-block-types';

function toolLabel(tool: ToolUse): string {
  if (tool.kind === 'skill') {
    const skillName =
      (tool.input && typeof tool.input === 'object' && (tool.input as { skill?: string }).skill) ||
      '';
    return skillName ? `Skill · ${skillName}` : 'Skill';
  }
  if (tool.kind === 'mcp') {
    // tool.name is `mcp__<server>__<tool>` — show "server · tool"
    const parts = tool.name.split('__');
    const server = parts[1] ?? 'mcp';
    const toolPart = parts.slice(2).join('__') || tool.name;
    return `MCP · ${server} / ${toolPart}`;
  }
  if (tool.kind === 'task') return 'Agent';
  return tool.name;
}

function toolInputObject(input: unknown): Record<string, unknown> | undefined {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return undefined;
}

/**
 * PromptTurn[] → MsgBlock[] for the msg-viewer template. Emits, in order,
 * per turn: user_text + (assistant_text + tool_use...) for each assistant
 * event in the turn.
 */
export function turnsToMsgBlocks(turns: PromptTurn[]): MsgBlock[] {
  const blocks: MsgBlock[] = [];
  for (const turn of turns) {
    blocks.push({
      type: 'user_text',
      id: `user-${turn.userEvent.uuid}`,
      timestamp: turn.userEvent.ts,
      content: turn.userEvent.text,
    });
    for (const msg of turn.assistantEvents) {
      if (msg.text) {
        blocks.push({
          type: 'assistant_text',
          id: `asst-${msg.uuid}`,
          timestamp: msg.ts,
          content: msg.text,
          status: 'completed',
        });
      }
      for (const tu of msg.toolUses) {
        blocks.push({
          type: 'tool_use',
          id: `tool-${tu.id}`,
          timestamp: msg.ts,
          toolName: tu.name,
          toolLabel: toolLabel(tu),
          toolInput: toolInputObject(tu.input),
          status: tu.isError ? 'error' : 'completed',
          isError: tu.isError,
        });
      }
    }
  }
  return blocks;
}
