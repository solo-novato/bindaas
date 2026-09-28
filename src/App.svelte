<script lang="ts">
  import { onMount, untrack, tick } from 'svelte';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { isTauri } from '@tauri-apps/api/core';
  import { api } from './lib/api';
  import {
    agentName,
    harnessOf,
    connectionKey,
    acceptsEvent,
    conversationKey,
    harnessCapabilities,
  } from './lib/harness';
  import type { Harness } from './lib/types';
  import {
    readWorkspaces,
    saveWorkspace,
    type Workspace,
  } from './lib/workspace';
  import {
    editor,
    openFile,
    saveTab,
    closeTab,
    protectDirty,
    checkFiles,
    currentTab,
  } from './lib/editor.svelte';
  import { dialog, ask, answer } from './lib/dialog.svelte';
  import { explorer } from './lib/explorer.svelte';
  import TreeMenu, { type TreeAction } from './lib/components/TreeMenu.svelte';
  import {
    mergeItem,
    applyDelta,
    checkKind,
    duration,
    itemKey,
  } from './lib/timeline';
  import { parseDiff } from './lib/diff';
  import { ReadingViews } from './lib/reading';
  import {
    applyMotionMode,
    markLaunch,
    motionEnabled,
    revealFrom,
    rise,
    viewTransition,
    type MotionMode,
  } from './lib/motion';
  import Toasts, { type Toast } from './lib/components/Toasts.svelte';
  import {
    completedRunStatus,
    runtimeRunStatus,
    type HistoryFilter,
  } from './lib/runs';
  import RunsWorkspace from './lib/components/RunsWorkspace.svelte';
  import ProjectSwitcher from './lib/components/ProjectSwitcher.svelte';
  import Icon, { type IconName } from './lib/components/Icon.svelte';
  import PaneDivider from './lib/components/PaneDivider.svelte';
  import CommandMenu from './lib/components/CommandMenu.svelte';
  import type { LaunchEntry, LaunchScope } from './lib/launcher';
  import Timeline from './lib/components/Timeline.svelte';
  import ApprovalCard from './lib/components/ApprovalCard.svelte';
  import AttachmentPreview from './lib/components/AttachmentPreview.svelte';
  import SessionPanel from './lib/components/SessionPanel.svelte';
  import { profileLabel } from './lib/session';
  import type {
    Attachment,
    PermissionDraft,
    CollaborationMode,
    Draft,
    Approval,
    Connection,
    Context,
    Entry,
    GitSnapshot,
    Model,
    Project,
    Settings,
    Thread,
    RunStatus,
    ThreadSettings,
    TimelineItem,
    Turn,
    FileMatch,
  } from './lib/types';
  import MentionMenu from './lib/components/MentionMenu.svelte';
  import SettingsView from './lib/components/SettingsView.svelte';
  import TopBar from './lib/components/TopBar.svelte';
  import ExplorerPane from './lib/components/ExplorerPane.svelte';
  import TaskHeader from './lib/components/TaskHeader.svelte';
  import WelcomeScreen from './lib/components/WelcomeScreen.svelte';
  import InspectorPane from './lib/components/InspectorPane.svelte';
  import QueueCard from './lib/components/QueueCard.svelte';
  import ComposerControls from './lib/components/ComposerControls.svelte';
  import {
    buildLaunchEntries,
    type LaunchActions,
  } from './lib/app/launchEntries';
  import { createExplorerActions } from './lib/app/explorerActions';
  import {
    LauncherSearch,
    Mentions,
    ProjectSearch,
  } from './lib/app/fileSearch.svelte';
  import Onboarding from './lib/components/Onboarding.svelte';
  let view = $state('Chat');
  let project = $state<Project | null>(null);
  let settings = $state<Settings | null>(null);
  let selectedHarness = $state<Harness>('codex');
  const agentLabel = $derived(agentName(selectedHarness));
  const capabilities = $derived(harnessCapabilities[selectedHarness]);
  let connections = $state<Record<string, Connection>>({
    codex: { type: 'sleeping' },
  });
  let switchNotice = $state('');
  let models = $state<Model[]>([]);
  let model = $state('');
  let effort = $state('');
  let account = $state<{ type: string; email?: string } | null>(null);
  let requiresAuth = $state(false);
  let codexAccount = $state<{ type: string; email?: string } | null>(null);
  let codexRequiresAuth = $state(false);
  let login = $state<{ loginId: string; authUrl: string } | null>(null);
  let error = $state('');
  let busy = $state(false);
  let starting = $state(false);
  let prompt = $state('');
  let queued = $state<Draft | null>(null);
  let queueSending = $state(false);
  const pendingSteers = new Map<string, TimelineItem>();
  let queueError = $state('');
  let queueComposerOpen = $state(false);
  let archivedHistory = $state(false);
  let conversationBusy = $state(false);
  let attachments = $state<Attachment[]>([]);
  let attaching = $state(false);
  let mode = $state<CollaborationMode | null>(null);
  let settingsBusy = $state(false);
  let sessionPanel = $state<'status' | 'permissions' | null>(null);
  let permissionDraft = $state<PermissionDraft>({
    permissions: ':workspace',
    approvalPolicy: 'on-request',
  });
  let threadSettings = $state<ThreadSettings | null>(null);
  let taskSettings = $state<ThreadSettings | null>(null);
  let contexts = $state<Context[]>([]);
  let contextPreview = $state<Context | null>(null);
  let attachmentPreview = $state<Attachment | null>(null);
  let attachmentPreviewTrigger = $state<HTMLButtonElement>();
  let composer: HTMLTextAreaElement;
  let threadId = $state<string | null>(null);
  const connection = $derived(
    connections[
      selectedHarness === 'claude' ? (threadId ?? 'claude') : 'codex'
    ] ?? { type: 'sleeping', harness: selectedHarness },
  );

  let turn = $state<Turn | null>(null);
  let taskPrompt = $state('');
  let threadNames = $state<Record<string, string | null>>({});
  // The opening message names a conversation until Codex gives it a title;
  // later follow-ups never rename it.
  let openingPrompts = $state<Record<string, string>>({});
  const titleRevisions = new Map<string, number>();
  function titleFor(id: string) {
    return (
      threadNames[id] ||
      openingPrompts[id] ||
      threads.find((thread) => thread.id === id)?.preview ||
      ''
    );
  }
  function rememberOpening(id: string, text?: string | null) {
    if (id && text?.trim() && !openingPrompts[id])
      openingPrompts[id] = text.trim();
  }
  const conversationTitle = $derived(
    (threadId && titleFor(threadId)) || taskPrompt || 'Agent task',
  );
  function updateThreadName(id: string, name: string | null) {
    const previousName = threadNames[id];
    threadNames[id] = name?.trim() || null;
    threads = threads.map((thread) =>
      thread.id === id ? { ...thread, name } : thread,
    );
    if (taskRuns[id])
      taskRuns[id].title =
        threadNames[id] ||
        threads.find((thread) => thread.id === id)?.preview ||
        (taskRuns[id].title !== previousName ? taskRuns[id].title : '') ||
        'Agent task';
  }
  let items = $state<TimelineItem[]>([]);
  const readingViews = new ReadingViews();
  let timeline = $state<Timeline | undefined>();
  let timelineScope = $state('conversation');
  let followRevision = $state(0);
  const timelineKey = $derived(
    `${project?.root}:${threadId ?? 'draft'}:${timelineScope}`,
  );
  const latestResponse = $derived(
    items
      .filter(
        (item) =>
          item.kind === 'message' &&
          item.turnId === turn?.id &&
          item.status !== 'inProgress',
      )
      .at(-1),
  );
  const latestPlan = $derived(
    items
      .filter((item) => item.kind === 'plan' && item.turnId === turn?.id)
      .at(-1),
  );
  let approvals = $state<Approval[]>([]);
  let turns = $state<Turn[]>([]);
  let threads = $state<Thread[]>([]);
  let threadCursor = $state<string | null>(null);
  let turnCursor = $state<string | null>(null);
  let itemCursor = $state<string | null>(null);
  let runsQuery = $state('');
  let runsStatus = $state<HistoryFilter>('all');
  let historyBusy = $state(false);
  let historyError = $state('');
  let historyRequest = 0;
  let runLoading = $state(false);
  let git = $state<GitSnapshot | null>(null);
  let baseline = $state<string[]>([]);
  let liveDiff = $state('');
  let liveTruncated = $state(false);
  let touched = $state<string[]>([]);
  let selectedPath = $state('');
  let diffSource = $state('repository');
  let diffScope = $state('unstaged');
  let reviewed = $state<Record<string, string>>({});
  const reviewScope = $derived(
    `${project?.root}:${threadId}:${turn?.id}:${diffSource}:${diffScope}`,
  );
  $effect(() => {
    reviewScope;
    reviewed = {};
  });
  let gitBusy = $state(false);
  let leftOpen = $state(true);
  let rightOpen = $state(true);
  let focusMode = $state(false);
  let compactLayout = $state(false);
  let inspectorDrawer = $state(false);
  const inspectorVisible = $derived(
    !!project &&
      rightOpen &&
      !focusMode &&
      view !== 'Settings' &&
      view !== 'Changes' &&
      view !== 'Runs' &&
      (!compactLayout || inspectorDrawer),
  );
  let leftWidth = $state(240);
  let rightWidth = $state(400);
  let windowWidth = $state(1440);
  let windowHeight = $state(940);
  const compactQueuedComposer = $derived(
    !!queued &&
      approvals.length > 0 &&
      windowHeight <= 760 &&
      !prompt &&
      !attachments.length &&
      !contexts.length &&
      !queueComposerOpen,
  );
  const leftLimit = $derived(
    Math.min(
      380,
      Math.max(
        180,
        windowWidth - 482 - (inspectorVisible && !compactLayout ? 300 : 0),
      ),
    ),
  );
  const displayedLeftWidth = $derived(Math.min(leftWidth, leftLimit));
  const rightLimit = $derived(
    compactLayout
      ? 600
      : Math.min(
          600,
          Math.max(
            300,
            windowWidth -
              482 -
              (leftOpen && !focusMode ? displayedLeftWidth : 0),
          ),
        ),
  );
  const displayedRightWidth = $derived(Math.min(rightWidth, rightLimit));
  let showHidden = $state(false);
  let expandedFolders = $state<string[]>([]);
  let sessionReady = $state(false);
  let restoring = $state(false);
  let pendingUserId = '';
  let pendingWorkspace: Workspace | null = null;
  let treeVersion = $state(0);
  let discovered = $state<Entry[]>([]);
  let projectMenu = $state(false);
  let projectTrigger = $state<HTMLButtonElement>();
  let launcher = $state<LaunchScope | null>(null);
  let findOpen = $state(false);
  let findQuery = $state('');
  let elapsed = $state(0);
  // Only transient UI drafts and live Codex events. Thread settings are always read from Codex.
  let taskRuns = $state<
    Record<
      string,
      {
        turn: Turn;
        title: string;
        waiting: boolean;
        diff?: string;
        truncated?: boolean;
        error?: string;
        planTurnId?: string;
      }
    >
  >({});
  const runStatusRevisions = new Map<string, number>();
  const liveRunStatuses = new Map<string, RunStatus>();
  function updateRunStatus(id: string, status: RunStatus) {
    runStatusRevisions.set(id, (runStatusRevisions.get(id) ?? 0) + 1);
    liveRunStatuses.set(id, status);
    threads = threads.map((thread) =>
      thread.id === id ? { ...thread, runStatus: status } : thread,
    );
  }
  const drafts = new Map<
    string,
    {
      prompt: string;
      contexts: Context[];
      attachments: Attachment[];
      queued: Draft | null;
      queueError?: string;
      settings?: Draft;
    }
  >();
  const anyActive = $derived(
    starting ||
      Object.values(taskRuns).some((r) => r.turn.status === 'inProgress') ||
      turn?.status === 'inProgress',
  );
  const backgroundTasks = $derived(
    Object.entries(taskRuns).filter(([id]) => id !== threadId),
  );
  const attentionTasks = $derived(
    backgroundTasks.filter(
      ([, task]) =>
        task.waiting ||
        !!task.error ||
        task.turn.status === 'connectionLost' ||
        task.turn.status === 'failed',
    ),
  );
  const workingTasks = $derived(
    Object.values(taskRuns).filter((task) => task.turn.status === 'inProgress')
      .length,
  );
  function browseTasks() {
    launcher = 'Tasks';
    if (project && !historyBusy) run(() => listThreads());
  }
  $effect(() => {
    if (view !== 'Chat') {
      findOpen = false;
      findQuery = '';
    }
  });
  const navigationBusy = $derived(
    starting ||
      queueSending ||
      conversationBusy ||
      runLoading ||
      attaching ||
      settingsBusy ||
      restoring,
  );
  const launchActions: LaunchActions = {
    newTask: () => newTask(),
    compose: async () => {
      await navigate('Chat');
      await tick();
      composer?.focus();
    },
    toggleFocus: () => toggleFocus(),
    navigate: (next) => navigate(next),
    browseFiles: async () => {
      focusMode = false;
      leftOpen = true;
      await navigate('Files');
    },
    showPanel: (panel) => (sessionPanel = panel),
    chooseProject: () => chooseProject(),
    toggleMotion: () =>
      setMotion(settings?.motion === 'saving' ? 'expressive' : 'saving'),
    resume: (id) => resume(id),
    open: (path) => open(path),
  };
  const launchEntries = $derived.by(() =>
    buildLaunchEntries(
      {
        navigationBusy,
        focusMode,
        changeCount: changedFiles.length,
        projectOpen: !!project,
        canOpenProject: !(anyActive || attaching),
        motion: settings?.motion === 'saving' ? 'saving' : 'expressive',
        settingsLoaded: !!settings,
        multiAgent: !!settings?.claudeEnabled,
        taskRuns,
        threads,
        filePaths: [
          ...editor.tabs.map((t) => t.path),
          ...changedFiles.map((f) => f.path),
          ...discovered.filter((e) => !e.directory).map((e) => e.path),
        ],
        projectMatches: launcherSearch.matches,
      },
      launchActions,
    ),
  );
  async function selectDestination(entry: LaunchEntry) {
    launcher = null;
    await tick();
    await run(async () => entry.run());
  }
  function recordConnection(value: Connection) {
    connections[connectionKey(value)] = value;
    for (const [id, turnId] of Object.entries(
      value.activeThreads ??
        (value.active ? { [value.active[0]]: value.active[1] } : {}),
    )) {
      taskRuns[id] = {
        ...taskRuns[id],
        turn: { id: turnId, status: 'inProgress' },
        title: taskRuns[id]?.title ?? 'Agent task',
        waiting: value.waitingThreads
          ? value.waitingThreads.includes(id)
          : (taskRuns[id]?.waiting ?? false),
      };
    }
  }
  function stashDraft() {
    drafts.set(threadId ?? `new:${selectedHarness}`, {
      prompt,
      contexts: [...contexts],
      attachments: [...attachments],
      queued,
      queueError,
      settings: currentDraft(),
    });
  }
  function loadDraft(id: string) {
    const saved = drafts.get(id);
    clearDraft();
    queued = saved?.queued ?? null;
    queueError = saved?.queueError ?? '';
    if (saved) {
      prompt = saved.prompt;
      contexts = saved.contexts;
      attachments = saved.attachments;
      if (id.startsWith('new:') && saved.settings) restoreDraft(saved.settings);
    }
  }
  async function sendBackground(id: string, draft: Draft) {
    try {
      const context = draft.contexts
        .map((c) => `\n\n--- Context: ${c.label} ---\n${c.text}`)
        .join('');
      await api.send(
        id,
        draft.prompt + context,
        draft.overrides ? draft.model || null : null,
        draft.overrides ? draft.effort || null : null,
        draft.overrides ? draft.mode : null,
        draft.attachments.map((a) => a.id),
        { permissions: null, approvalPolicy: null },
        draft.harness ?? harnessOf(id),
      );
    } catch (e) {
      const saved = drafts.get(id);
      drafts.set(id, {
        prompt: saved?.prompt ?? '',
        contexts: saved?.contexts ?? [],
        attachments: saved?.attachments ?? [],
        queued: draft,
      });
      if (taskRuns[id]) taskRuns[id].error = `Follow-up not sent: ${String(e)}`;
      if (threadId === id) {
        queued = draft;
        fail(e);
      }
    }
  }

  const liveTurn = $derived(threadId ? taskRuns[threadId]?.turn : null);
  const active = $derived(
    starting ||
      liveTurn?.status === 'inProgress' ||
      turn?.status === 'inProgress',
  );
  const planActionsEnabled = $derived(
    !active &&
      !navigationBusy &&
      turn?.status === 'completed' &&
      latestPlan?.status === 'completed' &&
      !latestPlan?.truncated &&
      !!latestPlan?.text?.trim(),
  );
  const thinking = $derived(
    active &&
      items.some(
        (i) =>
          i.turnId === turn?.id &&
          i.kind === 'thinking' &&
          i.status === 'inProgress',
      ),
  );
  const status = $derived(
    approvals.length
      ? approvals.some((a) => a.kind === 'userInput')
        ? 'Waiting for your answer'
        : 'Waiting for approval'
      : active
        ? thinking
          ? 'Thinking'
          : 'Working'
        : turn?.status === 'failed'
          ? 'Failed'
          : connection.type === 'ready'
            ? 'Ready'
            : connection.type === 'sleeping'
              ? 'Sleeping'
              : connection.type === 'disconnected'
                ? 'Disconnected'
                : connection.type === 'failed'
                  ? 'Setup required'
                  : connection.type === 'starting'
                    ? 'Starting'
                    : 'Connecting',
  );
  const selectedModel = $derived(models.find((m) => m.model === model));
  const diff = $derived(
    diffSource === 'task'
      ? liveDiff
      : diffScope === 'staged'
        ? (git?.staged ?? '')
        : (git?.unstaged ?? ''),
  );
  const parsed = $derived(parseDiff(diff));
  const changedFiles = $derived.by(() => {
    const map = new Map(
      parsed.map((f) => [
        f.path,
        {
          path: f.path,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
        },
      ]),
    );
    if (diffSource === 'repository')
      for (const file of git?.files ?? [])
        if (!map.has(file.path))
          map.set(file.path, {
            path: file.path,
            status: file.status,
            additions: 0,
            deletions: 0,
          });
    if (diffSource === 'task')
      for (const path of touched)
        if (!map.has(path))
          map.set(path, {
            path,
            status: 'modified',
            additions: 0,
            deletions: 0,
          });
    return [...map.values()];
  });
  const selectedDiff = $derived.by(() => {
    const file = parsed.find((f) => f.path === selectedPath);
    return file ? diff.slice(file.start, file.end) : '';
  });
  const observedChecks = $derived(
    items.filter(
      (i) =>
        i.kind === 'command' &&
        i.turnId === turn?.id &&
        checkKind(i.command ?? ''),
    ),
  );
  const fileWorkspace = () => import('./lib/components/FileWorkspace.svelte');
  let fileModule = $state<ReturnType<typeof fileWorkspace> | null>(null);
  const reviewWorkspace = () =>
    import('./lib/components/ReviewWorkspace.svelte');
  let reviewModule = $state<ReturnType<typeof reviewWorkspace> | null>(null);
  $effect(() => {
    if (view === 'Changes' && !reviewModule) reviewModule = reviewWorkspace();
  });
  const diffWorkspace = () => import('./lib/components/DiffView.svelte');
  let diffModule = $state<ReturnType<typeof diffWorkspace> | null>(null);
  $effect(() => {
    prompt;
    focusMode;
    if (composer) {
      composer.style.height = '0px';
      composer.style.height = `${Math.max(48, Math.min(220, composer.scrollHeight))}px`;
    }
  });
  $effect(() => {
    if (view === 'Files' && !fileModule) fileModule = fileWorkspace();
  });
  $effect(() => {
    if (
      selectedPath &&
      ((rightOpen && !focusMode) || view === 'Changes') &&
      !diffModule
    )
      diffModule = diffWorkspace();
  });
  $effect(() => {
    if (active) {
      const start = (turn?.startedAt ?? Date.now() / 1000) * 1000;
      elapsed = Date.now() - start;
      const timer = setInterval(() => (elapsed = Date.now() - start), 5000);
      return () => clearInterval(timer);
    }
  });
  $effect(() => {
    applyMotionMode(settings?.motion);
  });
  // macOS window buttons sit inside the top bar (overlay title bar).
  const nativeTitlebar =
    '__TAURI_INTERNALS__' in window && /Mac/.test(navigator.userAgent);
  let appliedAppearance = '';
  let lastPointer = { x: innerWidth / 2, y: 60 };
  $effect(() => {
    if (!settings) return;
    const next = settings.appearance;
    if (next === appliedAppearance) return;
    const first = !appliedAppearance;
    appliedAppearance = next;
    if (first) document.documentElement.dataset.appearance = next;
    // The new theme spreads out from wherever it was chosen.
    else {
      const root = document.documentElement;
      root.classList.add('theme-reveal');
      viewTransition(
        () => (root.dataset.appearance = next),
        () => revealFrom(lastPointer.x, lastPointer.y),
      );
      setTimeout(() => root.classList.remove('theme-reveal'), 700);
    }
  });
  // Background updates surface in-app; native notifications remain opt-in.
  let toasts = $state<Toast[]>([]);
  let toastSequence = 0;
  let taskPing = $state(0);
  function notify(threadId: string, tone: Toast['tone'], message: string) {
    const id = ++toastSequence;
    const title =
      titleFor(threadId) || taskRuns[threadId]?.title || 'Agent task';
    toasts = [
      ...toasts.filter((toast) => toast.threadId !== threadId),
      { id, threadId, title, tone, message },
    ].slice(-3);
    taskPing++;
    setTimeout(() => dismissToast(id), 7000);
  }
  function dismissToast(id: number) {
    toasts = toasts.filter((toast) => toast.id !== id);
  }
  // A task completing in front of you gets one celebratory moment.
  let celebrate = $state<string | null>(null);
  function celebrateIn(node: Element) {
    return celebrate && celebrate === turn?.id
      ? rise(node, { y: 14, duration: 380 })
      : { duration: 0 };
  }
  // Retry sends the same message again; it never rewrites history.
  async function retryTurn() {
    const original = taskPrompt.trim();
    if (!original || active) return;
    await sendDraft({
      ...currentDraft(),
      prompt: original,
      contexts: [],
      attachments: [],
    });
  }
  // Edit & resend removes the latest turn from the conversation (not from disk),
  // then puts its message back in the composer. Nothing is sent automatically.
  const editableTurnId = $derived(
    !active && threadId && selectedHarness === 'codex' && turn ? turn.id : null,
  );
  async function editAndResend(item: TimelineItem) {
    const id = threadId;
    if (!id || active || item.turnId !== editableTurnId) return;
    const draft = prompt.trim() || attachments.length || contexts.length;
    const choice = await ask(
      'Rewrite this message?',
      `This removes the message and everything after it from the conversation so you can change it and send it again. Files ${agentLabel} already changed stay as they are — review them in Changes.${draft ? ' Your current draft will be replaced.' : ''}`,
      ['Remove and edit', 'Cancel'],
    );
    if (choice !== 'Remove and edit') return;
    // Drop context blocks Bindaas appended when the message was sent.
    const text = (item.text ?? '').split('\n\n--- Context: ')[0];
    await api.revertThread(id, item.turnId);
    await resume(id);
    clearDraft();
    prompt = text;
    await tick();
    composer?.focus();
  }
  // The dock badge counts conversations waiting on you (event-driven).
  const attentionCount = $derived(
    attentionTasks.length + (approvals.length ? 1 : 0),
  );
  let badgeShown = 0;
  $effect(() => {
    const count = attentionCount;
    if (count === badgeShown) return;
    badgeShown = count;
    try {
      getCurrentWindow()
        .setBadgeCount(count || undefined)
        .catch(() => {});
    } catch {
      // Not running inside the desktop app.
    }
  });
  function toggleFocus() {
    // Panes glide away (or back) while the conversation resizes in place.
    const root = document.documentElement;
    root.classList.add('focus-morph');
    viewTransition(() => (focusMode = !focusMode));
    setTimeout(() => root.classList.remove('focus-morph'), 700);
  }
  let mainElement = $state<HTMLElement>();
  let shownView = untrack(() => view);
  $effect(() => {
    const next = view;
    if (next === shownView) return;
    shownView = next;
    if (!motionEnabled()) return;
    tick().then(() => {
      for (const child of mainElement?.querySelectorAll<HTMLElement>(
        ':scope > :not(.composer-area)',
      ) ?? [])
        child.animate(
          [
            { opacity: 0, transform: 'translateY(6px)' },
            { opacity: 1, transform: 'none' },
          ],
          { duration: 260, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
        );
    });
  });
  // First-run setup: shown until finished or skipped (and never for people who
  // already have projects).
  let setupOpen = $state(false);
  async function finishSetup() {
    setupOpen = false;
    if (!settings) return;
    settings.onboardingComplete = true;
    const saved = await api.settings();
    await api.saveSettings({ ...saved, onboardingComplete: true });
  }
  async function copyDiagnostics() {
    const report = {
      app: `Bindaas ${__APP_VERSION__}`,
      system: navigator.userAgent,
      codex: {
        state: connections.codex?.type ?? 'unknown',
        version: (connections.codex as { version?: string })?.version ?? null,
        executable: settings?.codexExecutablePath ? 'custom' : 'auto',
      },
      claude: settings?.claudeEnabled ? 'connected' : 'off',
      motion: settings?.motion ?? 'expressive',
      newChatAccess: settings?.newChatAccess ?? 'standard',
      projectOpen: !!project,
      lastError: error || null,
    };
    await navigator.clipboard.writeText(
      `Bindaas diagnostics\n\n${JSON.stringify(report, null, 2)}`,
    );
  }
  async function setNewChatAccess(access: 'standard' | 'full') {
    if (!settings) return;
    settings.newChatAccess = access;
    const saved = await api.settings();
    await api.saveSettings({ ...saved, newChatAccess: access });
    // An unsent new conversation picks up the new default immediately.
    if (!threadId && selectedHarness === 'codex')
      permissionDraft = newChatPermissions();
  }
  async function setMotion(mode: MotionMode) {
    if (!settings) return;
    settings.motion = mode;
    // Save only this preference; other unsaved Settings edits stay unsaved.
    const saved = await api.settings();
    await api.saveSettings({ ...saved, motion: mode });
  }
  $effect(() => {
    if (!changedFiles.some((f) => f.path === selectedPath))
      selectedPath = changedFiles[0]?.path ?? '';
  });
  function workspaceSnapshot(): Workspace | null {
    if (!project) return null;
    return {
      root: project.root,
      view,
      threadId,
      tabs: editor.tabs.slice(0, 40).map(({ path, mode, cursor, scroll }) => ({
        path,
        mode,
        cursor,
        scroll,
      })),
      activeFile: editor.active,
      expanded: expandedFolders.slice(0, 200),
      leftOpen,
      rightOpen,
      focusMode,
      showHidden,
    };
  }
  function persistWorkspace(snapshot = workspaceSnapshot()) {
    if (!snapshot) return;
    try {
      saveWorkspace(localStorage, snapshot);
    } catch {
      fail('Could not save workspace state. Local storage may be full.');
    }
  }
  $effect(() => {
    if (!sessionReady || restoring) return;
    const snapshot = workspaceSnapshot();
    pendingWorkspace = snapshot;
    const timer = setTimeout(
      () => untrack(() => persistWorkspace(snapshot)),
      250,
    );
    return () => clearTimeout(timer);
  });
  function activateDialog(node: HTMLDialogElement) {
    node.showModal();
    return {
      destroy() {
        node.close();
      },
    };
  }
  $effect(() => {
    if (
      queued &&
      !queueSending &&
      !queueError &&
      !active &&
      turn?.status === 'completed'
    ) {
      untrack(() => {
        const draft = queued!;
        queued = null;
        run(() => sendDraft(draft));
      });
    }
  });
  function fail(e: unknown) {
    error = String(e);
  }
  /** Runs an action, reporting failures in the app's error banner. */
  async function run(action: () => Promise<unknown>): Promise<boolean> {
    try {
      await action();
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  }
  function relative(path: string) {
    return project && path.startsWith(project.root + '/')
      ? path.slice(project.root.length + 1)
      : path;
  }
  function addContext(context: Context) {
    contexts = [...contexts, context];
    composer?.focus();
  }
  function prepareReview(context: Context, question: string) {
    prompt = prompt.trim() ? `${prompt}\n\n${question}` : question;
    addContext(context);
  }
  async function preparePlan(item: TimelineItem, implement: boolean) {
    if (
      !planActionsEnabled ||
      !latestPlan ||
      itemKey(item) !== itemKey(latestPlan)
    )
      return;
    const id = threadId;
    const key = itemKey(item);
    const nextMode = implement ? 'default' : 'plan';
    await changeThreadSettings({ mode: nextMode });
    if (
      !planActionsEnabled ||
      threadId !== id ||
      !latestPlan ||
      itemKey(latestPlan) !== key
    )
      return;
    if (mode !== nextMode)
      throw new Error(
        'Codex did not confirm the requested mode. Your draft has not changed.',
      );
    const contextId = `plan:${key}`;
    const implementationPrompt = 'Implement the attached plan.';
    const revisionPrompt = 'Revise the attached plan. My feedback:';
    if (contexts.some((context) => context.id === contextId)) {
      // Replace only an intact prepared paragraph; keep edited feedback verbatim.
      prompt = prompt
        .split('\n\n')
        .filter(
          (paragraph) =>
            paragraph !== implementationPrompt && paragraph !== revisionPrompt,
        )
        .join('\n\n');
    }
    contexts = contexts.filter((context) => context.id !== contextId);
    prepareReview(
      { id: contextId, label: 'Proposed plan', text: latestPlan.text! },
      implement ? implementationPrompt : revisionPrompt,
    );
    view = 'Chat';
    await tick();
    composer?.focus();
  }
  async function open(path: string) {
    view = 'Files';
    await openFile(relative(path));
  }
  // Explorer file actions. Rust never overwrites; dirty buffers block rename/trash.
  let treeMenu = $state<{
    entry: Entry | null;
    x: number;
    y: number;
    trigger: HTMLElement | null;
  } | null>(null);
  const { selectedFolder, startCreate, treeAction, commitName } =
    createExplorerActions({
      root: () => project?.root ?? null,
      discovered: () => discovered,
      setDiscovered: (entries) => (discovered = entries),
      expanded: () => expandedFolders,
      setExpanded: (paths) => (expandedFolders = paths),
      open,
      addContext,
      fail,
    });
  // Project file search for ⌘P and @ mentions (see lib/app/fileSearch).
  const projectSearch = new ProjectSearch(
    (query) => api.searchFiles(query),
    () => !!project,
  );
  const launcherSearch = new LauncherSearch(projectSearch);
  const mentions = new Mentions(projectSearch, () => [
    ...editor.tabs.map((t) => t.path),
    ...changedFiles.map((f) => f.path),
    ...discovered.filter((e) => !e.directory).map((e) => e.path),
  ]);
  async function pickMention(item: FileMatch) {
    const next = composer && mentions.insert(item, composer);
    if (!next) return;
    prompt = next.value;
    await tick();
    composer.focus();
    composer.setSelectionRange(next.caret, next.caret);
  }
  function discover(entries: Entry[]) {
    const map = new Map(discovered.map((e) => [e.path, e]));
    entries.forEach((e) => map.set(e.path, e));
    discovered = [...map.values()].slice(0, 10000);
  }
  async function chooseProject(path?: string) {
    if ((project && anyActive) || approvals.length || attaching) {
      fail('Finish the current task or attachment before switching projects.');
      return;
    }
    const target = path ?? (await api.pickProject());
    if (!target || !(await protectDirty())) return;
    persistWorkspace();
    const saved = readWorkspaces(localStorage).projects[target];
    restoring = true;
    busy = true;
    error = '';
    try {
      project = await api.openProject(target);
      taskRuns = {};
      threadNames = {};
      openingPrompts = {};
      runsQuery = '';
      runsStatus = 'all';
      historyRequest++;
      historyBusy = false;
      historyError = '';
      titleRevisions.clear();
      runStatusRevisions.clear();
      liveRunStatuses.clear();
      readingViews.clear();
      timelineScope = 'conversation';
      drafts.clear();
      clearDraft();
      queued = null;
      taskSettings = null;
      git = project.git;
      threadId = project.lastThreadId ?? null;
      turn = null;
      items = [];
      turns = [];
      threads = [];
      archivedHistory = false;
      approvals = [];
      liveDiff = '';
      touched = [];
      selectedPath = '';
      baseline = [];
      editor.tabs = [];
      editor.active = '';
      discovered = [];
      treeVersion++;
      view = 'Chat';
      projectMenu = false;
      inspectorDrawer = false;
      models = [];
      settings = await api.settings();
      expandedFolders = saved?.expanded ?? [];
      leftOpen = saved?.leftOpen ?? true;
      rightOpen = saved?.rightOpen ?? true;
      focusMode = saved?.focusMode ?? false;
      showHidden = saved?.showHidden ?? false;
      resetThreadSettings();
      const nextView = saved?.view ?? 'Chat';
      editor.tabs = (saved?.tabs ?? []).map((t) => ({
        ...t,
        dirty: false,
        editing: false,
      }));
      editor.active = editor.tabs.some((t) => t.path === saved?.activeFile)
        ? saved!.activeFile
        : '';
      recordConnection(await api.state());
      threadId =
        (saved ? saved.threadId : (project.lastThreadId ?? null)) ??
        Object.keys(connection.activeThreads ?? {})[0] ??
        connection.active?.[0] ??
        null;
      if (
        threadId &&
        (harnessOf(threadId) !== 'claude' || settings?.claudeEnabled)
      )
        await resume(conversationKey(threadId));
      else {
        threadId = null;
        selectedHarness = 'codex';
        resetThreadSettings();
      }
      if (nextView === 'Files' && editor.active) await openFile(editor.active);
      await navigate(nextView);
    } catch (e) {
      fail(e);
    } finally {
      busy = false;
      restoring = false;
      if (project) persistWorkspace();
    }
  }
  async function refreshGit() {
    if (!project || gitBusy) return;
    gitBusy = true;
    try {
      git = await api.git();
    } catch (e) {
      fail(e);
    } finally {
      gitBusy = false;
    }
  }
  async function switchHarness(next: Harness) {
    if (next === selectedHarness || navigationBusy) return;
    const previous = agentLabel;
    await newTask(next);
    switchNotice = `New ${agentName(next)} conversation. Your ${previous} conversation stays in Runs.`;
  }
  async function setupCodex(harness: Harness = selectedHarness) {
    busy = true;
    error = '';
    try {
      const results = await Promise.allSettled([
        api.models(harness),
        api.account(harness),
      ]);
      const [m, a] = results;
      if (harness === 'codex' && a.status === 'fulfilled') {
        codexAccount = a.value.account;
        codexRequiresAuth = a.value.requiresOpenaiAuth && !a.value.account;
      }
      if (selectedHarness !== harness) {
        if (a.status === 'rejected') fail(a.reason);
        if (m.status === 'rejected') fail(m.reason);
        return;
      }
      if (m.status === 'fulfilled') {
        models = m.value;
      } else fail(m.reason);
      if (a.status === 'fulfilled') {
        account = a.value.account;
        requiresAuth = a.value.requiresOpenaiAuth && !account;
      } else fail(a.reason);
    } finally {
      busy = false;
    }
  }
  // New conversations start with the access chosen in Settings. Existing
  // conversations keep whatever permissions Codex reports for them.
  function newChatPermissions(): PermissionDraft {
    return settings?.newChatAccess === 'full'
      ? { permissions: ':danger-full-access', approvalPolicy: 'never' }
      : { permissions: ':workspace', approvalPolicy: 'on-request' };
  }
  function resetThreadSettings() {
    threadSettings = null;
    permissionDraft = newChatPermissions();
    model = '';
    effort = '';
    mode = selectedHarness === 'claude' ? 'default' : null;
    if (selectedHarness === 'claude')
      permissionDraft = { permissions: null, approvalPolicy: null };
  }
  function applyThreadSettings(value: ThreadSettings | null) {
    threadSettings = value;
    model = value?.model ?? '';
    effort = value?.effort ?? '';
    mode = value?.mode ?? null;
  }
  async function changeThreadSettings(
    patch: Partial<Pick<ThreadSettings, 'model' | 'effort' | 'mode'>>,
  ) {
    if (!threadId) {
      if ('model' in patch) model = patch.model ?? '';
      if ('effort' in patch) effort = patch.effort ?? '';
      if ('mode' in patch) mode = patch.mode ?? null;
      return;
    }
    settingsBusy = true;
    const id = threadId;
    try {
      const value = await api.updateThreadSettings(id, patch);
      if (threadId === id) applyThreadSettings(value);
    } finally {
      settingsBusy = false;
    }
  }
  async function refreshTurnSettings(id: string, turnId: string) {
    const page = await api.turns(id);
    if (threadId !== id || turn?.id !== turnId) return;
    const recorded = page.data.find((t) => t.id === turnId)?.settings;
    if (recorded) {
      taskSettings = recorded;
      if (!threadSettings?.mode && !settingsBusy) applyThreadSettings(recorded);
      turn = { ...turn, settings: recorded };
    }
  }
  async function beginLogin() {
    await run(async () => {
      login = await api.login();
      await api.external(login.authUrl);
    });
  }
  async function cancelLogin() {
    if (login) {
      await api.cancelLogin(login.loginId);
      login = null;
    }
  }
  function currentDraft(): Draft {
    return {
      prompt,
      harness: selectedHarness,
      permissions: { ...permissionDraft },
      contexts: [...contexts],
      attachments: [...attachments],
      mode,
      overrides: !threadId || active,
      model,
      effort,
    };
  }
  function restoreDraft(draft: Draft) {
    prompt = draft.prompt;
    permissionDraft = draft.permissions;
    contexts = draft.contexts;
    attachments = draft.attachments;
    mode = draft.mode;
    model = draft.model;
    effort = draft.effort;
  }
  function clearDraft() {
    prompt = '';
    contexts = [];
    attachments = [];
  }
  function addAttachments(picked: Attachment[]) {
    const next = [
      ...new Map([...attachments, ...picked].map((a) => [a.id, a])).values(),
    ];
    if (next.length > 8) throw new Error('Attach at most 8 files per message.');
    if (next.reduce((total, a) => total + a.sizeBytes, 0) > 40 * 1024 * 1024)
      throw new Error('Attachments must total at most 40 MiB.');
    attachments = next;
  }
  async function attachFiles() {
    attaching = true;
    try {
      addAttachments(await api.pickAttachments());
    } finally {
      attaching = false;
    }
  }
  function pasteImages(event: ClipboardEvent) {
    const images = [...(event.clipboardData?.items ?? [])]
      .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
      .map((i) => i.getAsFile())
      .filter((f): f is File => !!f);
    if (!images.length || !project || starting || attaching) return;
    event.preventDefault();
    run(async () => {
      attaching = true;
      try {
        if (images.length + attachments.length > 8)
          throw new Error('Attach at most 8 files per message.');
        for (const file of images) {
          if (file.size > 10 * 1024 * 1024)
            throw new Error('Images must be at most 10 MiB.');
          addAttachments([
            await api.pasteImage(
              file.name || 'Screenshot.png',
              Array.from(new Uint8Array(await file.arrayBuffer())),
            ),
          ]);
        }
      } finally {
        attaching = false;
      }
    });
  }
  async function send(waitForNextTurn = false) {
    if (
      !project ||
      (!prompt.trim() && !attachments.length && !contexts.length) ||
      starting ||
      queueSending ||
      attaching ||
      runLoading ||
      settingsBusy ||
      (threadId !== null && mode === null) ||
      restoring
    )
      return;
    const draft = currentDraft();
    if (active) {
      if (!waitForNextTurn && capabilities.steer) {
        clearDraft();
        await steerDraft(draft, false);
        return;
      }
      if (queued)
        throw new Error(
          'A follow-up is already queued. Edit or remove it first.',
        );
      queued = draft;
      queueComposerOpen = false;
      queueError = '';
      clearDraft();
      return;
    }
    clearDraft();
    await sendDraft(draft);
  }
  async function sendDraft(draft: Draft) {
    switchNotice = '';
    readingViews.follow(timelineKey);
    followRevision++;
    findOpen = false;
    findQuery = '';
    const original = draft.prompt;
    const context = draft.contexts
      .map((c) => `\n\n--- Context: ${c.label} ---\n${c.text}`)
      .join('');
    const full = original + context;
    starting = true;
    error = '';
    taskSettings = null;
    taskPrompt =
      original ||
      draft.attachments.map((a) => a.name).join(', ') ||
      'Attached context';
    liveDiff = '';
    touched = [];
    diffSource = 'task';
    turn = null;
    pendingUserId = `pending-${crypto.randomUUID()}`;
    const optimisticId = pendingUserId;
    markLaunch(composer?.closest('.composer-inner'));
    items = [
      ...items,
      {
        id: optimisticId,
        threadId: threadId ?? '',
        turnId: optimisticId,
        kind: 'user',
        title: 'You',
        status: 'completed',
        text: [
          original,
          ...draft.attachments.map((a) => `Attached ${a.kind}: ${a.name}`),
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ].slice(-400);
    approvals = [];
    try {
      const result = await api.send(
        threadId,
        full,
        draft.overrides ? draft.model || null : null,
        draft.overrides ? draft.effort || null : null,
        draft.overrides ? draft.mode : null,
        draft.attachments.map((a) => a.id),
        threadId
          ? { permissions: null, approvalPolicy: null }
          : draft.permissions,
        draft.harness ?? selectedHarness,
      );
      drafts.delete(`new:${draft.harness ?? selectedHarness}`);
      if (!threadId) rememberOpening(result.threadId, taskPrompt);
      threadId = result.threadId;
      if (
        !(turn as Turn | null) ||
        (turn as Turn | null)?.id !== result.turn.id
      )
        turn = result.turn;
      applyThreadSettings(result.settings);
      taskSettings = result.turn.settings ?? taskSettings;
      items = items.map((i) =>
        i.id === optimisticId
          ? { ...i, threadId: result.threadId, turnId: result.turn.id }
          : i,
      );
    } catch (e) {
      fail(e);
      items = items.filter((i) => i.id !== optimisticId);
      if (!prompt && !contexts.length && !attachments.length)
        restoreDraft(draft);
      else queued = draft;
      // A failed start does not imply that other threads disconnected.
      recordConnection(
        await api.state(selectedHarness, threadId).catch(() => connection),
      );
    } finally {
      starting = false;
    }
  }
  async function sendQueuedNow() {
    if (!queued || queueSending || navigationBusy) return;
    if (!active) {
      const draft = queued;
      queued = null;
      queueError = '';
      await sendDraft(draft);
      return;
    }
    if (selectedHarness === 'claude') return;
    await steerDraft(queued, true);
  }
  async function steerDraft(draft: Draft, fromQueue: boolean) {
    const id = threadId;
    const running = liveTurn?.status === 'inProgress' ? liveTurn : turn;
    if (fromQueue) queueError = '';
    if (!id || running?.status !== 'inProgress') {
      if (fromQueue) queued = null;
      await sendDraft(draft);
      return;
    }
    queueSending = true;
    error = '';
    const optimisticId = `steer-${crypto.randomUUID()}`;
    markLaunch(composer?.closest('.composer-inner'));
    items = [
      ...items,
      {
        id: optimisticId,
        threadId: id,
        turnId: running.id,
        kind: 'user',
        title: 'You',
        status: 'inProgress',
        clientId: optimisticId,
        delivery: 'sending',
        text:
          [
            draft.prompt,
            ...draft.attachments.map((a) => `Attached ${a.kind}: ${a.name}`),
          ]
            .filter(Boolean)
            .join('\n') || 'Attached context',
      },
    ];
    pendingSteers.set(optimisticId, items[items.length - 1]);
    readingViews.follow(timelineKey);
    followRevision++;
    try {
      const context = draft.contexts
        .map((c) => `\n\n--- Context: ${c.label} ---\n${c.text}`)
        .join('');
      await api.steer(
        id,
        running.id,
        draft.prompt + context,
        draft.attachments.map((a) => a.id),
        optimisticId,
      );
      if (fromQueue) queued = null;
      const pending = pendingSteers.get(optimisticId);
      if (pending) {
        const accepted: TimelineItem = { ...pending, delivery: 'accepted' };
        pendingSteers.set(optimisticId, accepted);
        items = items.map((i) => (i.id === optimisticId ? accepted : i));
      }
      readingViews.follow(timelineKey);
      followRevision++;
    } catch (e) {
      const unconfirmed = pendingSteers.delete(optimisticId);
      // If the matching user-message event arrived first, Codex already accepted it.
      if (!unconfirmed) {
        if (fromQueue) queued = null;
        return;
      }
      items = items.filter((i) => i.id !== optimisticId);
      if (fromQueue) queueError = `Message remains queued. ${String(e)}`;
      else {
        // Preserve any context added while awaiting the reply, and keep Codex's current settings.
        prompt = [draft.prompt, prompt].filter(Boolean).join('\n\n');
        contexts = [
          ...new Map(
            [...draft.contexts, ...contexts].map((c) => [c.id, c]),
          ).values(),
        ];
        attachments = [
          ...new Map(
            [...draft.attachments, ...attachments].map((a) => [a.id, a]),
          ).values(),
        ];
        fail(`Message not confirmed. Your draft is restored. ${String(e)}`);
      }
    } finally {
      queueSending = false;
    }
  }
  async function manageConversation(
    id: string,
    action: 'rename' | 'archive' | 'restore',
    name?: string,
  ) {
    if (conversationBusy) return;
    if (action === 'archive') {
      const saved =
        id === threadId
          ? { prompt, attachments, contexts, queued }
          : drafts.get(id);
      if (
        saved &&
        (saved.prompt ||
          saved.attachments.length ||
          saved.contexts.length ||
          saved.queued)
      )
        throw new Error(
          'Send or remove this conversation’s draft and queued message before archiving.',
        );
      if (
        (await ask(
          'Archive conversation?',
          'You can restore it from Archived. Codex may also archive its child conversations.',
          ['Cancel', 'Archive'],
        )) !== 'Archive'
      )
        return;
    }
    conversationBusy = true;
    try {
      await api.manageThread(id, action, name);
      if (action === 'rename') updateThreadName(id, name!.trim());
      if (action === 'archive') {
        delete taskRuns[id];
        drafts.delete(id);
        if (id === threadId) await newTask();
      }
      await listThreads();
    } finally {
      conversationBusy = false;
    }
  }
  async function pinConversation(id: string) {
    if (!settings || conversationBusy) return;
    conversationBusy = true;
    const before = settings.pinnedThreads ?? [];
    const pinnedThreads = before.includes(id)
      ? before.filter((t) => t !== id)
      : [...before, id];
    try {
      await api.saveSettings({ ...settings, pinnedThreads });
      settings.pinnedThreads = pinnedThreads;
    } finally {
      conversationBusy = false;
    }
  }
  async function showArchived(value: boolean) {
    archivedHistory = value;
    threads = [];
    threadCursor = null;
    await listThreads();
  }
  async function stop() {
    const running = liveTurn?.status === 'inProgress' ? liveTurn : turn;
    if (threadId && running?.id) await api.interrupt(threadId, running.id);
  }
  async function newTask(nextHarness: Harness = selectedHarness) {
    if (starting || queueSending || runLoading || attaching || settingsBusy)
      return;
    stashDraft();
    const changedAgent = nextHarness !== selectedHarness;
    selectedHarness = nextHarness;
    switchNotice = '';
    if (changedAgent) {
      models = [];
      account = null;
      requiresAuth = false;
    }
    error = '';
    threadId = null;
    timelineScope = 'conversation';
    findQuery = '';
    resetThreadSettings();
    taskSettings = null;
    turn = null;
    items = [];
    approvals = [];
    taskPrompt = '';
    liveDiff = '';
    touched = [];
    queued = null;
    turns = [];
    turnCursor = null;
    itemCursor = null;
    baseline = [];
    liveTruncated = false;
    pendingUserId = '';
    loadDraft(`new:${selectedHarness}`);
    view = 'Chat';
    composer?.focus();
  }
  async function listThreads(more = false) {
    if (!project || historyBusy) return;
    const request = ++historyRequest;
    const root = project.root;
    const revisions = new Map(runStatusRevisions);
    const names = new Map(titleRevisions);
    historyBusy = true;
    historyError = '';
    try {
      const page = await api.threads(
        more ? threadCursor : null,
        archivedHistory,
      );
      if (project?.root !== root || request !== historyRequest) return;
      const data = page.data.map((thread) =>
        (runStatusRevisions.get(thread.id) ?? 0) !==
        (revisions.get(thread.id) ?? 0)
          ? {
              ...thread,
              runStatus: liveRunStatuses.get(thread.id) ?? thread.runStatus,
            }
          : thread,
      );
      threads = more
        ? [...new Map([...threads, ...data].map((t) => [t.id, t])).values()]
        : data;
      historyError = page.warning ?? '';
      for (const thread of data) {
        if (
          (titleRevisions.get(thread.id) ?? 0) === (names.get(thread.id) ?? 0)
        )
          updateThreadName(thread.id, thread.name ?? null);
        else updateThreadName(thread.id, threadNames[thread.id]);
      }
      threadCursor = page.nextCursor;
    } catch (e) {
      if (request === historyRequest) {
        historyError = String(e);
        if (view !== 'Runs') fail(e);
      }
    } finally {
      if (request === historyRequest) historyBusy = false;
    }
  }
  async function resume(id: string) {
    if (starting || queueSending || runLoading || attaching || settingsBusy)
      return;
    if (threadId !== id) {
      stashDraft();
      loadDraft(id);
    }
    approvals = [];
    liveDiff = taskRuns[id]?.diff ?? '';
    liveTruncated = taskRuns[id]?.truncated ?? false;
    touched = [];
    baseline = [];
    pendingUserId = '';
    runLoading = true;
    timelineScope = 'conversation';
    findQuery = '';
    error = '';
    if (selectedHarness !== harnessOf(id)) {
      models = [];
      account = null;
      requiresAuth = false;
    }
    selectedHarness = harnessOf(id);
    switchNotice = '';
    threadId = id;
    resetThreadSettings();
    taskSettings = null;
    turn = null;
    items = [];
    const titleRevision = titleRevisions.get(id) ?? 0;
    try {
      const result = await api.resume(id);
      id = result.thread.id;
      threadId = id;
      rememberOpening(id, result.thread.preview);
      if ((titleRevisions.get(id) ?? 0) === titleRevision)
        updateThreadName(id, result.thread.name ?? null);
      applyThreadSettings(result.settings);
      if (result.approvals) approvals = result.approvals;
      const page = await api.turns(id);
      turns = page.data;
      if (page.warning) fail(page.warning);
      turnCursor = page.nextCursor;
      const recent = page.data.slice(0, 6).reverse();
      const pages = await Promise.allSettled(
        recent.map((t) => api.items(id, t.id)),
      );
      let history: TimelineItem[] = [];
      pages.forEach((result, index) => {
        if (result.status === 'fulfilled') history.push(...result.value.data);
        else {
          history.push(...(recent[index].items ?? []));
          fail(result.reason);
        }
      });
      for (const live of items) history = mergeItem(history, live);
      for (const item of history) {
        if (
          !item.delivery &&
          item.clientId &&
          pendingSteers.get(item.clientId)?.threadId === id
        ) {
          const pending = pendingSteers.get(item.clientId)!;
          pendingSteers.delete(item.clientId);
          history = history.filter((i) => i.id !== pending.id || !i.delivery);
        }
      }
      for (const pending of pendingSteers.values()) {
        if (pending.threadId === id) history = mergeItem(history, pending);
      }
      items = history.slice(-400);
      const last = page.data[0];
      // Events received after this read started are newer than its history snapshot.
      const live = turn as Turn | null;
      turn = live
        ? { ...(last?.id === live.id ? last : {}), ...live }
        : (last ?? null);
      if (turn)
        taskRuns[id] = {
          ...taskRuns[id],
          turn,
          title:
            threadNames[id] ??
            taskRuns[id]?.title ??
            result.thread.preview ??
            'Agent task',
          waiting: approvals.length > 0,
        };
      taskSettings = turn?.settings ?? taskSettings;
      const latestPage = pages.at(-1);
      itemCursor =
        latestPage?.status === 'fulfilled' ? latestPage.value.nextCursor : null;
      taskPrompt =
        items.find((i) => i.kind === 'user' && i.turnId === turn?.id)?.text ??
        'Conversation';
      view = 'Chat';
    } catch (e) {
      fail(e);
    } finally {
      runLoading = false;
    }
  }
  async function moreTurns() {
    if (threadId && turnCursor) {
      const page = await api.turns(threadId, turnCursor);
      turns = [...turns, ...page.data];
      turnCursor = page.nextCursor;
    }
  }
  async function loadRun(value: Turn, more = false) {
    if (!threadId) return;
    runLoading = true;
    try {
      const page = await api.items(
        threadId,
        value.id,
        more ? itemCursor : null,
      );
      if (!more) timelineScope = `turn:${value.id}`;
      turn = value;
      taskSettings = value.settings ?? null;
      items = more ? [...items, ...page.data].slice(-400) : page.data;
      if (!more) {
        liveDiff = '';
        liveTruncated = false;
        baseline = [];
        selectedPath = '';
      }
      touched = [
        ...new Set(
          items.flatMap((i) => i.files?.map((f) => relative(f.path)) ?? []),
        ),
      ];
      diffSource = 'task';
      itemCursor = page.nextCursor;
      taskPrompt =
        items.find((i) => i.kind === 'user')?.text ?? 'Previous task';
      view = 'Chat';
    } catch (e) {
      fail(e);
    } finally {
      runLoading = false;
    }
  }
  async function navigate(next: string) {
    view = next;
    if (next === 'Files' && editor.active && !currentTab()?.data)
      await openFile(editor.active);
    if (next === 'Runs') await listThreads();
    if (next === 'Changes') {
      diffSource = active || !git?.available ? 'task' : 'repository';
      await refreshGit();
    }
  }
  async function saveSettings() {
    if (settings) {
      await api.saveSettings(settings);
      error = '';
    }
  }
  async function chooseExecutable() {
    const path = await api.chooseExecutable();
    if (path && settings) {
      settings.codexExecutablePath = path;
      await saveSettings();
    }
  }
  function savePaneSizes() {
    if (settings) {
      settings.paneSizes = { left: leftWidth, right: rightWidth };
      run(saveSettings);
    }
  }
  async function closeInspector() {
    if (compactLayout) inspectorDrawer = false;
    else rightOpen = false;
    await tick();
    document
      .querySelector<HTMLButtonElement>('[data-inspector-toggle]')
      ?.focus();
  }
  async function readPlan() {
    if (!latestPlan) return;
    const key = itemKey(latestPlan);
    if (compactLayout) inspectorDrawer = false;
    view = 'Chat';
    await tick();
    await timeline?.reveal(key);
    timeline?.focusReader();
  }
  function shortcut(e: KeyboardEvent) {
    if (e.defaultPrevented || document.querySelector('dialog[open]')) return;
    if (e.key === 'Escape') {
      if (findOpen) tick().then(() => timeline?.focusReader());
      findOpen = false;
      findQuery = '';
      projectMenu = false;
      if (inspectorDrawer) {
        inspectorDrawer = false;
        document
          .querySelector<HTMLButtonElement>('[data-inspector-toggle]')
          ?.focus();
      }
      if (dialog.resolve) answer('Cancel');
      return;
    }
    if (!e.metaKey && !e.ctrlKey) return;
    if (['1', '2', '3', '4'].includes(e.key)) {
      e.preventDefault();
      run(() => navigate(['Chat', 'Files', 'Changes', 'Runs'][+e.key - 1]));
    }
    if (e.key === 'o') {
      e.preventDefault();
      run(() => chooseProject());
    }
    if (e.key.toLowerCase() === 'k') {
      e.preventDefault();
      launcher = 'All';
    }
    if (e.key.toLowerCase() === 'p') {
      e.preventDefault();
      launcher = 'Files';
    }
    if (e.key.toLowerCase() === 'n') {
      e.preventDefault();
      run(() => newTask());
    }
    if (e.key.toLowerCase() === 'f' && e.shiftKey) {
      e.preventDefault();
      toggleFocus();
      return;
    }
    if (e.key.toLowerCase() === 'm' && e.shiftKey) {
      e.preventDefault();
      run(() =>
        setMotion(settings?.motion === 'saving' ? 'expressive' : 'saving'),
      );
      return;
    }
    if (e.key.toLowerCase() === 'l' && e.shiftKey) {
      e.preventDefault();
      run(async () => {
        await navigate('Chat');
        await tick();
        composer?.focus();
      });
    }
    if (e.key === 's') {
      e.preventDefault();
      run(() => saveTab());
    }
    if (e.key === 'w' && view === 'Files' && editor.active) {
      e.preventDefault();
      run(() => closeTab(editor.active));
    }
    if (e.key === 'f' && view === 'Chat') {
      e.preventDefault();
      findOpen = true;
      tick().then(() =>
        document
          .querySelector<HTMLInputElement>('[aria-label="Find in timeline"]')
          ?.focus(),
      );
    }
    if (e.key === 'f' && view === 'Runs') {
      e.preventDefault();
      document
        .querySelector<HTMLInputElement>('[aria-label="Search conversations"]')
        ?.focus();
    }
  }
  onMount(() => {
    const compact = window.matchMedia('(max-width: 1150px)');
    const updateLayout = () => {
      compactLayout = compact.matches;
      inspectorDrawer = false;
    };
    updateLayout();
    compact.addEventListener('change', updateLayout);
    let unlisten: UnlistenFn[] = [];
    let disposed = false;
    let quitAllowed = false;
    async function initialize() {
      if (!isTauri()) {
        error =
          'Desktop services are unavailable in a browser. Launch the native app with npm run desktop.';
        return;
      }
      const events: Record<string, (p: any) => void> = {
        connection: (p) => {
          if (!acceptsEvent(p, connections)) return;
          recordConnection(p);
          if (p.type === 'disconnected' || p.type === 'failed') {
            if (
              (p.harness ?? 'codex') === selectedHarness &&
              (!p.threadId || p.threadId === threadId)
            )
              approvals = [];
            for (const [id, entry] of Object.entries(taskRuns)) {
              if (
                harnessOf(id) !== (p.harness ?? 'codex') ||
                (p.threadId && p.threadId !== id)
              )
                continue;
              entry.waiting = false;
              if (entry.turn.status === 'inProgress') {
                entry.turn = { ...entry.turn, status: 'connectionLost' };
                updateRunStatus(id, 'connectionLost');
              }
            }
            if (
              turn?.status === 'inProgress' &&
              (p.harness ?? 'codex') === selectedHarness &&
              (!p.threadId || p.threadId === threadId)
            )
              turn = { ...turn, status: 'connectionLost' };
          }
        },
        baseline: (p) => {
          if (
            starting &&
            !threadId &&
            !taskRuns[p.threadId] &&
            (p.harness ?? 'codex') === selectedHarness
          ) {
            rememberOpening(p.threadId, taskPrompt);
            threadId = p.threadId;
          }
          if (p.threadId === threadId) {
            baseline = p.git.files.map((f: { path: string }) => f.path);
            git = p.git;
          }
        },
        'thread-settings': (p) => {
          if (!acceptsEvent(p, connections)) return;
          if (p.threadId === threadId) applyThreadSettings(p.settings);
        },
        'thread-archived': (p) => {
          if (!acceptsEvent(p, connections)) return;
          if (!archivedHistory)
            threads = threads.filter((t) => t.id !== p.threadId);
          delete taskRuns[p.threadId];
          if (threadId === p.threadId) run(() => newTask());
        },
        'thread-name': (p) => {
          titleRevisions.set(
            p.threadId,
            (titleRevisions.get(p.threadId) ?? 0) + 1,
          );
          updateThreadName(p.threadId, p.name ?? null);
        },
        'thread-status': (p) => {
          const run = taskRuns[p.threadId];
          const previous = threads.find(
            (thread) => thread.id === p.threadId,
          )?.runStatus;
          if (
            p.status.type === 'idle' &&
            !run &&
            previous &&
            [
              'planGenerated',
              'completed',
              'failed',
              'interrupted',
              'noTasks',
            ].includes(previous)
          )
            return;
          const status =
            p.status.type === 'idle' && run && run.turn.status !== 'inProgress'
              ? completedRunStatus(
                  run.turn.status,
                  run.planTurnId === run.turn.id,
                )
              : runtimeRunStatus(p.status);
          // Unloading a thread does not erase a known outcome.
          if (status !== 'unknown') updateRunStatus(p.threadId, status);
        },
        'turn-started': (p) => {
          updateRunStatus(p.threadId, 'running');
          if (
            starting &&
            !threadId &&
            !taskRuns[p.threadId] &&
            (p.harness ?? 'codex') === selectedHarness
          ) {
            rememberOpening(p.threadId, taskPrompt);
            threadId = p.threadId;
          }
          taskRuns[p.threadId] = {
            turn: p.turn,
            title:
              titleFor(p.threadId) ||
              (p.threadId === threadId
                ? taskPrompt
                : (taskRuns[p.threadId]?.title ?? 'Agent task')),
            waiting: false,
          };
          if (p.threadId === threadId) {
            turn = p.turn;
            taskSettings = p.settings ?? p.turn.settings ?? null;
            elapsed = 0;
          }
        },
        'turn-completed': (p) => {
          updateRunStatus(
            p.threadId,
            completedRunStatus(
              p.turn.status,
              taskRuns[p.threadId]?.planTurnId === p.turn.id,
            ),
          );
          taskRuns[p.threadId] = {
            ...taskRuns[p.threadId],
            turn: p.turn,
            title: taskRuns[p.threadId]?.title ?? 'Agent task',
            waiting: false,
          };
          if (p.threadId !== threadId) {
            notify(
              p.threadId,
              p.turn.status === 'completed'
                ? taskRuns[p.threadId]?.planTurnId === p.turn.id
                  ? 'plan'
                  : 'success'
                : p.turn.status === 'interrupted'
                  ? 'attention'
                  : 'error',
              p.turn.status === 'completed'
                ? taskRuns[p.threadId]?.planTurnId === p.turn.id
                  ? 'Plan ready for review'
                  : 'Finished in the background'
                : p.turn.status === 'interrupted'
                  ? 'Interrupted'
                  : 'Failed — open to see why',
            );
            const saved = drafts.get(p.threadId);
            if (
              saved?.queued &&
              !saved.queueError &&
              p.turn.status === 'completed'
            ) {
              const draft = saved.queued;
              saved.queued = null;
              run(() => sendBackground(p.threadId, draft));
            }
            run(async () => {
              await Promise.allSettled([refreshGit(), checkFiles()]);
              treeVersion++;
            });
            return;
          }
          items = items.map((i) =>
            i.turnId === p.turn.id &&
            i.kind === 'thinking' &&
            i.status === 'inProgress'
              ? { ...i, status: p.turn.status }
              : i,
          );
          if (p.turn.status === 'completed') celebrate = p.turn.id;
          turn = { ...p.turn, settings: taskSettings };
          run(() => refreshTurnSettings(p.threadId, p.turn.id));
          approvals = approvals.filter((a) => a.turnId !== p.turn.id);
          run(async () => {
            await Promise.allSettled([refreshGit(), checkFiles()]);
            if (git?.available) diffSource = 'repository';
            treeVersion++;
          });
        },
        'timeline-item': (p) => {
          if (
            p.kind === 'user' &&
            p.clientId &&
            pendingSteers.get(p.clientId)?.threadId === p.threadId
          ) {
            const pending = pendingSteers.get(p.clientId)!;
            pendingSteers.delete(p.clientId);
            if (p.threadId === threadId)
              items = items.filter((i) => i.id !== pending.id);
          }
          if (
            p.kind === 'plan' &&
            p.status === 'completed' &&
            taskRuns[p.threadId]?.turn.id === p.turnId
          ) {
            taskRuns[p.threadId].planTurnId = p.turnId;
            if (taskRuns[p.threadId].turn.status === 'completed')
              updateRunStatus(p.threadId, 'planGenerated');
          }
          if (p.threadId !== threadId) return;
          if (
            p.kind === 'user' &&
            !p.clientId &&
            pendingUserId &&
            (starting || p.turnId === turn?.id)
          ) {
            items = items.filter((i) => i.id !== pendingUserId);
            pendingUserId = '';
          }
          items = mergeItem(items, p);
          if (p.kind === 'fileChange') {
            touched = [
              ...new Set([
                ...touched,
                ...p.files.map((f: { path: string }) => relative(f.path)),
              ]),
            ];
            if (p.status !== 'inProgress') run(checkFiles);
          }
        },
        'timeline-update': (p) => {
          for (const delta of p) {
            if (acceptsEvent(delta, connections) && delta.threadId === threadId)
              items = applyDelta(items, delta);
          }
        },
        'turn-diff': (p) => {
          if (taskRuns[p.threadId]) {
            taskRuns[p.threadId].diff = p.diff;
            taskRuns[p.threadId].truncated = p.truncated;
          }
          if (p.threadId === threadId) {
            liveDiff = p.diff;
            liveTruncated = p.truncated;
            diffSource = 'task';
          }
        },
        'approval-requested': (p) => {
          updateRunStatus(
            p.threadId,
            p.kind === 'userInput' ? 'waitingInput' : 'waitingApproval',
          );
          if (taskRuns[p.threadId]) taskRuns[p.threadId].waiting = true;
          if (p.threadId !== threadId && taskRuns[p.threadId])
            notify(
              p.threadId,
              'attention',
              p.kind === 'userInput' ? 'Needs your answer' : 'Needs approval',
            );
          if (p.threadId === threadId)
            approvals = [
              ...approvals.filter((a) => a.requestId !== p.requestId),
              p,
            ];
        },
        'approval-resolved': (p) => {
          updateRunStatus(
            p.threadId,
            p.waiting
              ? 'waiting'
              : completedRunStatus(
                  taskRuns[p.threadId]?.turn.status ?? 'inProgress',
                  taskRuns[p.threadId]?.planTurnId ===
                    taskRuns[p.threadId]?.turn.id,
                ),
          );
          approvals = approvals.filter((a) => a.requestId !== p.requestId);
          if (taskRuns[p.threadId])
            taskRuns[p.threadId].waiting = p.waiting ?? false;
        },
        'auth-updated': (p) => {
          if (selectedHarness !== 'codex') return;
          if (p.loginId) login = null;
          if (p.error) fail(p.error);
          run(async () => {
            const v = await api.account();
            account = v.account;
            codexAccount = v.account;
            codexRequiresAuth = v.requiresOpenaiAuth && !v.account;
            requiresAuth = v.requiresOpenaiAuth && !account;
          });
        },
        warning: (p) => {
          if (!p.threadId || p.threadId === threadId)
            error = p.message ?? 'Codex reported an error';
        },
      };
      const results = await Promise.allSettled(
        Object.entries(events).map(([name, handler]) =>
          listen(`agent://${name}`, (event) => {
            const p = event.payload as any;
            if (!Array.isArray(p) && !acceptsEvent(p, connections)) return;
            handler(p);
          }),
        ),
      );
      for (const result of results) {
        if (result.status === 'fulfilled') {
          if (disposed) result.value();
          else unlisten.push(result.value);
        } else fail(result.reason);
      }
      const results2 = await Promise.allSettled([api.settings(), api.state()]);
      if (disposed) return;
      if (results2[0].status === 'fulfilled') {
        settings = results2[0].value;
        setupOpen =
          !settings.onboardingComplete && !settings.recentProjects?.length;
        leftWidth = Math.min(
          380,
          Math.max(180, settings.paneSizes.left ?? 240),
        );
        rightWidth = Math.min(
          600,
          Math.max(300, settings.paneSizes.right ?? 400),
        );
      } else fail(results2[0].reason);
      if (results2[1].status === 'fulfilled')
        recordConnection(results2[1].value);
      else fail(results2[1].reason);
      const requestQuit = async () => {
        if (quitAllowed) return;
        if (
          anyActive &&
          (await ask(
            'Tasks are still running',
            'Quit and interrupt all running tasks?',
            ['Quit and interrupt', 'Cancel'],
          )) !== 'Quit and interrupt'
        )
          return;
        const finalWorkspace = workspaceSnapshot();
        if (!(await protectDirty())) return;
        persistWorkspace(finalWorkspace);
        sessionReady = false;
        await api.quit();
        quitAllowed = true;
        await getCurrentWindow().destroy();
      };
      const close = await getCurrentWindow().onCloseRequested((event) => {
        event.preventDefault();
        run(requestQuit);
      });
      const quit = await listen('workbench://quit-requested', () =>
        run(requestQuit),
      );
      if (disposed) {
        close();
        quit();
      } else unlisten.push(close, quit);
      const previous = readWorkspaces(localStorage);
      const lastProject = previous.lastProject || settings?.recentProjects[0];
      if (lastProject && !disposed) await chooseProject(lastProject);
      sessionReady = true;
    }
    run(initialize);
    window.addEventListener('keydown', shortcut);
    const focus = () => {
      if (project) run(checkFiles);
    };
    window.addEventListener('focus', focus);
    const flushWorkspace = () => {
      if (sessionReady && !restoring)
        persistWorkspace(pendingWorkspace ?? workspaceSnapshot());
    };
    window.addEventListener('beforeunload', flushWorkspace);
    return () => {
      flushWorkspace();
      compact.removeEventListener('change', updateLayout);
      window.removeEventListener('beforeunload', flushWorkspace);
      disposed = true;
      unlisten.forEach((fn) => fn());
      window.removeEventListener('keydown', shortcut);
      window.removeEventListener('focus', focus);
    };
  });
</script>

<svelte:window
  bind:innerWidth={windowWidth}
  bind:innerHeight={windowHeight}
  onpointerdown={(e) => (lastPointer = { x: e.clientX, y: e.clientY })}
/>

<div
  class="app-shell"
  class:focus-mode={focusMode}
  class:native-titlebar={nativeTitlebar}
>
  <!-- Empty space anywhere in the bar drags the window; controls still click. -->
  <TopBar
    bind:projectTrigger
    {project}
    {git}
    {projectMenu}
    {view}
    changeCount={changedFiles.length}
    {agentLabel}
    multiAgent={!!settings?.claudeEnabled}
    {status}
    connectionType={connection.type}
    {active}
    awaitingDecision={approvals.length > 0}
    {workingTasks}
    {attentionTasks}
    {taskPing}
    {navigationBusy}
    newTaskDisabled={starting ||
      queueSending ||
      runLoading ||
      attaching ||
      settingsBusy}
    onproject={() => (projectMenu = !projectMenu)}
    onnavigate={(tab) => run(() => navigate(tab))}
    onlauncher={() => (launcher = 'All')}
    onstatus={() => (sessionPanel = 'status')}
    ontasks={browseTasks}
    onresume={(id) => run(() => resume(id))}
    onnewtask={() => newTask()}
  />
  {#if projectMenu}<ProjectSwitcher
      returnFocus={projectTrigger}
      paths={settings?.recentProjects ?? []}
      current={project?.root ?? null}
      blocked={anyActive || approvals.length
        ? 'Finish running tasks before switching projects.'
        : attaching
          ? 'Wait for attachments to finish before switching projects.'
          : busy || restoring || runLoading || settingsBusy
            ? 'Wait for the current operation to finish.'
            : ''}
      onselect={(path) => {
        projectMenu = false;
        run(() => chooseProject(path));
      }}
      onbrowse={() => {
        projectMenu = false;
        run(() => chooseProject());
      }}
      onclose={() => (projectMenu = false)}
    />{/if}
  {#if error}<div class="global-error" role="alert">
      <span>{error}</span
      >{#if connection.type === 'failed' || connection.type === 'disconnected'}<button
          onclick={() => (view = 'Settings')}>Open settings</button
        ><button onclick={() => run(setupCodex)}>Retry</button>{/if}<button
        aria-label="Dismiss error"
        onclick={() => (error = '')}>×</button
      >
    </div>{/if}
  <div
    class="work-area"
    style={`--left-width:${displayedLeftWidth}px;--right-width:${displayedRightWidth}px`}
  >
    {#if leftOpen && !focusMode && view !== 'Changes' && view !== 'Runs' && view !== 'Settings'}<ExplorerPane
        {project}
        {treeVersion}
        bind:showHidden
        changed={changedFiles.map((file) => file.path)}
        expanded={expandedFolders}
        note={explorer.note}
        oncreate={(directory) => startCreate(selectedFolder(), directory)}
        onrefresh={() => treeVersion++}
        oncollapse={async () => {
          leftOpen = false;
          await tick();
          document
            .querySelector<HTMLButtonElement>('[data-explorer-toggle]')
            ?.focus();
        }}
        onopenproject={() => run(() => chooseProject())}
        ontoggle={(path) =>
          (expandedFolders = expandedFolders.includes(path)
            ? expandedFolders.filter((p) => p !== path)
            : [...expandedFolders, path])}
        onopen={open}
        ondiscover={discover}
        onmenu={(entry, x, y, trigger) => (treeMenu = { entry, x, y, trigger })}
        onaction={(entry, action) => run(() => treeAction(entry, action))}
        oncommit={(name) => run(() => commitName(name))}
      />
      <PaneDivider
        label="Resize explorer"
        controls="project-explorer"
        value={displayedLeftWidth}
        min={180}
        max={leftLimit}
        defaultValue={240}
        onresize={(value) => (leftWidth = value)}
        oncommit={savePaneSizes}
      />{/if}
    <main
      bind:this={mainElement}
      class:awaiting-answer={approvals.some((a) => a.kind === 'userInput')}
    >
      {#if view !== 'Changes' && view !== 'Runs' && view !== 'Settings' && !(view === 'Chat' && (turn || starting))}<div
          class="surface-heading"
        >
          <div>
            {@render explorerToggle()}<span class="surface-title"
              >{view === 'Chat' ? 'New task' : view}</span
            >
          </div>
          <div>{@render paneControls()}</div>
        </div>
      {/if}
      {#if view === 'Chat'}
        {#if restoring}<div class="banner" role="status">
            Restoring your workspace…
          </div>{/if}
        {#if turn || starting}<TaskHeader
            {turn}
            {starting}
            {active}
            {thinking}
            awaitingDecision={approvals.length > 0}
            {latestPlan}
            {threadId}
            title={conversationTitle}
            agentBadge={settings?.claudeEnabled ? agentLabel : null}
            elapsedMs={elapsed}
            {taskPrompt}
            {taskSettings}
            leading={explorerToggle}
            actions={paneControls}
          />{/if}
        {#if findOpen}<div class="find-row">
            <input
              aria-label="Find in timeline"
              placeholder="Find messages and commands…"
              bind:value={findQuery}
            /><button
              onclick={() => {
                findOpen = false;
                findQuery = '';
                tick().then(() => timeline?.focusReader());
              }}>Close</button
            >
          </div>{/if}
        {#if runLoading}<div class="banner">Loading thread history…</div>{/if}
        {#if setupOpen}<Onboarding
            account={codexAccount}
            signingIn={!!login}
            access={settings?.newChatAccess === 'full' ? 'full' : 'standard'}
            projectOpen={!!project}
            onsignin={beginLogin}
            onchooseexecutable={() => run(chooseExecutable)}
            onaccess={(access) => run(() => setNewChatAccess(access))}
            onopenproject={() =>
              run(async () => {
                await chooseProject();
                if (project) await finishSetup();
              })}
            ondone={() => run(finishSetup)}
          />
        {:else if !items.length && !turn && !starting}<WelcomeScreen
            projectOpen={!!project}
            {agentLabel}
            {busy}
            canResume={!!threadId}
            onopenproject={() => run(() => chooseProject())}
            onsuggest={(title) => {
              prompt = title;
              composer.focus();
            }}
            onresume={() => threadId && run(() => resume(threadId!))}
          />
        {:else}{#key timelineKey}<Timeline
              {agentLabel}
              bind:this={timeline}
              {items}
              viewKey={timelineKey}
              savedView={readingViews.get(timelineKey)}
              onremember={(key, state) => readingViews.set(key, state)}
              {followRevision}
              loading={runLoading || restoring}
              oncontext={addContext}
              onopen={open}
              runningTurnId={active ? turn?.id : null}
              planActionKey={planActionsEnabled && latestPlan
                ? itemKey(latestPlan)
                : null}
              onplan={(item, implement) =>
                run(() => preparePlan(item, implement))}
              projectRoot={project?.root}
              query={findQuery}
              {editableTurnId}
              onedit={(item) => run(() => editAndResend(item))}
            />{/key}{/if}
        {#if active}<div class="thinking-status" role="status">
            <span class="thinking-dot"></span>{approvals.length
              ? 'Waiting for your answer below'
              : thinking
                ? 'Thinking…'
                : `${agentLabel} is working…`}
          </div>{/if}
        {#if itemCursor && turn}<button
            class="load-older"
            onclick={() => run(() => loadRun(turn!, true))}
            >Load more history items</button
          >{/if}
        {#if turn && !active && turn.status !== 'connectionLost'}<section
            class="completion"
            in:celebrateIn
            class:celebrate={celebrate === turn.id}
            class:all-passed={celebrate === turn.id &&
              observedChecks.length > 0 &&
              observedChecks.every((check) => check.exitCode === 0)}
            data-status={turn.status === 'completed'
              ? latestPlan?.status === 'completed'
                ? 'plan'
                : 'completed'
              : turn.status}
          >
            {#if celebrate === turn.id}<span class="spark" aria-hidden="true"
                >{#each Array(8) as _, n}<i style={`--n:${n}`}></i>{/each}</span
              >{/if}<strong
              >{turn.status === 'completed'
                ? latestPlan?.status === 'completed'
                  ? latestPlan.truncated
                    ? '◇ Plan received'
                    : '◇ Plan ready'
                  : '✓ Task completed'
                : turn.status === 'interrupted'
                  ? '■ Task interrupted'
                  : '× Task failed'}</strong
            ><span class="muted">{duration(turn.durationMs)}</span>
            {#if touched.length || observedChecks.length}<details
                class="completion-details"
              >
                <summary
                  >{[
                    `${touched.length} ${touched.length === 1 ? 'file' : 'files'} changed`,
                    observedChecks.length
                      ? `${observedChecks.filter((c) => c.exitCode === 0).length}/${observedChecks.length} checks passed`
                      : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}</summary
                >
                <div class="completion-panel">
                  <div class="result-stats">
                    <span
                      >{touched.length} files reported changed during task</span
                    ><span
                      >{observedChecks.filter((c) => c.exitCode === 0).length} observed
                      checks passed</span
                    >
                  </div>
                  {#if observedChecks.length}<div class="checks">
                      {#each observedChecks as check}<div class="row">
                          <span
                            class:success={check.exitCode === 0}
                            class:error={check.exitCode != null &&
                              check.exitCode !== 0}
                            >{check.exitCode === 0
                              ? '✓'
                              : check.exitCode == null
                                ? '?'
                                : '×'}</span
                          ><code>{check.command}</code><span class="muted"
                            >{check.exitCode == null
                              ? 'No exit status'
                              : `exit ${check.exitCode}`}</span
                          >
                        </div>{/each}
                    </div>{:else}<p class="muted small">
                      No test, lint, or typecheck commands were observed.
                    </p>{/if}
                </div>
              </details>{/if}
            {#if turn.error}<p class="error completion-error">
                {turn.error}
              </p>{/if}
            <div class="completion-actions">
              {#if (turn.status === 'failed' || turn.status === 'interrupted') && taskPrompt.trim()}<button
                  class="accent-button"
                  title="Send the same message again"
                  onclick={() => run(retryTurn)}>↻ Retry</button
                >{/if}
              {#if latestPlan}<button onclick={() => run(readPlan)}
                  >Read plan ↑</button
                >{/if}
              {#if latestResponse}<button
                  onclick={() => timeline?.reveal(itemKey(latestResponse!))}
                  >{latestResponse.phase === 'final_answer'
                    ? 'Read answer ↑'
                    : 'Read response ↑'}</button
                >{/if}
              {#if touched.length}<button
                  class="accent-button"
                  onclick={() => run(() => navigate('Changes'))}
                  >Review changes →</button
                >{/if}
            </div>
          </section>{/if}
        {#if turn?.status === 'connectionLost'}<div class="banner warning">
            Connection lost. The task outcome is unknown until history is
            reconciled.<button
              onclick={() => threadId && run(() => resume(threadId!))}
              >Restart and reconcile</button
            >
          </div>{/if}
        <!-- Decisions dock beside the composer, where you respond. -->
        {#if approvals.length}<div class="approvals">
            {#each approvals as approval (`${approval.generation}:${approval.requestId}`)}<ApprovalCard
                {approval}
                onresolved={(id) =>
                  (approvals = approvals.filter((a) => a.requestId !== id))}
              />{/each}
          </div>{/if}
      {:else if view === 'Files'}{#if fileModule}{#await fileModule}<div
              class="view-skeleton"
              role="status"
              aria-label="Loading file workspace"
            >
              <span class="skeleton" style="width:38%"></span><span
                class="skeleton"
                style="width:72%"
              ></span><span class="skeleton" style="width:64%"></span><span
                class="skeleton block"
              ></span>
            </div>{:then module}<module.default
              activeTask={active}
              oncontext={addContext}
            />{:catch e}<p class="error">{String(e)}</p>{/await}{/if}
      {:else if view === 'Changes'}{#if reviewModule}{#await reviewModule}<div
              class="view-skeleton"
              role="status"
              aria-label="Opening review"
            >
              <span class="skeleton" style="width:38%"></span><span
                class="skeleton"
                style="width:72%"
              ></span><span class="skeleton" style="width:64%"></span><span
                class="skeleton block"
              ></span>
            </div>{:then module}<module.default
              {diff}
              files={changedFiles}
              bind:selectedPath
              bind:reviewed
              {baseline}
              checks={observedChecks}
              {active}
              truncated={diffSource === 'task'
                ? liveTruncated
                : !!git?.truncated}
              source={diffSource === 'task'
                ? 'Changes reported by Codex for this task.'
                : 'Current repository changes, including pre-existing edits.'}
              controls={reviewControls}
              onopen={open}
              oncontext={addContext}
              onfollowup={prepareReview}
              onback={() => (view = 'Chat')}
            />{:catch e}<p class="error padded">
              Could not open review: {String(e)}
            </p>{/await}{/if}
      {:else if view === 'Runs'}<RunsWorkspace
          multiAgent={!!settings?.claudeEnabled}
          {threads}
          {turns}
          archived={archivedHistory}
          pins={settings?.pinnedThreads ?? []}
          ontogglearchive={(value) => run(() => showArchived(value))}
          onrename={(id, name) => manageConversation(id, 'rename', name)}
          onpin={(id) => run(() => pinConversation(id))}
          onarchive={(id) =>
            run(() =>
              manageConversation(id, archivedHistory ? 'restore' : 'archive'),
            )}
          selectedId={threadId}
          selectedTitle={(threadId && threadNames[threadId]) ||
            threads.find((thread) => thread.id === threadId)?.preview ||
            'Selected conversation'}
          projectName={project?.displayName ?? null}
          loading={historyBusy}
          loadError={historyError}
          opening={runLoading}
          disabled={navigationBusy}
          hasMore={!!threadCursor}
          hasOlderTurns={!!turnCursor}
          bind:query={runsQuery}
          bind:filter={runsStatus}
          onrefresh={() => run(() => listThreads())}
          onmore={() => run(() => listThreads(true))}
          onopen={(id) => run(() => resume(id))}
          onturn={(value) => run(() => loadRun(value))}
          onolder={() => run(moreTurns)}
          onnew={() => newTask()}
          onback={() => (view = 'Chat')}
          onproject={() => run(() => chooseProject())}
        />
      {:else if view === 'Settings'}<SettingsView
          bind:settings
          codex={connections.codex}
          {codexAccount}
          {codexRequiresAuth}
          {login}
          {busy}
          canSleep={!(anyActive || approvals.length || login)}
          debug={() => ({
            connection,
            threadId,
            turnId: turn?.id,
            pendingApprovals: approvals.length,
            timelineItems: items.length,
            bufferedPreviewCharacters: items.reduce(
              (n, i) => n + (i.output?.length ?? 0),
              0,
            ),
            editor: currentTab()?.path,
            gitBusy,
          })}
          onintegrations={async () => {
            settings = await api.settings();
            if (!settings.claudeEnabled && selectedHarness === 'claude')
              await newTask('codex');
            threads = [];
            threadCursor = null;
          }}
          onaccess={(access) => run(() => setNewChatAccess(access))}
          onconnect={() => run(() => setupCodex('codex'))}
          onsleep={() =>
            run(async () => {
              await api.sleep();
              models = [];
            })}
          onsignin={beginLogin}
          onopenlogin={() => login && run(() => api.external(login!.authUrl))}
          oncancellogin={() => run(cancelLogin)}
          onchooseexecutable={() => run(chooseExecutable)}
          ontestnotification={() => run(() => api.testNotification())}
          onmotion={(mode) => run(() => setMotion(mode))}
          onsave={() => run(saveSettings)}
          oncopydiagnostics={() => run(copyDiagnostics)}
          onnotices={() => run(() => api.openNotices())}
          onrunsetup={() => {
            setupOpen = true;
            view = 'Chat';
          }}
        />{/if}
      <footer
        class="composer-area"
        class:compact-queued={compactQueuedComposer}
        hidden={view === 'Runs' || view === 'Settings' || !project}
      >
        {#if switchNotice}<p class="agent-switch-note" role="status">
            {switchNotice}<button
              aria-label="Dismiss agent notice"
              onclick={() => (switchNotice = '')}>×</button
            >
          </p>{/if}
        {#if settings?.claudeEnabled && Object.values(taskRuns).filter((t) => t.turn.status === 'inProgress').length > 1}<p
            class="shared-workspace-note"
          >
            Multiple agents are working in this folder. Changes are shared.
          </p>{/if}
        {#if queued}<QueueCard
            {queued}
            {queueSending}
            {queueError}
            {active}
            claude={selectedHarness === 'claude'}
            {agentLabel}
            {navigationBusy}
            hasDraft={!!prompt || !!contexts.length || !!attachments.length}
            onsend={() => run(sendQueuedNow)}
            onedit={() => {
              restoreDraft(queued!);
              queued = null;
              queueError = '';
            }}
            onremove={() => {
              queued = null;
              queueError = '';
            }}
          />{/if}
        {#if compactQueuedComposer}<button
            class="queue-compose-toggle"
            onclick={async () => {
              queueComposerOpen = true;
              await tick();
              composer?.focus();
            }}>Write another message</button
          >{/if}
        <div
          class="composer-inner"
          data-mode={mode === 'plan' ? 'plan' : 'code'}
          class:queued-composer-hidden={compactQueuedComposer}
        >
          <div
            class="context-chips"
            hidden={!attachments.length && !contexts.length}
          >
            {#each attachments as attachment (attachment.id)}<span
                class="attachment-chip"
                title={`${attachment.name} · ${(attachment.sizeBytes / 1024).toFixed(1)} KiB`}
              >
                <button
                  class="attachment-open"
                  aria-label={`Preview attachment ${attachment.name}`}
                  onclick={(event) => {
                    attachmentPreviewTrigger = event.currentTarget;
                    attachmentPreview = attachment;
                  }}
                >
                  <span class="attachment-icon" aria-hidden="true"
                    >{attachment.kind === 'image' ? '▧' : '▤'}</span
                  >
                  <span class="attachment-copy"
                    ><strong>{attachment.name}</strong><small
                      >{attachment.kind === 'image' ? 'Image' : 'File'} · {(
                        attachment.sizeBytes / 1024
                      ).toFixed(1)} KiB</small
                    ></span
                  >
                </button>
                <button
                  aria-label={`Remove attachment ${attachment.name}`}
                  disabled={starting}
                  onclick={() =>
                    (attachments = attachments.filter(
                      (a) => a.id !== attachment.id,
                    ))}>×</button
                >
              </span>{/each}
            {#each contexts as context}<span
                ><button
                  class="context-label"
                  aria-label={`Preview context ${context.label}`}
                  onclick={() => (contextPreview = context)}
                  >{context.label}</button
                ><button
                  aria-label={`Remove ${context.label}`}
                  onclick={() =>
                    (contexts = contexts.filter((c) => c.id !== context.id))}
                  >×</button
                ></span
              >{/each}
          </div>
          <textarea
            bind:this={composer}
            bind:value={prompt}
            readonly={queueSending}
            aria-label="Task prompt"
            placeholder={project
              ? active
                ? `Steer ${agentLabel} while it works…  ⌘↵ to send`
                : `Message ${agentLabel}…  ⌘↵ to send`
              : `Open a project to start working with ${agentLabel}…`}
            disabled={!project || starting}
            onpaste={pasteImages}
            oninput={() => mentions.update(composer, !!project)}
            onclick={() => mentions.update(composer, !!project)}
            onblur={() => mentions.close()}
            aria-autocomplete="list"
            aria-controls={mentions.active ? 'mention-list' : undefined}
            aria-activedescendant={mentions.active && mentions.items.length
              ? `mention-option-${mentions.selected}`
              : undefined}
            onkeydown={(e) => {
              const mentioned = mentions.keydown(e);
              if (typeof mentioned === 'object') {
                run(() => pickMention(mentioned));
                return;
              }
              if (mentioned) return;
              if (
                !e.isComposing &&
                e.key === 'Enter' &&
                (e.metaKey || e.ctrlKey)
              ) {
                e.preventDefault();
                run(send);
              }
            }}
          ></textarea>
          {#if mode === 'plan'}<p class="mode-hint">
              Plan the approach first. Switch to Code when you’re ready to
              implement.
            </p>{/if}
          {#if threadId && mode === null && !runLoading && !restoring}<p
              class="mode-hint"
            >
              {agentLabel} hasn’t reported this conversation’s mode. Choose Plan or
              Code before sending.
            </p>{/if}
          <ComposerControls
            c={{
              agentLabel,
              harness: selectedHarness,
              multiAgent: !!settings?.claudeEnabled,
              navigationBusy,
              attaching,
              canAttach:
                !!project && !starting && !attaching && attachments.length < 8,
              canAddContext: !!currentTab() && !starting,
              canChangePermissions:
                !!project && !starting && !runLoading && !restoring,
              permissionsLabel:
                selectedHarness === 'claude'
                  ? 'Native permissions'
                  : threadId
                    ? threadSettings?.permissionProfile?.id
                      ? profileLabel(threadSettings.permissionProfile.id)
                      : 'Permissions'
                    : permissionDraft.permissions
                      ? profileLabel(permissionDraft.permissions)
                      : 'Permissions',
              mode,
              settingsLocked:
                starting || settingsBusy || runLoading || restoring,
              models,
              model,
              effort,
              selectedModel,
              reasoningEffort: capabilities.reasoningEffort,
              hasThread: !!threadId,
              canConnect: !busy && !!project,
              active,
              canSteer: capabilities.steer,
              canQueue:
                !navigationBusy &&
                !queued &&
                (!!prompt.trim() || !!attachments.length || !!contexts.length),
              queueSending,
              canSend:
                !!project &&
                (!!prompt.trim() ||
                  !!attachments.length ||
                  !!contexts.length) &&
                !starting &&
                !queueSending &&
                !attaching &&
                !runLoading &&
                !settingsBusy &&
                !(threadId !== null && mode === null) &&
                !restoring,
            }}
            onattach={() => run(attachFiles)}
            onaddcontext={() => {
              const tab = currentTab();
              if (tab)
                addContext({
                  id: crypto.randomUUID(),
                  label: tab.path,
                  text: `File: ${tab.path}`,
                });
            }}
            onharness={(next) => run(() => switchHarness(next))}
            onpermissions={() => (sessionPanel = 'permissions')}
            onmode={(next) => run(() => changeThreadSettings({ mode: next }))}
            onmodel={(next) => run(() => changeThreadSettings({ model: next }))}
            oneffort={(next) =>
              run(() => changeThreadSettings({ effort: next }))}
            onconnect={() => run(setupCodex)}
            onqueue={() => run(() => send(true))}
            onstop={() => run(stop)}
            onsend={() => run(send)}
          />
        </div>
      </footer>
    </main>
    {#if inspectorVisible}<PaneDivider
        label="Resize inspector"
        controls="changes-inspector"
        value={displayedRightWidth}
        min={300}
        max={rightLimit}
        defaultValue={400}
        reverse
        onresize={(value) => (rightWidth = value)}
        oncommit={savePaneSizes}
      />
      <InspectorPane
        changeCount={changedFiles.length}
        {diffSource}
        {active}
        project={!!project}
        {git}
        {gitBusy}
        hasTask={!!turn}
        planReady={latestPlan?.status === 'completed'}
        {selectedPath}
        controls={changeControls}
        list={changesList}
        detail={selectedChange}
        onclose={closeInspector}
        onreadplan={() => run(readPlan)}
        onrefresh={() => run(refreshGit)}
      />{/if}
  </div>
</div>

{#snippet explorerToggle()}{#if !leftOpen && !focusMode && view !== 'Changes' && view !== 'Runs' && view !== 'Settings'}<button
      class="icon-button"
      data-explorer-toggle
      aria-label="Show explorer"
      title="Show explorer"
      onclick={async () => {
        leftOpen = true;
        await tick();
        document
          .querySelector<HTMLButtonElement>(
            '#project-explorer button:not(:disabled)',
          )
          ?.focus();
      }}><Icon name="panel-left" size={16} /></button
    >{/if}{/snippet}
{#snippet paneControls()}<button
    class="focus-toggle"
    aria-label={focusMode ? 'Leave focus mode' : 'Enter focus mode'}
    aria-pressed={focusMode}
    title="Focus mode (⌘⇧F)"
    onclick={toggleFocus}
    ><Icon name="focus" size={15} />
    {focusMode ? 'Focused' : 'Focus'}</button
  >{#if view !== 'Settings' && project}<button
      class="icon-button"
      data-inspector-toggle
      aria-label={inspectorVisible ? 'Hide inspector' : 'Show inspector'}
      title={inspectorVisible ? 'Hide changes' : 'Show changes'}
      aria-expanded={inspectorVisible}
      onclick={async () => {
        if (compactLayout) {
          inspectorDrawer = !inspectorVisible;
          if (inspectorDrawer) {
            rightOpen = true;
            focusMode = false;
          }
        } else if (focusMode) {
          focusMode = false;
          rightOpen = true;
        } else rightOpen = !rightOpen;
        await tick();
        if (inspectorVisible)
          document
            .querySelector<HTMLButtonElement>(
              '#changes-inspector .pane-heading button',
            )
            ?.focus();
      }}><Icon name="panel-right" size={16} /></button
    >{/if}{/snippet}
{#snippet reviewControls()}<div class="review-controls">
    {@render changeControls()}<button
      disabled={gitBusy || !project || !git?.available}
      onclick={() => run(refreshGit)}
      >{gitBusy ? 'Refreshing…' : '↻ Refresh'}</button
    >
  </div>{/snippet}
{#snippet changeControls()}<div class="change-controls">
    <div class="segmented">
      <button
        class:chosen={diffSource === 'task'}
        onclick={() => (diffSource = 'task')}>Task</button
      ><button
        class:chosen={diffSource === 'repository'}
        disabled={!git?.available}
        onclick={() => (diffSource = 'repository')}>Repository</button
      >
    </div>
    {#if diffSource === 'repository'}<select
        aria-label="Git diff scope"
        bind:value={diffScope}
        ><option value="unstaged">Unstaged</option><option value="staged"
          >Staged</option
        ></select
      >{/if}
  </div>
  {#if (diffSource === 'task' && liveTruncated) || (diffSource === 'repository' && git?.truncated)}<p
      class="banner warning"
    >
      Diff truncated at 4 MiB. Review the full diff with Git.
    </p>{/if}{/snippet}
{#snippet changesList()}<div class="changed-files">
    {#each changedFiles as file}<button
        class:selected={selectedPath === file.path}
        onclick={() => (selectedPath = file.path)}
        ><span class="file-status-letter"
          >{file.status === 'added' || file.status === '??'
            ? 'A'
            : file.status === 'deleted'
              ? 'D'
              : 'M'}</span
        ><span class="truncate" title={file.path}
          >{file.path}{#if baseline.includes(file.path)}<small
              >Pre-existing change · attribution may overlap</small
            >{/if}</span
        ><span class="add-count">+{file.additions}</span><span
          class="delete-count">−{file.deletions}</span
        ></button
      >{/each}
  </div>{/snippet}
{#snippet selectedChange()}{#if selectedDiff && diffModule}{#await diffModule}<div
        class="view-skeleton compact"
        role="status"
        aria-label="Loading diff"
      >
        <span class="skeleton" style="width:60%"></span><span
          class="skeleton"
          style="width:80%"
        ></span><span class="skeleton" style="width:45%"></span>
      </div>{:then module}<module.default
        text={selectedDiff}
        path={selectedPath}
        onopen={open}
        oncontext={addContext}
      />{/await}{:else}<div class="diff-no-patch">
      <p class="mono">{selectedPath}</p>
      <p class="muted">
        {git?.files.find((f) => f.path === selectedPath)?.status === '??'
          ? 'Untracked file. Git does not include its content in a regular diff.'
          : 'No patch in this diff scope. Try the other scope or open the file.'}
      </p>
      <button onclick={() => open(selectedPath)}>Open file ↗</button>
    </div>{/if}{/snippet}
{#if dialog.resolve}<div class="modal-backdrop">
    <dialog
      use:activateDialog
      oncancel={(e) => {
        e.preventDefault();
        answer('Cancel');
      }}
      class="modal"
      aria-modal="true"
      aria-labelledby="dialog-title"
    >
      <h2 id="dialog-title">{dialog.title}</h2>
      <p>{dialog.message}</p>
      <div class="row">
        {#each dialog.choices as choice}<button
            class:primary={choice === dialog.choices[0]}
            onclick={() => answer(choice)}>{choice}</button
          >{/each}
      </div>
    </dialog>
  </div>{/if}
{#if treeMenu}<TreeMenu
    entry={treeMenu.entry}
    x={treeMenu.x}
    y={treeMenu.y}
    returnFocus={treeMenu.trigger}
    onclose={() => (treeMenu = null)}
    onaction={(action) => {
      const entry = treeMenu?.entry ?? null;
      treeMenu = null;
      run(() => treeAction(entry, action));
    }}
  />{/if}
<Toasts
  {toasts}
  ondismiss={dismissToast}
  onopen={(toast) => {
    dismissToast(toast.id);
    run(() => resume(toast.threadId));
  }}
/>
{#if mentions.active}<MentionMenu
    items={mentions.items}
    selected={mentions.selected}
    searching={mentions.searching}
    note={mentions.note}
    anchor={mentions.active.anchor}
    onhover={(index) => (mentions.selected = index)}
    onpick={(item) => run(() => pickMention(item))}
  />{/if}
{#if launcher}<CommandMenu
    entries={launchEntries}
    initialScope={launcher}
    projectName={project?.displayName ?? 'Bindaas'}
    loading={historyBusy}
    searching={launcherSearch.searching}
    onquery={(query, scope) => launcherSearch.query(query, scope)}
    onloadtasks={() => project && run(() => listThreads())}
    onclose={() => {
      launcher = null;
      launcherSearch.reset();
    }}
    onselect={selectDestination}
  />{/if}

{#if sessionPanel && project}
  {#key threadId ?? `${project.root}:${selectedHarness}`}<SessionPanel
      harness={selectedHarness}
      running={active}
      initialTab={sessionPanel}
      {threadId}
      root={project.root}
      branch={git?.branch ?? null}
      {status}
      {connection}
      settings={threadSettings}
      speedTarget={threadId
        ? {
            threadId,
            turnId: active ? (turn?.id ?? null) : null,
            title: conversationTitle,
          }
        : null}
      runningTasks={Object.entries(taskRuns)
        .filter(
          ([id, task]) =>
            harnessOf(id) === 'codex' && task.turn.status === 'inProgress',
        )
        .map(([id, task]) => ({
          threadId: id,
          turnId: task.turn.id,
          title: task.title,
        }))}
      draft={permissionDraft}
      locked={active ||
        !!approvals.length ||
        !!queued ||
        settingsBusy ||
        runLoading}
      onsettings={applyThreadSettings}
      ondraft={(value) => (permissionDraft = value)}
      onclose={() => (sessionPanel = null)}
    />{/key}
{/if}

{#if contextPreview}<dialog
    use:activateDialog
    class="modal context-preview"
    aria-label="Context preview"
    oncancel={() => (contextPreview = null)}
  >
    <div class="context-preview-heading">
      <div>
        <span class="eyebrow">INCLUDED IN YOUR MESSAGE</span>
        <h2>{contextPreview.label}</h2>
      </div>
      <button
        aria-label="Close context preview"
        onclick={() => (contextPreview = null)}>×</button
      >
    </div>
    <pre>{contextPreview.text.slice(0, 30000)}</pre>
    <footer>
      <span
        >{contextPreview.text.length.toLocaleString()} characters{contextPreview
          .text.length > 30000
          ? ' · preview shortened'
          : ''}</span
      ><button onclick={() => (contextPreview = null)}>Back to message</button>
    </footer>
  </dialog>{/if}

{#if attachmentPreview}
  {#key attachmentPreview.id}<AttachmentPreview
      attachment={attachmentPreview}
      returnFocus={attachmentPreviewTrigger}
      onclose={() => (attachmentPreview = null)}
      onremove={() => {
        attachments = attachments.filter((a) => a.id !== attachmentPreview?.id);
        attachmentPreview = null;
      }}
    />{/key}
{/if}
