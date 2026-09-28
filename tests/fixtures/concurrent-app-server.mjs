#!/usr/bin/env node
// A multi-thread protocol fixture: no models, network, or project writes.
import readline from 'node:readline';
const threads = new Map();
let sequence = 0;
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method, params) => emit({ method, params });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params: p = {} } = JSON.parse(line);
  const reply = (result) => emit({ id, result });
  const t = threads.get(p.threadId);
  if (method === 'initialize') return reply({});
  if (method === 'initialized') return;
  if (method === 'thread/start') {
    const thread = {
      id: `thread-${++sequence}`,
      cwd: p.cwd,
      status: { type: 'idle' },
      turns: [],
    };
    threads.set(thread.id, thread);
    return reply({ thread, model: 'fixture' });
  }
  if (method === 'thread/read' || method === 'thread/resume')
    return reply({ thread: t, model: 'fixture' });
  if (method === 'thread/turns/list')
    return reply({ data: t.turns, nextCursor: null });
  if (method === 'turn/start') {
    if (t.status.type === 'active')
      return emit({ id, error: { message: 'Turn already active' } });
    const turn = { id: `turn-${++sequence}`, status: 'inProgress' };
    t.turns.unshift(turn);
    t.status.type = 'active';
    reply({ turn });
    notify('turn/started', { threadId: t.id, turn });
    notify('item/started', {
      threadId: t.id,
      turnId: turn.id,
      item: { id: 'thinking', type: 'reasoning', summary: [], content: [] },
    });
    for (const [summaryIndex, delta] of [
      [0, 'Checking '],
      [0, t.id],
      [1, 'Next step.'],
    ])
      notify('item/reasoning/summaryTextDelta', {
        threadId: t.id,
        turnId: turn.id,
        itemId: 'thinking',
        summaryIndex,
        delta,
      });
    notify('item/reasoning/textDelta', {
      threadId: t.id,
      turnId: turn.id,
      itemId: 'thinking',
      delta: 'NEVER_RENDER_THIS',
    });
    notify('item/commandExecution/outputDelta', {
      threadId: t.id,
      turnId: turn.id,
      itemId: 'same-command-id',
      delta: `Output for ${t.id}`,
    });
    emit({
      id: `approval-${t.id}`,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: t.id,
        turnId: turn.id,
        itemId: 'same-command-id',
        command: 'npm test',
        availableDecisions: ['accept', 'decline'],
      },
    });
    return;
  }
  if (method === 'turn/interrupt') {
    const turn = t.turns.find((turn) => turn.id === p.turnId);
    turn.status = 'interrupted';
    t.status.type = 'idle';
    reply({});
    notify('turn/completed', { threadId: t.id, turn });
    return;
  }
  emit({ id, error: { message: 'Unsupported fixture request' } });
});
