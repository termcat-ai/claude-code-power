/**
 * Minimal MsgBlock shape mirrored from host `src/shared-components/msg-viewer/types.ts`.
 * External plugins cannot import host types at build time; keep this file aligned
 * whenever the upstream shape changes. We define only the variants we emit.
 */

export type BlockStatus =
  | 'idle' | 'running' | 'executing'
  | 'waiting_confirm' | 'waiting_password' | 'waiting_user_confirm'
  | 'waiting_permission' | 'waiting_feedback'
  | 'completed' | 'error';

export interface UserTextBlock {
  type: 'user_text';
  id: string;
  timestamp: number;
  content: string;
}

export interface AssistantTextBlock {
  type: 'assistant_text';
  id: string;
  timestamp: number;
  content: string;
  status: BlockStatus;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  timestamp: number;
  toolName: string;
  toolLabel: string;
  toolInput?: Record<string, unknown>;
  status: BlockStatus;
  isError?: boolean;
  output?: string;
}

export type MsgBlock = UserTextBlock | AssistantTextBlock | ToolUseBlock;
