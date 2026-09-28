import { invoke } from '@tauri-apps/api/core';
import type {
  Harness,
  Approval,
  PermissionOptions,
  PermissionDraft,
  SessionStatus,
  AccountStatus,
  Attachment,
  AttachmentPreview,
  CollaborationMode,
  FileData,
  Fingerprint,
  Entry,
  CodexDetection,
  FileMatch,
  GitSnapshot,
  Project,
  Settings,
  Model,
  Page,
  Thread,
  ThreadSettings,
  Turn,
  TimelineItem,
  Connection,
  SpeedTarget,
  SpeedResult,
} from './types';
export const api = {
  pickAttachments: () => invoke<Attachment[]>('attachments_pick'),
  previewAttachment: (id: string) =>
    invoke<AttachmentPreview>('attachment_preview', { id }),
  pasteImage: (name: string, bytes: number[]) =>
    invoke<Attachment>('attachment_paste_image', { name, bytes }),
  settings: () => invoke<Settings>('settings_get'),
  saveSettings: (value: Settings) => invoke<void>('settings_save', { value }),
  pickProject: () => invoke<string | null>('project_pick_directory'),
  openProject: (path: string) => invoke<Project>('project_open', { path }),
  list: (relativePath: string, showHidden: boolean) =>
    invoke<{ entries: Entry[]; truncated: boolean }>('file_list_directory', {
      relativePath,
      showHidden,
    }),
  read: (relativePath: string) =>
    invoke<FileData>('file_read', { relativePath }),
  stat: (relativePath: string) =>
    invoke<Fingerprint>('file_stat', { relativePath }),
  save: (
    relativePath: string,
    expectedFingerprint: Fingerprint,
    content: string,
  ) =>
    invoke<FileData>('file_save', {
      relativePath,
      expectedFingerprint,
      content,
    }),
  reveal: (relativePath: string) =>
    invoke<void>('file_reveal_in_system', { relativePath }),
  openDefault: (relativePath: string) =>
    invoke<void>('file_open_default', { relativePath }),
  createEntry: (parent: string, name: string, directory: boolean) =>
    invoke<string>('file_create', { parent, name, directory }),
  renameEntry: (relativePath: string, name: string) =>
    invoke<string>('file_rename', { relativePath, name }),
  trashEntry: (relativePath: string) =>
    invoke<void>('file_trash', { relativePath }),
  searchFiles: (query: string) =>
    invoke<FileMatch[]>('codex_fuzzy_file_search', { query }),
  revertThread: (threadId: string, beforeTurnId: string) =>
    invoke('agent_revert_thread', { threadId, beforeTurnId }),
  git: () => invoke<GitSnapshot>('git_refresh'),
  state: (harness: Harness = 'codex', threadId: string | null = null) =>
    invoke<Connection>('agent_get_state', { harness, threadId }),
  models: (harness: Harness = 'codex') =>
    invoke<Model[]>('agent_get_models', { harness }),
  account: (harness: Harness = 'codex') =>
    invoke<{
      account: { type: string; email?: string } | null;
      requiresOpenaiAuth: boolean;
    }>('agent_get_account', { harness }),
  login: () =>
    invoke<{ loginId: string; authUrl: string }>('codex_start_chatgpt_login'),
  cancelLogin: (loginId: string) => invoke('codex_cancel_login', { loginId }),
  chooseExecutable: () => invoke<string | null>('codex_choose_executable'),
  detectCodex: () => invoke<CodexDetection>('codex_detect'),
  openNotices: () => invoke<void>('app_open_notices'),
  threads: (cursor: string | null = null, archived = false) =>
    invoke<Page<Thread>>('agent_list_threads', { cursor, archived }),
  manageThread: (
    threadId: string,
    action: 'rename' | 'archive' | 'restore',
    name?: string,
  ) => invoke('agent_manage_thread', { threadId, action, name }),
  steer: (
    threadId: string,
    turnId: string,
    prompt: string,
    attachmentIds: string[],
    clientUserMessageId: string,
  ) =>
    invoke<{ turnId: string }>('agent_steer_turn', {
      threadId,
      turnId,
      prompt,
      attachmentIds,
      clientUserMessageId,
    }),
  testNotification: () => invoke<void>('notification_test'),
  resume: (threadId: string) =>
    invoke<{
      thread: Thread;
      approvals?: Approval[];
      settings: ThreadSettings;
    }>('agent_resume_thread', { threadId }),
  updateThreadSettings: (
    threadId: string,
    patch: Partial<Pick<ThreadSettings, 'model' | 'effort' | 'mode'>>,
  ) =>
    invoke<ThreadSettings>('agent_update_thread_settings', {
      threadId,
      ...patch,
    }),
  permissionOptions: (harness: Harness = 'codex') =>
    invoke<PermissionOptions>('agent_permission_options', { harness }),
  setPermissions: (threadId: string, patch: PermissionDraft) =>
    invoke<ThreadSettings>('agent_set_permissions', { threadId, ...patch }),
  sessionStatus: (threadId: string | null, harness: Harness = 'codex') =>
    invoke<SessionStatus>('agent_session_status', { threadId, harness }),
  setSpeed: (generation: number, targets: SpeedTarget[], fast: boolean) =>
    invoke<{ generation: number; results: SpeedResult[] }>('agent_set_speed', {
      generation,
      targets: targets.map(({ threadId, turnId }) => ({ threadId, turnId })),
      fast,
    }),
  accountStatus: (harness: Harness = 'codex') =>
    invoke<AccountStatus>('agent_account_status', { harness }),
  turns: (threadId: string, cursor: string | null = null) =>
    invoke<Page<Turn>>('agent_thread_turns', { threadId, cursor }),
  items: (threadId: string, turnId: string, cursor: string | null = null) =>
    invoke<Page<TimelineItem>>('agent_turn_items', {
      threadId,
      turnId,
      cursor,
    }),
  send: (
    threadId: string | null,
    prompt: string,
    model: string | null,
    effort: string | null,
    mode: CollaborationMode | null,
    attachmentIds: string[],
    permissions: PermissionDraft,
    harness: Harness = 'codex',
  ) =>
    invoke<{
      threadId: string;
      turn: Turn;
      settings: ThreadSettings;
    }>('agent_start_turn', {
      harness,
      threadId,
      prompt,
      model,
      effort,
      mode,
      attachmentIds,
      ...permissions,
    }),
  interrupt: (threadId: string, turnId: string) =>
    invoke('agent_interrupt_turn', { threadId, turnId }),
  respond: (
    generation: number,
    requestId: string,
    decision: unknown,
    answers: Record<string, string | string[]> | null = null,
    threadId: string | null = null,
  ) =>
    invoke<void>('agent_respond_server_request', {
      threadId,
      generation,
      requestId,
      decision,
      answers,
    }),
  output: (threadId: string, turnId: string, itemId: string, offset = 0) =>
    invoke<{ text: string; nextOffset: number; total: number }>(
      'agent_command_output',
      { threadId, turnId, itemId, offset },
    ),
  sleep: (harness: Harness = 'codex') => invoke('agent_sleep_now', { harness }),
  connectClaude: (executable: string | null) =>
    invoke<{
      authenticated: boolean;
      version: string;
      authMethod: string | null;
    }>('agent_connect_claude', { executable }),
  disconnectClaude: () => invoke<void>('agent_disconnect_claude'),
  quit: () => invoke('app_quit'),
  external: (url: string) => invoke<void>('open_external', { url }),
};
