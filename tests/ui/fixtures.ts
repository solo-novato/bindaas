// Shared Playwright fixtures: a mocked Tauri bridge plus scenario builders.
import { expect, type Page } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const auditReport = join(tmpdir(), 'bindaas-axe-report.json');

export async function mockDesktop(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    w.isTauri = true;
    const callbacks = new Map();
    const listeners = new Map();
    let next = 1;
    const files: Record<string, string> = {
      'hello.txt': 'before\n',
      'README.md':
        '# Hello Workbench\n\nA **real** preview.\n\n<script>alert(1)</script>\n\n[Other file](hello.txt)\n',
      'src/main.ts': 'export const hello = "world";\n',
    };
    let version = 1;
    // Folders known without files, plus project files only reachable through search.
    const dirs = new Set<string>(['src']);
    const searchable: Record<string, string> = {
      'src/lib/deep/util.ts': 'export const util = 1;\n',
      'docs/guide.md': '# Guide\n',
    };
    function listing(relative: string) {
      const prefix = relative ? `${relative}/` : '';
      const children = new Map<string, any>();
      for (const path of [...Object.keys(files), ...dirs]) {
        if (!path.startsWith(prefix) || path === relative) continue;
        const rest = path.slice(prefix.length);
        const name = rest.split('/')[0];
        const directory =
          rest.includes('/') ||
          dirs.has(prefix + name) ||
          !!children.get(name)?.directory;
        children.set(name, { name, path: prefix + name, directory });
      }
      return [...children.values()].sort(
        (a, b) =>
          Number(b.directory) - Number(a.directory) ||
          a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
      );
    }
    const exists = (path: string) =>
      path in files ||
      dirs.has(path) ||
      Object.keys(files).some((f) => f.startsWith(`${path}/`));
    const settings = {
      schemaVersion: 1,
      appearance: 'dark',
      onboardingComplete:
        localStorage.getItem('fixture-onboarding') !== 'pending',
      codexExecutablePath: null,
      codexIdleTimeoutSeconds: 300,
      recentProjects: [],
      projectState: {},
      lastModel: null,
      lastReasoningEffort: null,
      paneSizes: {},
    };
    const git = {
      available: true,
      branch: 'main',
      head: 'abc',
      files: [],
      unstaged: '',
      staged: '',
      truncated: false,
    };
    w.testSetGit = (patch: any) => Object.assign(git, patch);
    let serverSettings = JSON.parse(
      localStorage.getItem('fixture-codex-settings') ?? 'null',
    ) ?? {
      model: 'fixture',
      effort: 'medium',
      mode: 'default',
      sandbox: { type: 'workspaceWrite' },
      approvalPolicy: 'on-request',
      permissionProfile: { id: ':workspace', extends: null },
      cwd: '/fixture/project',
    };
    let turnSettings = { ...serverSettings };
    function patchSettings(patch: any) {
      for (const key of ['model', 'effort', 'mode', 'approvalPolicy'])
        if (patch[key] != null) serverSettings[key] = patch[key];
      if (patch.permissions) {
        serverSettings.permissionProfile = {
          id: patch.permissions,
          extends: null,
        };
        serverSettings.sandbox =
          patch.permissions === ':read-only'
            ? { type: 'readOnly', networkAccess: false }
            : patch.permissions === ':danger-full-access'
              ? { type: 'dangerFullAccess' }
              : {
                  type: 'workspaceWrite',
                  writableRoots: ['/fixture/project'],
                  networkAccess: false,
                };
      }
      localStorage.setItem(
        'fixture-codex-settings',
        JSON.stringify(serverSettings),
      );
      return { ...serverSettings };
    }
    const calls: any[] = [];
    w.testCalls = calls;
    const emit = (name: string, payload: any) => {
      for (const id of listeners.get(`agent://${name}`) ?? [])
        callbacks.get(id)?.({ event: `agent://${name}`, payload });
    };
    w.testEmit = emit;
    w.testDiskChange = (path: string, text: string) => {
      files[path] = text;
      version++;
    };
    function data(path: string) {
      return {
        path,
        content: files[path],
        encoding: 'utf8',
        sizeBytes: files[path]?.length ?? 0,
        newline: 'lf',
        fingerprint: {
          sizeBytes: files[path]?.length ?? 0,
          modifiedNanos: version,
          hash: files[path],
        },
        readOnlyRecommended: false,
      };
    }
    let turnId = 'turn-1';
    let turnSequence = 0;
    let generation = 1;
    const patch =
      'diff --git a/hello.txt b/hello.txt\n--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-before\n+after\n';
    function finish() {
      files['hello.txt'] = 'after\n';
      version++;
      Object.assign(git, {
        files: [{ path: 'hello.txt', status: '.M' }],
        unstaged: patch,
      });
      emit('timeline-item', {
        id: 'cmd',
        threadId: 'thread-1',
        turnId,
        kind: 'command',
        title: 'Command',
        status: 'completed',
        command: 'npm test',
        output: 'PASS fixture',
        exitCode: 0,
        durationMs: 24,
      });
      emit('timeline-item', {
        id: 'file',
        threadId: 'thread-1',
        turnId,
        kind: 'fileChange',
        title: 'File changes',
        status: 'completed',
        files: [{ path: 'hello.txt', diff: patch }],
      });
      emit('turn-diff', {
        threadId: 'thread-1',
        turnId,
        diff: patch,
        truncated: false,
      });
      emit('timeline-item', {
        id: 'agent',
        threadId: 'thread-1',
        turnId,
        kind: 'message',
        title: 'Codex',
        status: 'completed',
        text: w.testReply ?? 'Updated hello.txt and ran the tests.',
      });
      emit('turn-completed', {
        threadId: 'thread-1',
        turn: { id: turnId, status: 'completed', durationMs: 1234 },
      });
    }
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' } },
      transformCallback(fn: any) {
        const id = next++;
        callbacks.set(id, fn);
        return id;
      },
      unregisterCallback(id: number) {
        callbacks.delete(id);
      },
      async invoke(command: string, args: any = {}) {
        (w.testAgentCalls ??= []).push({ command, args });
        if (w.testAgentInvoke) {
          const result = await w.testAgentInvoke(command, args);
          if (result !== undefined) return result;
        }
        if (command.startsWith('agent_'))
          command = command.replace('agent_', 'codex_');
        if (args.threadId?.startsWith('codex:'))
          args = { ...args, threadId: args.threadId.slice(6) };
        calls.push({ command, args });
        if (command === 'plugin:event|listen') {
          const list = listeners.get(args.event) ?? [];
          list.push(args.handler);
          listeners.set(args.event, list);
          return args.handler;
        }
        if (command === 'plugin:event|unlisten') return;
        if (w.testConcurrentInvoke && command.startsWith('codex_')) {
          const result = await w.testConcurrentInvoke(command, args);
          if (result !== undefined) return result;
        }
        switch (command) {
          case 'attachments_pick':
            return (
              w.testAttachments ?? [
                { id: 'brief', name: 'brief.md', kind: 'file', sizeBytes: 120 },
                {
                  id: 'screen',
                  name: 'screen.png',
                  kind: 'image',
                  sizeBytes: 2048,
                },
              ]
            );
          case 'attachment_preview':
            if (w.testPreviewDelay)
              await new Promise<void>((resolve) => {
                w.testResolvePreview = resolve;
              });
            if (w.testPreviewError) throw new Error(w.testPreviewError);
            return (
              w.testAttachmentPreviews?.[args.id] ??
              (args.id === 'screen'
                ? {
                    kind: 'image',
                    dataUrl:
                      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l4sAAAAASUVORK5CYII=',
                  }
                : {
                    kind: 'text',
                    text: '# Attached brief\n\n<script>literal content</script>',
                    truncated: false,
                  })
            );
          case 'attachment_paste_image':
            return {
              id: 'pasted',
              name: args.name,
              kind: 'image',
              sizeBytes: args.bytes.length,
            };
          case 'notification_test':
            return;
          case 'settings_get':
            return {
              ...settings,
              ...(w.testSettingsPatch ?? {}),
              recentProjects: w.testRecentProjects ?? settings.recentProjects,
            };
          case 'settings_save':
            Object.assign(settings, args.value);
            return;
          case 'codex_get_state':
            return localStorage.getItem('fixture-active-restore')
              ? { type: 'ready', generation: 2, active: ['thread-1', 'turn-1'] }
              : { type: 'sleeping' };
          case 'project_pick_directory':
            return '/fixture/project';
          case 'project_open':
            if (w.testProjectOpenFailure)
              throw new Error('This project folder is no longer available.');
            return {
              root: '/fixture/project',
              displayName: 'fixture-project',
              git,
            };
          case 'file_list_directory':
            return { entries: listing(args.relativePath), truncated: false };
          case 'file_create': {
            const path = `${args.parent ? `${args.parent}/` : ''}${args.name}`;
            if (exists(path))
              throw Error(
                `‘${args.name.split('/').at(-1)}’ already exists here`,
              );
            const parts = path.split('/');
            for (let i = 1; i < parts.length; i++)
              dirs.add(parts.slice(0, i).join('/'));
            if (args.directory) dirs.add(path);
            else files[path] = '';
            version++;
            return path;
          }
          case 'file_rename': {
            const parent = args.relativePath.includes('/')
              ? args.relativePath.slice(
                  0,
                  args.relativePath.lastIndexOf('/') + 1,
                )
              : '';
            const target = parent + args.name;
            if (exists(target))
              throw Error(`‘${args.name}’ already exists here`);
            const move = (path: string) =>
              path === args.relativePath ||
              path.startsWith(`${args.relativePath}/`)
                ? target + path.slice(args.relativePath.length)
                : path;
            for (const key of Object.keys(files))
              if (move(key) !== key) {
                files[move(key)] = files[key];
                delete files[key];
              }
            for (const dir of [...dirs])
              if (move(dir) !== dir) {
                dirs.delete(dir);
                dirs.add(move(dir));
              }
            version++;
            return target;
          }
          case 'file_trash': {
            const gone = (path: string) =>
              path === args.relativePath ||
              path.startsWith(`${args.relativePath}/`);
            for (const key of Object.keys(files))
              if (gone(key)) delete files[key];
            for (const dir of [...dirs]) if (gone(dir)) dirs.delete(dir);
            version++;
            return;
          }
          case 'file_open_default':
            return;
          case 'codex_detect':
            if (w.testDetect instanceof Error) throw w.testDetect;
            return (
              w.testDetect ?? {
                path: '/opt/homebrew/bin/codex',
                version: '0.155.0',
                supported: true,
                minimum: '0.154.0',
              }
            );
          case 'codex_fuzzy_file_search': {
            if (w.testSearchFails) throw Error('Codex is not available');
            const query = String(args.query).toLowerCase();
            return [...Object.keys(files), ...Object.keys(searchable)]
              .map((path) => {
                const indices: number[] = [];
                let from = 0;
                for (const char of query) {
                  const at = path.toLowerCase().indexOf(char, from);
                  if (at < 0) return null;
                  indices.push(at);
                  from = at + 1;
                }
                return { path, fileName: path.split('/').at(-1), indices };
              })
              .filter(Boolean);
          }
          case 'codex_revert_thread':
            return { thread: { id: args.threadId } };
          case 'file_read':
            if (
              !(args.relativePath in files) &&
              args.relativePath in searchable
            )
              files[args.relativePath] = searchable[args.relativePath];
            if (!(args.relativePath in files)) throw Error('File missing');
            return data(args.relativePath);
          case 'file_stat':
            return data(args.relativePath).fingerprint;
          case 'file_save':
            if (args.expectedFingerprint.hash !== files[args.relativePath])
              throw Error('CONFLICT: File changed on disk');
            files[args.relativePath] = args.content;
            version++;
            return data(args.relativePath);
          case 'git_refresh':
            return git;
          case 'codex_get_models':
            emit('connection', { type: 'ready', generation });
            return [
              {
                id: 'fixture',
                model: 'fixture',
                displayName: 'Fixture Model',
                isDefault: true,
                supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
                defaultReasoningEffort: 'medium',
              },
            ];
          case 'codex_get_account':
            return {
              account: { type: 'chatgpt', email: 'fixture@example.test' },
              requiresOpenaiAuth: true,
            };
          case 'codex_start_turn': {
            if (w.testSendError) throw Error(w.testSendError);
            patchSettings(args);
            turnSettings = { ...serverSettings };
            turnId = `turn-${++turnSequence}`;
            emit('connection', { type: 'ready', generation });
            emit('baseline', { threadId: 'thread-1', git });
            emit('turn-started', {
              threadId: 'thread-1',
              settings: { ...turnSettings },
              turn: {
                id: turnId,
                status: 'inProgress',
                startedAt: Date.now() / 1000,
              },
            });
            setTimeout(() => {
              emit('timeline-item', {
                id: 'agent',
                threadId: 'thread-1',
                turnId,
                kind: 'message',
                title: 'Codex',
                status: 'inProgress',
                text: 'Inspecting the project.',
              });
              emit('timeline-item', {
                id: 'cmd',
                threadId: 'thread-1',
                turnId,
                kind: 'command',
                title: 'Command',
                status: 'inProgress',
                command: 'npm test',
                cwd: '/fixture/project',
              });
              if (args.prompt.includes('questions'))
                emit('approval-requested', {
                  requestId: 'question-1',
                  generation,
                  threadId: 'thread-1',
                  turnId,
                  itemId: 'question',
                  kind: 'userInput',
                  decisions: [],
                  questions: [
                    {
                      id: 'scope',
                      header: 'Scope',
                      question: 'Which scope should I use?',
                      options: [
                        {
                          label: 'Focused change (Recommended)',
                          description:
                            'Fix the affected page with a small patch.',
                        },
                        {
                          label: 'Full redesign',
                          description: 'Update every related page.',
                        },
                      ],
                    },
                    {
                      id: 'details',
                      header: 'Details',
                      question: 'Anything else to include?',
                      options: null,
                    },
                  ],
                });
              else if (args.prompt.includes('approval'))
                emit('approval-requested', {
                  requestId: '7',
                  generation,
                  threadId: 'thread-1',
                  turnId,
                  itemId: 'cmd',
                  kind: 'command',
                  reason: 'Run project tests',
                  command: 'npm test',
                  cwd: '/fixture/project',
                  network: { host: 'registry.npmjs.org', protocol: 'https' },
                  decisions: ['accept', 'decline', 'cancel'],
                });
              else if (args.prompt.includes('disconnect'))
                emit('connection', {
                  type: 'disconnected',
                  generation,
                  message: 'Fixture disconnect',
                });
              else finish();
            }, 80);
            return {
              threadId: 'thread-1',
              turn: {
                id: turnId,
                status: 'inProgress',
                startedAt: Date.now() / 1000,
              },
              settings: { ...serverSettings },
            };
          }
          case 'codex_respond_server_request':
            emit('approval-resolved', { requestId: args.requestId });
            setTimeout(finish, 20);
            return;
          case 'codex_interrupt_turn':
            emit('turn-completed', {
              threadId: 'thread-1',
              turn: { id: turnId, status: 'interrupted' },
            });
            return;
          case 'codex_sleep_now':
            generation++;
            emit('connection', { type: 'sleeping', generation });
            return;
          case 'codex_list_threads':
            if (w.testThreadListError)
              throw new Error('History is temporarily unavailable');
            if (w.testRunThreads) {
              const data = JSON.parse(
                JSON.stringify(
                  args.cursor ? (w.testRunNextThreads ?? []) : w.testRunThreads,
                ),
              );
              if (w.testThreadListDelay)
                await new Promise((resolve) =>
                  setTimeout(resolve, w.testThreadListDelay),
                );
              return {
                data,
                nextCursor:
                  !args.cursor && w.testRunNextThreads ? 'older-page' : null,
              };
            }
            return {
              data: [
                {
                  id: 'thread-1',
                  preview: 'Fix hello',
                  cwd: '/fixture/project',
                  updatedAt: 1,
                  createdAt: 1,
                  status: { type: 'idle' },
                },
              ],
              nextCursor: null,
            };
          case 'codex_permission_options':
            emit('connection', { type: 'ready', generation });
            if (w.testOptionsError) throw Error(w.testOptionsError);
            return {
              profiles: [
                { id: ':read-only', description: null, allowed: true },
                { id: ':workspace', description: null, allowed: true },
                {
                  id: ':danger-full-access',
                  description: null,
                  allowed: !w.testManaged,
                },
              ],
              approvalPolicies: w.testManaged
                ? ['untrusted', 'on-request']
                : ['untrusted', 'on-request', 'never'],
            };
          case 'codex_set_permissions': {
            if (w.testPermissionError) throw Error(w.testPermissionError);
            const settings = patchSettings(args);
            emit('thread-settings', {
              threadId: args.threadId,
              generation,
              settings,
            });
            return settings;
          }
          case 'codex_session_status':
            emit('connection', { type: 'ready', generation });
            return {
              generation,
              thread: args.threadId
                ? {
                    id: args.threadId,
                    preview: 'Fix hello',
                    cwd: '/fixture/project',
                  }
                : null,
              settings: args.threadId ? { ...serverSettings } : null,
              usage:
                w.testNoUsage || !args.threadId
                  ? null
                  : {
                      total: {
                        totalTokens: 12500,
                        inputTokens: 10000,
                        cachedInputTokens: 3000,
                        outputTokens: 2500,
                      },
                      last: {
                        totalTokens: 2500,
                        inputTokens: 2000,
                        cachedInputTokens: 1000,
                        outputTokens: 500,
                      },
                      modelContextWindow: 100000,
                    },
            };
          case 'codex_account_status':
            return {
              generation,
              account: {
                type: 'chatgpt',
                email: 'fixture@example.test',
                planType: 'pro',
              },
              limitsError: w.testLimitsError ?? null,
              accountError: null,
              limits: w.testLimitsError
                ? null
                : {
                    ordinaryUsageAllowed: true,
                    buckets: [
                      {
                        id: 'codex',
                        name: 'Codex',
                        plan: 'pro',
                        primary: {
                          usedPercent: 25,
                          windowDurationMins: 300,
                          resetsAt: 2000000000,
                        },
                        secondary: {
                          usedPercent: 5,
                          windowDurationMins: 10080,
                          resetsAt: 2000500000,
                        },
                      },
                    ],
                  },
            };
          case 'codex_update_thread_settings': {
            if (w.testModeChangeFailure)
              throw new Error('Could not change Codex mode');
            const settings = patchSettings(args);
            emit('thread-settings', {
              threadId: args.threadId,
              generation,
              settings,
            });
            return settings;
          }
          case 'codex_resume_thread':
            if (w.testThreadSettings)
              serverSettings = { ...w.testThreadSettings };
            return {
              approvals: localStorage.getItem('fixture-active-restore')
                ? [
                    {
                      requestId: 'pending-question',
                      generation: 2,
                      threadId: 'thread-1',
                      turnId: 'turn-1',
                      kind: 'userInput',
                      decisions: [],
                      questions: [
                        {
                          id: 'confirm',
                          header: 'Confirm',
                          question: 'Continue this approach?',
                          options: [
                            {
                              label: 'Continue',
                              description: 'Use the current approach.',
                            },
                          ],
                        },
                      ],
                    },
                  ]
                : [],
              thread: {
                id: 'thread-1',
                name: localStorage.getItem('fixture-thread-name'),
              },
              settings: { ...serverSettings },
            };
          case 'codex_thread_turns':
            return {
              data: [
                {
                  id: turnId,
                  status: localStorage.getItem('fixture-active-restore')
                    ? 'inProgress'
                    : 'completed',
                  durationMs: 1234,
                  settings: { ...turnSettings },
                  items: [{ kind: 'user', text: 'Fix hello' }],
                },
              ],
              nextCursor: null,
            };
          case 'codex_turn_items':
            return {
              data: [
                {
                  id: 'old-user',
                  threadId: 'thread-1',
                  turnId,
                  kind: 'user',
                  title: 'You',
                  status: 'completed',
                  text: 'Fix hello',
                },
                {
                  id: 'old-agent',
                  threadId: 'thread-1',
                  turnId,
                  kind: 'message',
                  title: 'Codex',
                  status: 'completed',
                  text: 'Historical result from Codex.',
                },
              ],
              nextCursor: null,
            };
          case 'open_external':
            return;
          default:
            return null;
        }
      },
    };
  });
}

