export type Harness = 'codex' | 'claude';
export type Fingerprint = {
  sizeBytes: number;
  modifiedNanos: string;
  hash: string;
};
export type FileData = {
  path: string;
  content: string | null;
  encoding: string;
  sizeBytes: number;
  newline: string;
  fingerprint: Fingerprint;
  readOnlyRecommended: boolean;
};
export type Entry = {
  name: string;
  path: string;
  directory: boolean;
  symlink: boolean;
};
export type GitFile = { path: string; status: string; originalPath?: string };
export type GitSnapshot = {
  available: boolean;
  branch: string;
  head: string;
  files: GitFile[];
  unstaged: string;
  staged: string;
  truncated: boolean;
  error?: string;
};
export type Project = {
  root: string;
  displayName: string;
  git: GitSnapshot;
  lastThreadId?: string;
  openElsewhere?: undefined;
};
/** The project is already open in another window, which was brought forward. */
export type OpenedElsewhere = { root: string; openElsewhere: true };
export type Settings = {
  schemaVersion: number;
  claudeEnabled?: boolean;
  claudeExecutablePath?: string | null;
  appearance: string;
  motion?: 'expressive' | 'saving';
  newChatAccess?: 'standard' | 'full';
  onboardingComplete?: boolean;
  desktopNotifications?: boolean;
  pinnedThreads?: string[];
  codexExecutablePath: string | null;
  codexIdleTimeoutSeconds: number;
  recentProjects: string[];
  /** The agent new conversations start with: the one used last. */
  lastAgent?: 'codex' | 'claude' | null;
  openProjects?: string[];
  projectState: Record<string, string>;
  paneSizes: Record<string, number>;
};
export type Model = {
  id: string;
  model: string;
  displayName: string;
  isDefault: boolean;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
  defaultReasoningEffort: string;
};
export type SpeedTarget = {
  threadId: string;
  turnId: string | null;
  title: string;
};
export type SpeedResult = {
  threadId: string;
  turnId: string | null;
  future: 'saved' | 'failed';
  active:
    'applied' | 'targetUnavailable' | 'notTargeted' | 'notChanged' | 'failed';
  settings?: ThreadSettings | null;
  error?: string;
  futureError?: string;
  activeError?: string;
};
export type Turn = {
  id: string;
  status: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  items?: TimelineItem[];
  settings?: ThreadSettings | null;
};
export type TimelineItem = {
  clientId?: string | null;
  delivery?: 'sending' | 'accepted';
  steps?: { step: string; status: 'pending' | 'inProgress' | 'completed' }[];
  phase?: 'commentary' | 'final_answer' | null;
  summaryParts?: Record<number, string>;
  id: string;
  threadId: string;
  turnId: string;
  kind: string;
  title: string;
  status: string;
  text?: string;
  command?: string;
  cwd?: string;
  output?: string;
  exitCode?: number;
  durationMs?: number;
  truncated?: boolean;
  detail?: string;
  files?: { path: string; kind?: { type: string }; diff?: string }[];
};
export type Approval = {
  requestId: string;
  generation: number;
  kind: string;
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string;
  command?: string;
  cwd?: string;
  network?: { host: string; protocol: string; port?: number };
  permissions?: unknown;
  grantRoot?: string;
  decisions: unknown[];
  questions?: {
    id: string;
    question: string;
    header: string;
    isSecret?: boolean;
    multiSelect?: boolean;
    options?: { label: string; description: string }[];
  }[];
};
export type RunStatus =
  | 'running'
  | 'waitingInput'
  | 'waitingApproval'
  | 'waiting'
  | 'planGenerated'
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'error'
  | 'connectionLost'
  | 'idle'
  | 'noTasks'
  | 'unknown';
export type Thread = {
  id: string;
  name?: string | null;
  preview: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  status: { type: string; activeFlags?: string[] };
  model?: string;
  runStatus?: RunStatus;
  latestTurnId?: string | null;
};
export type Page<T> = {
  data: T[];
  nextCursor: string | null;
  warning?: string | null;
};
export type Connection = {
  harness?: Harness;
  threadId?: string;
  type: string;
  message?: string;
  generation?: number;
  pid?: number;
  active?: [string, string];
  activeThreads?: Record<string, string>;
  waitingThreads?: string[];
  approvals?: number;
};
export type Context = { id: string; label: string; text: string };
export type Tab = {
  path: string;
  data?: FileData;
  content?: string;
  dirty: boolean;
  editing: boolean;
  mode: 'edit' | 'preview' | 'split';
  conflict?: string;
  /** Includes confirmation and the pending write/read; typing remains allowed. */
  saving?: boolean;
  reloading?: boolean;
  cursor: number;
  scroll: number;
};

export type CollaborationMode = 'default' | 'plan';
export type ThreadSettings = {
  model: string | null;
  effort: string | null;
  mode: CollaborationMode | null;
  sandbox: unknown;
  approvalPolicy: unknown;
  approvalsReviewer?: unknown;
  permissionProfile?: { id?: string; extends?: string | null } | null;
  cwd?: string | null;
  modelProvider?: string | null;
  serviceTier?: string | null;
};
export type Attachment = {
  id: string;
  name: string;
  kind: 'image' | 'file';
  sizeBytes: number;
};
export type AttachmentPreview =
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'image'; dataUrl: string }
  | { kind: 'unavailable'; message: string };
export type Draft = {
  harness?: Harness;
  permissions: PermissionDraft;
  prompt: string;
  contexts: Context[];
  attachments: Attachment[];
  mode: CollaborationMode | null;
  overrides: boolean;
  model: string;
  effort: string;
};

export type PermissionOptions = {
  profiles: { id: string; description: string | null; allowed: boolean }[];
  approvalPolicies: string[];
};
export type PermissionDraft = {
  permissions: string | null;
  approvalPolicy: string | null;
};
export type TokenCounts = {
  totalTokens: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
};
export type TokenUsage = {
  scope?: 'turn' | 'conversation';
  estimatedCostUsd?: number | null;
  total: TokenCounts;
  last: TokenCounts;
  modelContextWindow: number | null;
};
export type SessionStatus = {
  thread: Thread | null;
  settings: ThreadSettings | null;
  usage: TokenUsage | null;
  generation: number;
};
export type UsageWindow = {
  usedPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: number | null;
};
export type AccountStatus = {
  account: { type: string; email?: string; planType?: string } | null;
  limits: {
    ordinaryUsageAllowed: boolean | null;
    buckets: {
      id: string | null;
      name: string | null;
      plan: string | null;
      primary: UsageWindow | null;
      secondary: UsageWindow | null;
    }[];
  } | null;
  accountError: string | null;
  limitsError: string | null;
  generation: number;
};
export type FileMatch = {
  path: string;
  fileName: string;
  indices: number[] | null;
};
/** Claude Code found on this Mac, with its sign-in state (no secrets). */
export type ClaudeDetection = {
  path: string;
  version: string;
  authenticated: boolean;
  authMethod?: string | null;
};
export type CodexDetection = {
  path: string;
  version: string | null;
  supported: boolean;
  minimum: string;
};
