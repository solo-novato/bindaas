#!/usr/bin/env node
// Deterministic speed-update contract: no model, network, or filesystem writes.
import readline from 'node:readline';
const threads = new Map();
const requests = [];
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params: p = {} } = JSON.parse(line);
  if (!method) return;
  requests.push({ method, params: p });
  const reply = (result) => emit({ id, result });
  const reject = (message) => emit({ id, error: { code: -32602, message } });
  const t = threads.get(p.threadId);
  if (method === 'initialize') return reply({});
  if (method === 'initialized') return;
  if (method === 'thread/start') {
    const thread = {
      id: `thread-${threads.size}`,
      cwd: p.cwd,
      status: { type: 'idle' },
    };
    threads.set(thread.id, {
      thread,
      options: p,
      settings: {
        model: 'fixture',
        effort: 'high',
        serviceTier: null,
        collaborationMode: { mode: 'plan' },
        approvalPolicy: 'on-request',
        sandboxPolicy: { type: 'readOnly' },
        cwd: p.cwd,
      },
    });
    return reply({ thread, model: 'fixture' });
  }
  if (method === 'thread/read')
    return reply({ thread: t.thread, requests, settings: t.settings });
  if (method === 'turn/start') {
    t.turn = { id: `turn-${t.thread.id}`, status: 'inProgress' };
    t.thread.status.type = 'active';
    emit({
      method: 'turn/started',
      params: { threadId: t.thread.id, turn: t.turn },
    });
    return reply({ turn: t.turn });
  }
  if (method === 'thread/settings/update') {
    if (t.options.failFuture) return reject('Future speed rejected');
    t.settings.serviceTier = p.serviceTier === 'fast' ? 'priority' : 'default';
    emit({
      method: 'thread/settings/updated',
      params: { threadId: t.thread.id, threadSettings: t.settings },
    });
    return reply({});
  }
  if (method === 'turn/settings/update') {
    if (t.options.failActive) return reject('Running speed unsupported');
    return reply({
      status: t.options.finishDuringUpdate ? 'targetUnavailable' : 'applied',
    });
  }
  return reject(`Unexpected method: ${method}`);
});