export async function openProject(page: Page) {
  await page
    .getByRole('button', { name: 'Open a project', exact: true })
    .click();
  await expect(
    page.getByText('fixture-project', { exact: true }).first(),
  ).toBeVisible();
}

export async function resumeFixture(page: Page) {
  await openProject(page);
  await page.getByRole('button', { name: 'Runs', exact: true }).click();
  await page.getByRole('button', { name: /Fix hello/ }).click();
}

export async function concurrentFixture(page: Page) {
  await openProject(page);
  await page.evaluate(() => {
    const w = window as any;
    const threads: Record<string, any> = {};
    let number = 0;
    const settings = (id: string) => ({
      model: `model-${id}`,
      serviceTier: threads[id]?.tier ?? null,
      effort: 'high',
      mode: 'plan',
      sandbox: { type: 'workspaceWrite' },
      approvalPolicy: 'on-request',
    });
    w.concurrentThreads = threads;
    w.testEmit('connection', { type: 'ready', generation: 1 });
    w.concurrentFinish = (id: string) => {
      const t = threads[id];
      t.turn.status = 'completed';
      t.approvals = [];
      const item = {
        id: 'answer',
        threadId: id,
        turnId: t.turn.id,
        kind: 'message',
        title: 'Codex',
        text: `Answer for ${t.title}`,
        status: 'completed',
      };
      t.items.push(item);
      w.testEmit('timeline-item', item);
      w.testEmit('turn-completed', { threadId: id, turn: { ...t.turn } });
    };
    w.testConcurrentInvoke = (command: string, args: any) => {
      const t = threads[args.threadId];
      if (command === 'codex_manage_thread') {
        if (w.testManagementError) throw Error(w.testManagementError);
        if (args.action === 'rename') {
          t.name = args.name;
          w.testEmit('thread-name', { threadId: t.id, name: t.name });
        } else {
          t.archived = args.action === 'archive';
          if (t.archived)
            w.testEmit('thread-archived', { threadId: t.id, generation: 1 });
        }
        return {};
      }
      if (command === 'codex_steer_turn') {
        return new Promise((resolve, reject) =>
          setTimeout(() => {
            if (w.testSteerError) return reject(Error(w.testSteerError));
            const item = {
              id: `steered-${Date.now()}`,
              clientId: args.clientUserMessageId,
              threadId: t.id,
              turnId: t.turn.id,
              kind: 'user',
              title: 'You',
              status: 'completed',
              text: args.prompt,
            };
            if (!w.testHoldSteer) {
              t.items.push(item);
              w.testEmit('timeline-item', item);
            } else w.heldSteers = [...(w.heldSteers ?? []), item];
            resolve({ turnId: args.turnId });
          }, w.testSteerDelay ?? 0),
        );
      }
      if (command === 'codex_session_status')
        return {
          generation: 1,
          thread: t ? { id: t.id, name: t.title } : null,
          settings: t ? settings(t.id) : null,
          usage: null,
        };
      if (command === 'codex_set_speed') {
        if (w.testSpeedError) throw Error(w.testSpeedError);
        return new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                generation: 1,
                results: args.targets.map((target: any) => {
                  const thread = threads[target.threadId];
                  const futureFailed =
                    w.testSpeedPartial && target.threadId === 'concurrent-2';
                  if (!futureFailed) {
                    thread.tier = args.fast ? 'priority' : 'default';
                    w.testEmit('thread-settings', {
                      generation: 1,
                      threadId: thread.id,
                      settings: settings(thread.id),
                    });
                  }
                  return {
                    ...target,
                    future: futureFailed ? 'failed' : 'saved',
                    active: !target.turnId
                      ? 'notTargeted'
                      : w.testSpeedPartial
                        ? target.threadId === 'concurrent-1'
                          ? 'failed'
                          : 'targetUnavailable'
                        : 'applied',
                    futureError: futureFailed ? 'Future speed rejected' : null,
                    activeError:
                      w.testSpeedPartial && target.threadId === 'concurrent-1'
                        ? 'Live speed unsupported'
                        : null,
                    settings: settings(thread.id),
                  };
                }),
              }),
            w.testSpeedDelay ?? 0,
          ),
        );
      }
      if (command === 'codex_start_turn') {
        const id = args.threadId ?? `concurrent-${++number}`;
        const thread = (threads[id] ??= {
          id,
          title: args.prompt,
          items: [],
          approvals: [],
        });
        if (thread.turn?.status === 'inProgress')
          throw Error('This thread is busy');
        thread.turn = {
          id: `turn-${id}-${Date.now()}`,
          status: 'inProgress',
          settings: settings(id),
        };
        thread.items.push({
          id: `user-${thread.turn.id}`,
          turnId: thread.turn.id,
          threadId: id,
          kind: 'user',
          title: 'You',
          status: 'completed',
          text: args.prompt,
        });
        w.testEmit('baseline', {
          threadId: id,
          git: { available: false, files: [] },
        });
        w.testEmit('turn-started', {
          threadId: id,
          turn: { ...thread.turn },
          settings: settings(id),
        });
        return {
          threadId: id,
          turn: { ...thread.turn },
          settings: settings(id),
        };
      }
      if (command === 'codex_get_state')
        return {
          type: 'ready',
          generation: 1,
          activeThreads: Object.fromEntries(
            Object.values(threads)
              .filter((t: any) => t.turn.status === 'inProgress')
              .map((t: any) => [t.id, t.turn.id]),
          ),
        };
      if (command === 'codex_resume_thread')
        return {
          thread: { id: t.id, preview: t.title, name: t.name },
          settings: settings(t.id),
          approvals: t.approvals,
        };
      if (command === 'codex_thread_turns')
        return { data: [{ ...t.turn }], nextCursor: null };
      if (command === 'codex_turn_items')
        return { data: [...t.items], nextCursor: null };
      if (command === 'codex_list_threads')
        return {
          data: Object.values(threads)
            .filter((t: any) => !!t.archived === !!args.archived)
            .map((t: any) => ({
              id: t.id,
              preview: t.title,
              name: t.name,
              updatedAt: 1,
            })),
          nextCursor: null,
        };
      if (command === 'codex_interrupt_turn') {
        t.turn.status = 'interrupted';
        t.approvals = [];
        w.testEmit('turn-completed', { threadId: t.id, turn: { ...t.turn } });
        return {};
      }
      if (command === 'codex_respond_server_request') {
        for (const t of Object.values(threads) as any[])
          t.approvals = t.approvals.filter(
            (a: any) => a.requestId !== args.requestId,
          );
        w.testEmit('approval-resolved', {
          requestId: args.requestId,
          threadId: 'concurrent-1',
          waiting: false,
        });
        return {};
      }
    };
  });
}

