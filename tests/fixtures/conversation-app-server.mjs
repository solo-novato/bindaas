#!/usr/bin/env node
import readline from 'node:readline';
const threads = new Map();
const requests = [];
let managed = false;
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params: p = {} } = JSON.parse(line);
  if (!method) return;
  requests.push({ method, params: p });
  const reply = (result) => emit({ id, result });
  const reject = (message) => emit({ id, error: { code: -32602, message } });
  if (method === 'initialize') return reply({});
  if (method === 'initialized') return;
  if (method === 'thread/start') {
    managed = !!p.managed;
    const thread = {
      id: `thread-${threads.size}`,
      cwd: p.cwd,
      parentId: p.parentId,
      settings: {
        model: 'fixture',
        effort: 'high',
        collaborationMode: { mode: 'plan' },
        sandboxPolicy: { type: 'workspaceWrite' },
        approvalPolicy: 'on-request',
      },
      status: { type: 'idle' },
      name: null,
    };
    threads.set(thread.id, thread);
    return reply({ thread });
  }
  const thread = threads.get(p.threadId);
  if (method === 'thread/list')
    return reply({
      data: [...threads.values()].filter(
        (t) => t.parentId === p.ancestorThreadId,
      ),
      nextCursor: null,
    });
  if (method === 'permissionProfile/list')
    return reply({
      data: [
        { id: ':read-only', allowed: true },
        { id: ':workspace', allowed: true },
        { id: ':danger-full-access', allowed: !managed },
      ],
      nextCursor: null,
    });
  if (method === 'configRequirements/read')
    return reply({
      requirements: managed
        ? { allowedApprovalPolicies: ['on-request'] }
        : null,
    });
  if (method === 'thread/settings/update') {
    thread.settings.activePermissionProfile = { id: p.permissions };
    thread.settings.sandboxPolicy = { type: 'dangerFullAccess' };
    thread.settings.approvalPolicy = p.approvalPolicy;
    emit({
      method: 'thread/settings/updated',
      params: { threadId: thread.id, threadSettings: thread.settings },
    });
    return reply({});
  }
  if (method === 'thread/read') return reply({ thread, requests });
  if (method === 'turn/start') {
    thread.status.type = 'active';
    thread.turn = { id: `turn-${thread.id}`, status: 'inProgress' };
    emit({
      method: 'turn/started',
      params: { threadId: thread.id, turn: thread.turn },
    });
    return reply({ turn: thread.turn });
  }
  if (method === 'turn/steer') {
    if (thread.turn?.id !== p.expectedTurnId) return reject('Turn mismatch');
    return reply({ turnId: thread.turn.id });
  }
  if (method === 'thread/name/set') {
    thread.name = p.name;
    emit({
      method: 'thread/name/updated',
      params: { threadId: thread.id, threadName: p.name },
    });
    return reply({});
  }
  if (method === 'thread/archive' || method === 'thread/unarchive') {
    thread.archived = method === 'thread/archive';
    if (thread.archived)
      emit({ method: 'thread/archived', params: { threadId: thread.id } });
    return reply({ thread });
  }
  return reject(`Unexpected method: ${method}`);
});
