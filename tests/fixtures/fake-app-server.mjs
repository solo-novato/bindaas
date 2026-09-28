#!/usr/bin/env node
// Deterministic protocol fixture. No model calls, login, shell execution, or network.
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
let resumeCount = 0;
let lastResumeParams = null;
let lastTurnsParams = null;
let threadName = null;
let threadSettings = {
  model: 'fixture-model',
  effort: 'medium',
  collaborationMode: {
    mode: 'default',
    settings: {
      model: 'fixture-model',
      reasoning_effort: 'medium',
      developer_instructions: null,
    },
  },
  sandboxPolicy: { type: 'readOnly' },
  approvalPolicy: 'never',
  approvalsReviewer: 'user',
};
let initialized = false,
  handshake = false,
  cwd = process.cwd(),
  active = null,
  approval = null,
  turnNumber = 0;
const history = [];
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method, params) => emit({ method, params });
const reply = (id, result) => emit({ id, result });
const thread = () => ({
  id: 'fixture-thread',
  name: threadName,
  cwd,
  preview: 'Fixture task',
  model: threadSettings.model,
  reasoningEffort: threadSettings.effort,
  createdAt: 1,
  updatedAt: 2,
  status: { type: active ? 'active' : 'idle' },
  turns: history,
});
const patch =
  'diff --git a/hello.txt b/hello.txt\n--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-before\n+after\n';