export const reviewPatch = [
  'diff --git a/src/main.ts b/src/main.ts',
  '--- a/src/main.ts',
  '+++ b/src/main.ts',
  '@@ -1,2 +1,2 @@',
  '-const enabled = false;',
  '+const enabled = true;',
  ' export { enabled };',
  '@@ -30 +30 @@',
  '-const retries = 1;',
  '+const retries = 3;',
  'diff --git a/README.md b/README.md',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1 +1 @@',
  '-# Old guide',
  '+# Updated guide',
  '',
].join('\n');

export async function reviewFixture(page: Page, patch = reviewPatch) {
  await concurrentFixture(page);
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Improve startup and document it');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.evaluate((diff) => {
    const w = window as any;
    const thread = w.concurrentThreads['concurrent-1'];
    w.testEmit('baseline', {
      threadId: thread.id,
      git: { available: true, files: [{ path: 'src/main.ts', status: ' M' }] },
    });
    w.testSetGit({
      available: true,
      unstaged: diff,
      files: [
        { path: 'src/main.ts', status: ' M' },
        { path: 'README.md', status: ' M' },
      ],
    });
    w.testEmit('turn-diff', {
      threadId: thread.id,
      turnId: thread.turn.id,
      diff,
      truncated: false,
    });
    w.testEmit('timeline-item', {
      id: 'check',
      threadId: thread.id,
      turnId: thread.turn.id,
      kind: 'command',
      title: 'Command',
      command: 'npm test',
      exitCode: 1,
      status: 'completed',
    });
  }, patch);
  await page
    .getByRole('button', { name: /^Changes/ })
    .first()
    .click();
  await expect(
    page.getByRole('region', { name: 'Change review' }),
  ).toBeVisible();
}

