#!/usr/bin/env node
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('2.1.274 (Claude Code)');
  process.exit();
}
if (args.includes('status')) {
  console.log(
    JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      email: 'must-not-leak@example.com',
    }),
  );
  process.exit();
}
const session = args
  .find((a) => a.startsWith('--session-id=') || a.startsWith('--resume='))
  ?.split('=')[1];
let prompt = '',
  turn = '',
  mode = 'acceptEdits';
const emit = (v) => console.log(JSON.stringify(v));
const reply = (id, response = {}) =>
  emit({
    type: 'control_response',
    response: { subtype: 'success', request_id: id, response },
  });
const assistant = (content) =>
  emit({
    type: 'assistant',
    uuid: `a-${turn}`,
    session_id: session,
    message: {
      id: `m-${turn}`,
      model: 'fixture-claude',
      role: 'assistant',
      content,
    },
  });
function finish(error = false) {
  assistant([{ type: 'text', text: 'Observable answer' }]);
  emit({
    type: 'result',
    subtype: error ? 'error_during_execution' : 'success',
    is_error: error,
    result: 'Observable answer',
    session_id: session,
    duration_ms: 42,
    usage: { input_tokens: 12, output_tokens: 8 },
    total_cost_usd: 0.01,
  });
}
for await (const line of createInterface({ input: process.stdin })) {
  const v = JSON.parse(line);
  if (v.type === 'control_request') {
    const q = v.request;
    if (q.subtype === 'initialize')
      reply(v.request_id, {
        models: [{ value: 'fixture-claude', displayName: 'Fixture Claude' }],
        commands: [],
        permissionMode: mode,
      });
    else if (q.subtype === 'interrupt') {
      reply(v.request_id);
      finish(true);
    } else if (q.subtype === 'set_permission_mode') {
      mode = q.mode;
      reply(v.request_id);
    } else if (q.subtype === 'set_model') reply(v.request_id);
    else reply(v.request_id);
  } else if (v.type === 'user') {
    turn = v.uuid;
    prompt = v.message.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    emit({
      type: 'system',
      subtype: 'init',
      session_id: session,
      model: 'fixture-claude',
      permissionMode: mode,
    });
    emit(v);
    if (prompt === 'crash') process.exit(1);
    if (prompt === 'hold') continue;
    if (prompt === 'background') {
      emit({
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-1',
        description: 'Background checks',
      });
      finish();
      setTimeout(
        () =>
          emit({
            type: 'system',
            subtype: 'task_notification',
            task_id: 'task-1',
            status: 'completed',
            summary: 'Checks finished',
          }),
        450,
      );
      continue;
    }
    if (prompt === 'question' || prompt === 'approval' || prompt === 'plan') {
      const name =
        prompt === 'question'
          ? 'AskUserQuestion'
          : prompt === 'plan'
            ? 'ExitPlanMode'
            : 'Bash';
      const input =
        prompt === 'question'
          ? {
              questions: [
                {
                  question: 'Which checks?',
                  header: 'Checks',
                  multiSelect: true,
                  options: [
                    { label: 'Unit', description: 'Fast' },
                    { label: 'Integration', description: 'Deeper' },
                  ],
                },
              ],
            }
          : { command: 'npm test' };
      assistant([{ type: 'tool_use', id: 'tool-1', name, input }]);
      emit({
        type: 'control_request',
        request_id: 'permission-1',
        request: {
          subtype: 'can_use_tool',
          tool_name: name,
          input,
          tool_use_id: 'tool-1',
        },
      });
      continue;
    }
    assistant([
      { type: 'thinking', thinking: 'NEVER SHOW PRIVATE THINKING' },
      {
        type: 'tool_use',
        id: 'tool-1',
        name: 'Bash',
        input: { command: 'npm test' },
      },
    ]);
    emit({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: 'PASS fixture',
          },
        ],
      },
    });
    emit({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: `m-${turn}` } },
    });
    emit({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Observable ' },
      },
    });
    finish();
  } else if (v.type === 'control_response') {
    const answer = v.response.response;
    if (
      prompt === 'question' &&
      typeof answer.updatedInput?.answers?.['Which checks?'] !== 'string'
    ) {
      finish(true);
      continue;
    }
    emit({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: answer.behavior === 'allow' ? 'Approved' : 'Declined',
            is_error: answer.behavior !== 'allow',
          },
        ],
      },
    });
    finish();
  }
}