function item(type, id, extra = {}) {
  return { type, id, ...extra };
}
function eventItem(value, completed = false) {
  notify(completed ? 'item/completed' : 'item/started', {
    threadId: 'fixture-thread',
    turnId: active.id,
    item: value,
  });
  if (completed) active.items.push(value);
}
function complete(status = 'completed') {
  if (!active) return;
  active.status = status;
  active.completedAt = Date.now() / 1000;
  active.durationMs = 50;
  if (status === 'failed') active.error = { message: 'Fixture turn failed' };
  history.unshift(active);
  notify('turn/completed', {
    threadId: 'fixture-thread',
    turn: { ...active, items: [] },
  });
  active = null;
}
function finish() {
  const command = item('commandExecution', 'command', {
    command: 'npm test',
    cwd,
    status: 'completed',
    aggregatedOutput: 'PASS deterministic fixture\n',
    exitCode: 0,
    durationMs: 25,
  });
  eventItem(command, true);
  fs.writeFileSync(path.join(cwd, 'hello.txt'), 'after\n');
  eventItem(
    item('fileChange', 'files', {
      changes: [{ path: 'hello.txt', kind: { type: 'update' }, diff: patch }],
      status: 'completed',
    }),
    true,
  );
  notify('turn/diff/updated', {
    threadId: 'fixture-thread',
    turnId: active.id,
    diff: patch,
  });
  eventItem(
    item('agentMessage', 'agent', {
      text: 'Updated hello.txt and verified it.',
      phase: 'final_answer',
    }),
    true,
  );
  complete();
}
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (!request.method) {
    if (approval && request.id === approval.id) {
      const decision = request.result?.decision;
      if (
        !['accept', 'decline', 'cancel', 'acceptForSession'].includes(decision)
      ) {
        process.exit(12);
      }
      notify('serverRequest/resolved', {
        threadId: 'fixture-thread',
        requestId: approval.id,
      });
      approval = null;
      if (decision === 'cancel' || decision === 'decline')
        complete('interrupted');
      else finish();
    }
    return;
  }
  const { id, method, params: p = {} } = request;
  if (method === 'initialize') {
    if (handshake) {
      emit({ id, error: { code: -1, message: 'Already initialized' } });
      return;
    }
    handshake = true;
    reply(id, { userAgent: 'fixture' });
    return;
  }
  if (method === 'initialized') {
    if (!handshake) process.exit(13);
    initialized = true;
    return;
  }
  if (!initialized) {
    emit({ id, error: { code: -1, message: 'Not initialized' } });
    return;
  }
  switch (method) {
    case 'model/list':
      reply(id, {
        data: [
          {
            id: 'fixture-model',
            model: 'fixture-model',
            displayName: 'Fixture model',
            hidden: false,
            isDefault: true,
            supportedReasoningEfforts: [
              { reasoningEffort: 'medium', description: 'Balanced' },
            ],
            defaultReasoningEffort: 'medium',
          },
        ],
        nextCursor: null,
      });
      break;
    case 'account/read':
      reply(id, {
        account: { type: 'chatgpt', email: 'fixture@example.test' },
        requiresOpenaiAuth: true,
      });
      break;
    case 'account/login/start':
      reply(id, {
        type: 'chatgpt',
        loginId: 'fixture-login',
        authUrl: 'https://example.test/login',
      });
      setTimeout(
        () =>
          notify('account/login/completed', {
            loginId: 'fixture-login',
            success: true,
          }),
        20,
      );
      break;
    case 'account/login/cancel':
      reply(id, {});
      break;
    case 'thread/start':
      cwd = p.cwd;
      notify('thread/started', { thread: thread() });
      reply(id, {
        thread: thread(),
        model: 'fixture-model',
        sandbox: { type: 'workspaceWrite' },
        approvalPolicy: 'on-request',
      });
      break;
    case 'thread/name/set':
      threadName = p.name ?? null;
      notify('thread/name/updated', {
        threadId: 'fixture-thread',
        ...(threadName == null ? {} : { threadName }),
      });
      reply(id, {});
      break;
    case 'thread/resume':
      resumeCount++;
      lastResumeParams = p;
      cwd = p.cwd ?? cwd;
      reply(id, {
        thread: thread(),
        model: 'fixture-model',
        sandbox: { type: 'workspaceWrite' },
        approvalPolicy: 'on-request',
      });
      break;
    case 'permissionProfile/list':
      reply(id, {
        data: [
          { id: ':read-only', description: null, allowed: true },
          { id: ':workspace', description: null, allowed: true },
          { id: ':danger-full-access', description: null, allowed: false },
        ],
        nextCursor: null,
      });
      break;
    case 'configRequirements/read':
      reply(id, {
        requirements: { allowedApprovalPolicies: ['untrusted', 'on-request'] },
      });
      break;
    case 'thread/settings/update':
      if (p.permissions) {
        threadSettings.activePermissionProfile = {
          id: p.permissions,
          extends: null,
        };
        threadSettings.sandboxPolicy =
          p.permissions === ':read-only'
            ? { type: 'readOnly', networkAccess: false }
            : {
                type: 'workspaceWrite',
                writableRoots: [cwd],
                networkAccess: false,
              };
      }
      if (p.approvalPolicy) threadSettings.approvalPolicy = p.approvalPolicy;
      if (p.model) threadSettings.model = p.model;
      if (p.effort) threadSettings.effort = p.effort;
      if (p.collaborationMode) {
        threadSettings.collaborationMode = p.collaborationMode;
        threadSettings.model = p.collaborationMode.settings.model;
        threadSettings.effort = p.collaborationMode.settings.reasoning_effort;
      }
      reply(id, {});
      notify('thread/settings/updated', {
        threadId: 'fixture-thread',
        threadSettings,
      });
      break;
    case 'thread/read':
      reply(id, {
        thread: thread(),
        testResumeCount: resumeCount,
        testLastResumeParams: lastResumeParams,
        testLastTurnsParams: lastTurnsParams,
      });
      break;
    case 'thread/list':
      reply(id, { data: [thread()], nextCursor: null });
      break;
    case 'thread/turns/list':
      lastTurnsParams = p;
      reply(id, {
        data: active ? [active, ...history] : history,
        nextCursor: null,
      });
      break;
    case 'thread/items/list':
      reply(id, {
        data: (history.find((t) => t.id === p.turnId)?.items ?? []).map(
          (item) => ({ item, turnId: p.turnId }),
        ),
        nextCursor: null,
      });
      break;
    case 'turn/interrupt':
      reply(id, {});
      complete('interrupted');
      break;
    case 'turn/start': {
      if (active) {
        emit({ id, error: { code: -1, message: 'Turn already active' } });
        break;
      }
      const prompt = p.input[0].text;
      active = {
        id: `fixture-turn-${++turnNumber}`,
        status: 'inProgress',
        startedAt: Date.now() / 1000,
        items: [],
      };
      reply(id, { turn: { ...active } });
      notify('turn/started', {
        threadId: 'fixture-thread',
        turn: { ...active },
      });
      notify('thread/tokenUsage/updated', {
        threadId: 'fixture-thread',
        turnId: active.id,
        tokenUsage: {
          total: {
            totalTokens: 2200,
            inputTokens: 2000,
            cachedInputTokens: 1000,
            outputTokens: 200,
          },
          last: {
            totalTokens: 1100,
            inputTokens: 1000,
            cachedInputTokens: 500,
            outputTokens: 100,
          },
          modelContextWindow: 128000,
        },
      });
      eventItem(item('userMessage', 'user', { content: p.input }), true);
      if (prompt === 'propose-plan') {
        eventItem(item('plan', 'proposal', { text: '' }));
        notify('item/plan/delta', {
          threadId: 'fixture-thread',
          turnId: active.id,
          itemId: 'proposal',
          delta: 'Draft approach',
        });
        notify('turn/plan/updated', {
          threadId: 'fixture-thread',
          turnId: active.id,
          explanation: 'Checking prerequisites',
          plan: [
            { step: 'Inspect the project', status: 'completed' },
            { step: 'Write the proposal', status: 'inProgress' },
          ],
        });
        eventItem(
          item('plan', 'proposal', {
            text: '# Final proposal\n\nUse the existing request pipeline.',
          }),
          true,
        );
        complete();
        break;
      }

      eventItem(
        item('reasoning', 'private', {
          summary: ['Checking the project.'],
          content: ['NEVER_RENDER_THIS'],
        }),
        true,
      );
      eventItem(item('agentMessage', 'agent', { text: '' }));
      for (let i = 0; i < 100; i++)
        notify('item/agentMessage/delta', {
          threadId: 'fixture-thread',
          turnId: active.id,
          itemId: 'agent',
          delta: 'hello ',
        });
      eventItem(
        item('commandExecution', 'command', {
          command: 'npm test',
          cwd,
          status: 'inProgress',
        }),
      );
      if (prompt.includes('disconnect')) {
        setTimeout(() => process.exit(7), 30);
        break;
      }
      if (prompt.includes('malformed')) {
        for (let i = 0; i < 6; i++) process.stdout.write('not json\n');
        break;
      }
      if (prompt.includes('huge'))
        for (let i = 0; i < 300; i++)
          notify('item/commandExecution/outputDelta', {
            threadId: 'fixture-thread',
            turnId: active.id,
            itemId: 'command',
            delta: 'X'.repeat(8192),
          });
      if (prompt.includes('wait')) break;
      if (prompt.includes('fail')) {
        complete('failed');
        break;
      }
      if (prompt.includes('approval')) {
        approval = { id: 'approval-7' };
        emit({
          id: approval.id,
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId: 'fixture-thread',
            turnId: active.id,
            itemId: 'command',
            command: 'npm test',
            cwd,
            reason: 'Run the requested tests',
            networkApprovalContext: {
              host: 'registry.npmjs.org',
              protocol: 'https',
            },
            availableDecisions: ['accept', 'decline', 'cancel'],
          },
        });
        break;
      }
      setTimeout(finish, 70);
      break;
    }
    default:
      emit({ id, error: { code: -32601, message: 'Unknown fixture request' } });
  }
});