export async function longConversation(page: Page) {
  await concurrentFixture(page);
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Inspect the request pipeline');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.evaluate(() => {
    const w = window as any;
    const t = w.concurrentThreads['concurrent-1'];
    for (let n = 0; n < 150; n++) {
      const item = {
        id: `read-${n}`,
        threadId: t.id,
        turnId: t.turn.id,
        kind: n === 80 ? 'command' : 'message',
        title: 'Codex',
        phase: 'commentary',
        status: 'completed',
        text: `Checkpoint ${n}\n\nInspected the request pipeline and its validation paths.\n\n${n === 85 || n === 95 ? 'Matching needle' : 'Recorded context'} for this part of the task.`,
        ...(n === 80
          ? {
              command: 'npm run check',
              exitCode: 0,
              output: 'Typecheck complete\nNo errors found',
            }
          : {}),
      };
      t.items.push(item);
      w.testEmit('timeline-item', item);
    }
  });
  await expect(page.locator('.message .markdown').last()).toBeVisible();
  await page.evaluate(() => {
    const node = document.querySelector('.timeline')!;
    const row = Array.from(
      node.querySelectorAll<HTMLElement>('[data-reading-key]'),
    ).find((r) => r.dataset.readingKey?.endsWith(':read-90'))!;
    node.scrollTop +=
      row.getBoundingClientRect().top - node.getBoundingClientRect().top - 12;
  });
  await expect(
    page.getByRole('button', { name: 'Jump to latest ↓' }),
  ).toBeVisible();
}

export async function readingOffset(page: Page, id = ':read-90') {
  return page.evaluate((suffix) => {
    const node = document.querySelector('.timeline')!;
    const row = Array.from(
      node.querySelectorAll<HTMLElement>('[data-reading-key]'),
    ).find((r) => r.dataset.readingKey?.endsWith(suffix));
    return row
      ? row.getBoundingClientRect().top - node.getBoundingClientRect().top
      : -10000;
  }, id);
}

export async function switchTask(page: Page, title: string) {
  await page.getByRole('button', { name: 'Browse tasks', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Search actions, tasks, and files' })
    .fill(title);
  await page.getByRole('option').filter({ hasText: title }).click();
}

export async function proposedPlanFixture(page: Page) {
  await concurrentFixture(page);
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Plan the request pipeline');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.evaluate(() => {
    const w = window as any;
    const t = w.concurrentThreads['concurrent-1'];
    w.testEmit('timeline-update', [
      {
        itemId: 'proposal',
        threadId: t.id,
        turnId: t.turn.id,
        kind: 'plan',
        delta: '# Streaming proposal\n\nDraft approach.',
      },
    ]);
    w.testEmit('timeline-item', {
      id: 'progress',
      threadId: t.id,
      turnId: t.turn.id,
      kind: 'planProgress',
      title: 'Task progress',
      status: 'recorded',
      steps: [
        { step: 'Inspect request handling', status: 'completed' },
        { step: 'Prepare proposal', status: 'inProgress' },
      ],
    });
  });
}

export async function completePlan(page: Page, truncated = false) {
  await page.evaluate((truncated) => {
    const w = window as any;
    const t = w.concurrentThreads['concurrent-1'];
    const item = {
      id: 'proposal',
      threadId: t.id,
      turnId: t.turn.id,
      kind: 'plan',
      title: 'Proposed plan',
      status: 'completed',
      text: '# Request pipeline plan\n\n1. Reuse the existing handler.\n2. Validate the public interface.\n\n## Verification\nRun the regression checks before reviewing the patch.',
      truncated,
    };
    t.items.push(item);
    w.testEmit('timeline-item', item);
    t.turn.status = 'completed';
    w.testEmit('turn-completed', { threadId: t.id, turn: { ...t.turn } });
    w.testEmit('timeline-update', [
      {
        itemId: 'proposal',
        threadId: t.id,
        turnId: t.turn.id,
        kind: 'plan',
        delta: '\nLATE DRAFT MUST NOT APPEAR',
      },
    ]);
  }, truncated);
}

export async function installClaudeFixture(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    const ref = 'claude:11111111-1111-4111-8111-111111111111';
    const native = {
      model: 'fixture-claude',
      effort: null,
      mode: 'default',
      sandbox: null,
      approvalPolicy: 'acceptEdits',
      permissionProfile: null,
    };
    let turn: any = null,
      items: any[] = [],
      approvals: any[] = [],
      sequence = 0;
    const history = {
      id: ref,
      name: 'Claude terminal conversation',
      preview: 'Imported from the native CLI',
      cwd: '/fixture/project',
      createdAt: 1,
      updatedAt: 2,
      status: { type: 'notLoaded' },
      runStatus: 'unknown',
      model: 'fixture-claude',
    };
    const emit = (name: string, p: any) =>
      w.testEmit(name, {
        harness: 'claude',
        threadId: ref,
        generation: 1,
        ...p,
      });
    w.testClaudeRef = ref;
    w.testClaudeFinish = () => {
      turn = { ...turn, status: 'completed', settings: native };
      approvals = [];
      emit('turn-completed', { turn });
    };
    w.testClaudeQuestion = () => {
      const q = {
        requestId: `claude:${ref.slice(7)}:question`,
        threadId: ref,
        generation: 1,
        turnId: turn.id,
        itemId: 'question',
        kind: 'userInput',
        decisions: [],
        questions: [
          {
            id: '0',
            header: 'Checks',
            question: 'Which checks should Claude run?',
            multiSelect: true,
            options: [
              { label: 'Unit', description: 'Fast checks' },
              { label: 'Integration', description: 'End-to-end checks' },
            ],
          },
        ],
      };
      approvals = [q];
      emit('approval-requested', q);
    };
    w.testAgentInvoke = (command: string, args: any) => {
      if (command === 'agent_connect_claude') {
        if (w.testClaudeConnectError) throw Error(w.testClaudeConnectError);
        w.testSettingsPatch = { claudeEnabled: true };
        return {
          authenticated: true,
          version: '2.1.274',
          authMethod: 'claude.ai',
        };
      }
      if (command === 'agent_disconnect_claude') {
        if (turn?.status === 'inProgress')
          throw Error('Finish or stop Claude tasks before disconnecting');
        w.testSettingsPatch = { claudeEnabled: false };
        return null;
      }
      if (
        command === 'agent_list_threads' &&
        w.testSettingsPatch?.claudeEnabled
      )
        return { data: [history], nextCursor: null };
      if (args.harness === 'claude') {
        if (command === 'agent_get_models')
          return [
            {
              id: 'fixture-claude',
              model: 'fixture-claude',
              displayName: 'Fixture Claude',
              isDefault: true,
              supportedReasoningEfforts: [],
              defaultReasoningEffort: '',
            },
          ];
        if (command === 'agent_get_account')
          return { account: { type: 'claude.ai' }, requiresOpenaiAuth: true };
        if (command === 'agent_account_status')
          return {
            account: { type: 'claude.ai' },
            limits: null,
            generation: 0,
          };
        if (command === 'agent_permission_options')
          return { profiles: [], approvalPolicies: [] };
      }
      if (args.threadId === ref) {
        if (command === 'agent_resume_thread')
          return { thread: history, settings: native, approvals };
        if (command === 'agent_thread_turns')
          return { data: turn ? [turn] : [], nextCursor: null };
        if (command === 'agent_turn_items')
          return { data: items, nextCursor: null };
        if (command === 'agent_session_status')
          return {
            thread: history,
            settings: native,
            usage: null,
            generation: 1,
          };
        if (command === 'agent_update_thread_settings') {
          Object.assign(native, args);
          return { ...native };
        }
        if (command === 'agent_respond_server_request') {
          approvals = [];
          emit('approval-resolved', {
            requestId: args.requestId,
            waiting: false,
          });
          return null;
        }
        if (command === 'agent_interrupt_turn') {
          turn.status = 'interrupted';
          emit('turn-completed', { turn });
          return null;
        }
      }
      if (
        command === 'agent_start_turn' &&
        (args.harness === 'claude' || args.threadId === ref)
      ) {
        turn = {
          id: `claude-turn-${++sequence}`,
          status: 'inProgress',
          settings: { ...native },
        };
        const item = {
          id: `claude-user-${sequence}`,
          threadId: ref,
          turnId: turn.id,
          kind: 'user',
          title: 'You',
          status: 'completed',
          text: args.prompt,
        };
        items.push(item);
        emit('connection', { type: 'ready' });
        emit('turn-started', { turn });
        emit('timeline-item', item);
        return { threadId: ref, turn, settings: { ...native } };
      }
      return undefined;
    };
  });
}

export async function connectClaude(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('button', { name: 'Connect Claude Code', exact: true })
    .click();
  await expect(
    page.getByText('Connected · Available for new conversations'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
}

export const runningAnimations = (page: Page, infiniteOnly = false) =>
  page.evaluate(
    (infinite) =>
      document
        .getAnimations()
        .filter(
          (a) =>
            a.playState === 'running' &&
            (!infinite || a.effect?.getTiming().iterations === Infinity),
        ).length,
    infiniteOnly,
  );
