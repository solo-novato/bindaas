import { test, expect, type Page } from '@playwright/test';
import {
  concurrentFixture,
  connectClaude,
  installClaudeFixture,
  mockDesktop,
  openProject,
  switchTask,
} from './fixtures';

const queue = (page: Page) => page.locator('.queue-card');
const entries = (page: Page) => queue(page).getByRole('listitem');
const prompt = (page: Page) =>
  page.getByRole('textbox', { name: 'Task prompt' });

async function starts(page: Page) {
  return page.evaluate(() =>
    (window as any).testCalls.filter(
      (call: any) => call.command === 'codex_start_turn',
    ),
  );
}

async function steers(page: Page) {
  return page.evaluate(() =>
    (window as any).testCalls.filter(
      (call: any) => call.command === 'codex_steer_turn',
    ),
  );
}

async function expectStarts(page: Page, count: number) {
  await expect.poll(async () => (await starts(page)).length).toBe(count);
}

async function startTask(page: Page, title = 'Initial task') {
  await prompt(page).fill(title);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Stop', exact: true }).first(),
  ).toBeVisible();
}

async function expandQueue(page: Page) {
  const expand = queue(page).getByRole('button', { name: /^Show all / });
  if (await expand.isVisible()) await expand.click();
}

async function enqueue(page: Page, messages: string[]) {
  for (const message of messages) {
    await prompt(page).fill(message);
    await page
      .getByRole('button', { name: 'Queue for next turn', exact: true })
      .click();
    await expect(prompt(page)).toHaveValue('');
    await expandQueue(page);
  }
}

async function finish(page: Page, id = 'concurrent-1', status = 'completed') {
  // Keep the fixture's authoritative history in sync with the emitted event.
  // Retain the exact payload to simulate replay after a new turn has begun.
  await page.evaluate(
    ({ id, status }) => {
      const w = window as any;
      const thread = w.concurrentThreads[id];
      thread.turn = { ...thread.turn, status };
      thread.approvals = [];
      const completion = { threadId: id, turn: { ...thread.turn } };
      (w.queueCompletions ??= {})[id] = completion;
      w.testEmit('turn-completed', completion);
    },
    { id, status },
  );
}

async function replayCompletion(page: Page, id = 'concurrent-1') {
  await page.evaluate((id) => {
    const w = window as any;
    w.testEmit('turn-completed', w.queueCompletions[id]);
    w.testEmit('turn-completed', w.queueCompletions[id]);
  }, id);
}

async function flushEvents(page: Page) {
  // Let reactive effects and asynchronous bridge continuations settle without
  // relying on a timing sleep to decide whether another dispatch occurred.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function queueFixture(page: Page) {
  await concurrentFixture(page);
  await page.evaluate(() => {
    const w = window as any;
    const invoke = w.testConcurrentInvoke;
    w.testConcurrentInvoke = async (command: string, args: any) => {
      if (command === 'codex_start_turn') {
        if (w.queueHoldStart)
          await new Promise<void>((resolve) => {
            w.queueReleaseStart = resolve;
          });
        if (w.queueStartError) throw Error(w.queueStartError);
      }
      if (command === 'codex_steer_turn' && w.queueHoldSteer)
        await new Promise<void>((resolve) => {
          w.queueReleaseSteer = resolve;
        });
      if (command === 'codex_interrupt_turn' && w.queueHoldInterrupt)
        await new Promise<void>((resolve) => {
          w.queueReleaseInterrupt = resolve;
        });
      if (command === 'codex_steer_turn' && w.queueSteerAcceptedThenError) {
        const thread = w.concurrentThreads[args.threadId];
        const item = {
          id: 'accepted-queue-steer',
          clientId: args.clientUserMessageId,
          threadId: thread.id,
          turnId: thread.turn.id,
          kind: 'user',
          title: 'You',
          status: 'completed',
          text: args.prompt,
        };
        thread.items.push(item);
        w.testEmit('timeline-item', item);
        throw Error('Steer acknowledgment failed after acceptance');
      }
      if (command === 'codex_interrupt_turn' && w.queueHeldTurnStarted) {
        // The accepted start ACK can arrive before its turn-started event.
        // Deliver that event when the deferred interrupt reaches the agent,
        // preserving the started-before-completed event order.
        w.testEmit('turn-started', w.queueHeldTurnStarted);
        w.queueHeldTurnStarted = null;
        w.queueStartedDeliveredOnInterrupt = true;
      }
      const emit = w.testEmit;
      if (command === 'codex_start_turn' && w.queueDelayStarted) {
        w.queueDelayStarted = false;
        w.testEmit = (name: string, payload: any) => {
          if (name === 'turn-started') w.queueHeldTurnStarted = payload;
          else emit(name, payload);
        };
      }
      let result;
      try {
        result = invoke(command, args);
      } finally {
        w.testEmit = emit;
      }
      if (command === 'codex_start_turn' && w.queueEarlyTerminalStatus) {
        const status = w.queueEarlyTerminalStatus;
        w.queueEarlyTerminalStatus = '';
        const thread = w.concurrentThreads[result.threadId];
        thread.turn = { ...thread.turn, status };
        const completion = { threadId: thread.id, turn: { ...thread.turn } };
        w.queueEarlyCompletion = completion;
        w.testEmit('turn-completed', completion);
        // Keep the original in-progress start response pending after the
        // authoritative terminal event, as a real transport can do.
        await new Promise<void>((resolve) => {
          w.queueReleaseAcceptedStart = resolve;
        });
      }
      return result;
    };
  });
}

test.beforeEach(async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
});

test('multiple follow-ups run in order, exactly once per successful turn', async ({
  page,
}) => {
  await queueFixture(page);
  await startTask(page);
  await enqueue(page, ['Inspect the change', 'Run the tests', 'Summarize']);
  await expect(page.getByRole('region', { name: 'Task queue' })).toBeVisible();
  await expect(entries(page)).toHaveCount(3);
  await expect(entries(page).nth(0)).toContainText('Inspect the change');
  await expect(entries(page).nth(1)).toContainText('Run the tests');
  await expect(entries(page).nth(2)).toContainText('Summarize');
  await prompt(page).fill('Keep this unsent draft');
  await page.evaluate(() => ((window as any).queueHoldStart = true));
  await finish(page);
  await expectStarts(page, 2);
  await replayCompletion(page);
  await flushEvents(page);
  await expectStarts(page, 2);
  await page.evaluate(() => {
    const w = window as any;
    w.queueHoldStart = false;
    w.queueReleaseStart();
  });
  await expect(entries(page)).toHaveCount(2);
  await replayCompletion(page);
  await flushEvents(page);
  await expectStarts(page, 2);
  await expect(entries(page)).toHaveCount(2);
  await expect(prompt(page)).toHaveValue('Keep this unsent draft');
  await finish(page);
  await expectStarts(page, 3);
  await expect(
    page.getByRole('region', { name: 'Queued message', exact: true }),
  ).toContainText('Summarize');
  await finish(page);
  await expectStarts(page, 4);
  await expect(queue(page)).toHaveCount(0);
  await finish(page);
  await replayCompletion(page);
  await flushEvents(page);
  expect((await starts(page)).map((call: any) => call.args.prompt)).toEqual([
    'Initial task',
    'Inspect the change',
    'Run the tests',
    'Summarize',
  ]);
  await expect(prompt(page)).toHaveValue('Keep this unsent draft');
});

test('reorder, inline edit, Cancel, Escape, and removal preserve the composer draft', async ({
  page,
}) => {
  await queueFixture(page);
  await startTask(page);
  await enqueue(page, [
    'First follow-up',
    'Second follow-up',
    'Third follow-up',
  ]);
  await prompt(page).fill('An unrelated unsent draft');
  await expect(
    entries(page)
      .first()
      .getByRole('button', { name: /Move up/i }),
  ).toBeDisabled();
  await expect(
    entries(page)
      .last()
      .getByRole('button', { name: /Move down/i }),
  ).toBeDisabled();
  await entries(page)
    .nth(2)
    .getByRole('button', { name: /Move up/i })
    .click();
  await expect(entries(page).nth(1)).toContainText('Third follow-up');
  await entries(page)
    .nth(0)
    .getByRole('button', { name: /Move down/i })
    .click();
  await expect(entries(page).first()).toContainText('Third follow-up');
  const first = entries(page).first();
  const edit = queue(page).getByRole('textbox', {
    name: 'Edit queued message',
  });
  await first.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(edit).toBeFocused();
  await edit.fill('Discard through Cancel');
  await queue(page)
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  await expect(edit).toHaveCount(0);
  await expect(first).toContainText('Third follow-up');
  await expect(
    first.getByRole('button', { name: 'Edit', exact: true }),
  ).toBeFocused();
  await first.getByRole('button', { name: 'Edit', exact: true }).click();
  await edit.fill('Discard through Escape');
  await edit.press('Escape');
  await expect(edit).toHaveCount(0);
  await expect(first).toContainText('Third follow-up');
  await expect(
    first.getByRole('button', { name: 'Edit', exact: true }),
  ).toBeFocused();
  await first.getByRole('button', { name: 'Edit', exact: true }).click();
  await edit.fill('');
  await expect(
    queue(page).getByRole('button', { name: 'Save changes', exact: true }),
  ).toBeDisabled();
  await edit.fill('Edited next step');
  await queue(page)
    .getByRole('button', { name: 'Save changes', exact: true })
    .click();
  await expect(first).toContainText('Edited next step');
  await entries(page)
    .nth(1)
    .getByRole('button', { name: 'Remove', exact: true })
    .click();
  await expect(entries(page)).toHaveCount(2);
  await expect(queue(page)).not.toContainText('First follow-up');
  await expect(prompt(page)).toHaveValue('An unrelated unsent draft');
  await expect(
    queue(page).getByRole('button', { name: 'Resume queue' }),
  ).toBeVisible();
  await queue(page).getByRole('button', { name: 'Resume queue' }).click();
  await finish(page);
  await expectStarts(page, 2);
  await finish(page);
  await expectStarts(page, 3);
  expect(
    (await starts(page)).slice(1).map((call: any) => call.args.prompt),
  ).toEqual(['Edited next step', 'Second follow-up']);
  await expect(prompt(page)).toHaveValue('An unrelated unsent draft');
});

test('inline editing pauses completion and keyboard save cannot send the edit', async ({
  page,
}) => {
  await queueFixture(page);
  await startTask(page);
  await enqueue(page, ['Edit before dispatch', 'Keep the next step']);
  await entries(page)
    .first()
    .getByRole('button', { name: 'Edit', exact: true })
    .click();
  const editor = queue(page).getByRole('textbox', {
    name: 'Edit queued message',
  });
  await editor.fill('Saved with the keyboard');
  await expect(
    queue(page).getByRole('button', { name: 'Send now', exact: true }),
  ).toBeDisabled();
  await expect(
    queue(page).getByRole('button', { name: 'Resume queue' }),
  ).toBeDisabled();
  await expect(
    queue(page).getByRole('button', { name: 'Show less' }),
  ).toBeDisabled();
  await expect(
    entries(page).nth(1).getByRole('button', { name: 'Remove', exact: true }),
  ).toBeDisabled();
  await finish(page);
  await flushEvents(page);
  await expectStarts(page, 1);
  await expect(editor).toHaveValue('Saved with the keyboard');
  await editor.press('Control+Enter');
  await expect(editor).toHaveCount(0);
  await expect(entries(page).first()).toContainText('Saved with the keyboard');
  await expect(
    entries(page).first().getByRole('button', { name: 'Edit', exact: true }),
  ).toBeFocused();
  await flushEvents(page);
  await expectStarts(page, 1);
  await queue(page).getByRole('button', { name: 'Resume queue' }).click();
  await expectStarts(page, 2);
  expect((await starts(page))[1].args.prompt).toBe('Saved with the keyboard');
});

test('an unsaved queued edit survives conversation switching and stays paused', async ({
  page,
}) => {
  await queueFixture(page);
  await startTask(page, 'Conversation with an edit');
  await enqueue(page, ['First saved step', 'Second saved step']);
  await entries(page)
    .nth(1)
    .getByRole('button', { name: 'Edit', exact: true })
    .click();
  await queue(page)
    .getByRole('textbox', { name: 'Edit queued message' })
    .fill('Unsaved second-step edit');
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await expect(queue(page)).toHaveCount(0);
  await prompt(page).fill('Draft in a different conversation');
  await finish(page);
  await flushEvents(page);
  await expectStarts(page, 1);
  await switchTask(page, 'Conversation with an edit');
  const editor = queue(page).getByRole('textbox', {
    name: 'Edit queued message',
  });
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue('Unsaved second-step edit');
  await expect(entries(page)).toHaveCount(2);
  await expect(
    queue(page).getByRole('button', { name: 'Resume queue' }),
  ).toBeDisabled();
  await editor.press('Escape');
  await expect(entries(page).nth(1)).toContainText('Second saved step');
  await expect(queue(page)).not.toContainText('Unsaved second-step edit');
  await expect(
    queue(page).getByRole('button', { name: 'Resume queue' }),
  ).toBeEnabled();
  await expectStarts(page, 1);
});

test('inline text typed during an unrelated steering acknowledgment survives switching tasks', async ({
  page,
}) => {
  await queueFixture(page);
  await startTask(page, 'Editing conversation');
  await enqueue(page, ['Original queued text', 'Another queued step']);
  await entries(page)
    .first()
    .getByRole('button', { name: 'Edit', exact: true })
    .click();
  const editor = queue(page).getByRole('textbox', {
    name: 'Edit queued message',
  });
  await editor.fill('Edited before sending');
  await page.evaluate(() => ((window as any).queueHoldSteer = true));
  await prompt(page).fill('An unrelated immediate steering instruction');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(async () => (await steers(page)).length).toBe(1);
  await expect(
    queue(page).getByRole('button', { name: 'Save changes' }),
  ).toBeDisabled();
  await expect(editor).toBeEditable();
  await editor.fill(
    'Edited before sending, plus text entered while the acknowledgment was pending',
  );
  await page.evaluate(() => {
    const w = window as any;
    w.queueHoldSteer = false;
    w.queueReleaseSteer();
  });
  await expect(
    queue(page).getByRole('button', { name: 'Save changes' }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await expect(queue(page)).toHaveCount(0);
  await switchTask(page, 'Editing conversation');
  await expect(editor).toHaveValue(
    'Edited before sending, plus text entered while the acknowledgment was pending',
  );
  await expect(
    queue(page).getByRole('button', { name: 'Resume queue' }),
  ).toBeDisabled();
  await expectStarts(page, 1);
  expect((await steers(page))[0].args.prompt).toBe(
    'An unrelated immediate steering instruction',
  );
});

test('Stop during a queued steer pauses remaining work even when successful completion wins the interrupt race', async ({
  page,
}) => {
  await queueFixture(page);
  await startTask(page);
  await enqueue(page, ['Steer before stopping', 'Do not start after Stop']);
  await page.evaluate(() => {
    const w = window as any;
    w.queueHoldSteer = true;
    w.queueHoldInterrupt = true;
  });
  await queue(page)
    .getByRole('button', { name: 'Send now', exact: true })
    .click();
  await expect.poll(async () => (await steers(page)).length).toBe(1);
  await page.getByRole('button', { name: 'Stop', exact: true }).first().click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).testCalls.filter(
            (call: any) => call.command === 'codex_interrupt_turn',
          ).length,
      ),
    )
    .toBe(1);
  // The agent completes successfully before its delayed interrupt reaches it.
  await finish(page);
  await page.evaluate(() => {
    const w = window as any;
    w.queueHoldSteer = false;
    w.queueReleaseSteer();
  });
  await expect(entries(page)).toHaveCount(1);
  await expect(queue(page)).toContainText('Do not start after Stop');
  await expect(
    queue(page).getByRole('button', { name: 'Resume queue' }),
  ).toBeVisible();
  await flushEvents(page);
  await expectStarts(page, 1);
  await page.evaluate(() => {
    const w = window as any;
    w.queueHoldInterrupt = false;
    w.queueReleaseInterrupt();
  });
  await replayCompletion(page);
  await flushEvents(page);
  await expectStarts(page, 1);
  await expect(entries(page)).toHaveCount(1);
  await expect(
    queue(page).getByRole('button', { name: 'Resume queue' }),
  ).toBeVisible();
});

test('Stop before a queued start returns its turn ID interrupts the accepted turn and keeps the rest paused', async ({
  page,
}) => {
  await queueFixture(page);
  await startTask(page);
  await enqueue(page, ['Starting step to stop', 'Keep this queued after Stop']);
  await page.evaluate(() => {
    const w = window as any;
    w.queueHoldStart = true;
    w.queueDelayStarted = true;
  });
  await finish(page);
  await expectStarts(page, 2);
  await expect(queue(page)).toHaveAttribute('aria-busy', 'true');
  await page.getByRole('button', { name: 'Stop', exact: true }).first().click();
  expect(
    await page.evaluate(() =>
      (window as any).testCalls.filter(
        (call: any) => call.command === 'codex_interrupt_turn',
      ),
    ),
  ).toHaveLength(0);
  await page.evaluate(() => {
    const w = window as any;
    w.queueHoldStart = false;
    w.queueReleaseStart();
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).testCalls.filter(
            (call: any) => call.command === 'codex_interrupt_turn',
          ).length,
      ),
    )
    .toBe(1);
  const interruption = await page.evaluate(() => {
    const w = window as any;
    return {
      args: w.testCalls.find(
        (call: any) => call.command === 'codex_interrupt_turn',
      ).args,
      turn: w.concurrentThreads['concurrent-1'].turn,
      previousTurn: w.queueCompletions['concurrent-1'].turn.id,
      startedDeliveredOnInterrupt: w.queueStartedDeliveredOnInterrupt,
    };
  });
  expect(interruption.args).toMatchObject({
    threadId: 'concurrent-1',
    turnId: interruption.turn.id,
  });
  expect(interruption.turn.id).not.toBe(interruption.previousTurn);
  expect(interruption.turn.status).toBe('interrupted');
  expect(interruption.startedDeliveredOnInterrupt).toBe(true);
  await expect(entries(page)).toHaveCount(1);
  await expect(queue(page)).toContainText('Keep this queued after Stop');
  await expect(
    queue(page).getByRole('button', { name: 'Resume queue' }),
  ).toBeVisible();
  await replayCompletion(page);
  await flushEvents(page);
  await expectStarts(page, 2);
});

test('an accepted queued steer is dequeued exactly once even when its acknowledgment rejects', async ({
  page,
}) => {
  await queueFixture(page);
  await startTask(page);
  await enqueue(page, [
    'Accepted before the error',
    'Continue after accepted steer',
  ]);
  await page.evaluate(
    () => ((window as any).queueSteerAcceptedThenError = true),
  );
  await queue(page)
    .getByRole('button', { name: 'Send now', exact: true })
    .click();
  await expect(entries(page)).toHaveCount(1);
  await expect(queue(page)).toContainText('Continue after accepted steer');
  await expect(queue(page).getByRole('alert')).toHaveCount(0);
  await expect(
    queue(page).getByRole('button', { name: 'Pause queue' }),
  ).toBeVisible();
  await expect(
    page.getByText('Accepted before the error', { exact: true }),
  ).toHaveCount(1);
  await expect.poll(async () => (await steers(page)).length).toBe(1);
  await finish(page);
  await expectStarts(page, 2);
  expect((await starts(page))[1].args.prompt).toBe(
    'Continue after accepted steer',
  );
  await expect(queue(page)).toHaveCount(0);
});

for (const background of [false, true]) {
  for (const status of ['completed', 'failed']) {
    test(`${background ? 'background' : 'foreground'} ${status} event before start acknowledgment remains authoritative`, async ({
      page,
    }) => {
      await queueFixture(page);
      await startTask(page, 'Early completion conversation');
      await enqueue(page, [
        'First early-completion step',
        'Second early-completion step',
      ]);
      if (background) {
        await page
          .getByRole('button', { name: 'New task', exact: true })
          .click();
        await startTask(page, 'Other conversation');
      }
      const initialStarts = background ? 2 : 1;
      await prompt(page).fill('Unsent draft while acknowledgment is pending');
      await page.evaluate(
        (status) => ((window as any).queueEarlyTerminalStatus = status),
        status,
      );
      await finish(page);
      await expectStarts(page, initialStarts + 1);
      await expect
        .poll(() =>
          page.evaluate(() => typeof (window as any).queueReleaseAcceptedStart),
        )
        .toBe('function');
      await flushEvents(page);
      await expectStarts(page, initialStarts + 1);
      await page.evaluate(() => (window as any).queueReleaseAcceptedStart());
      if (status === 'completed') await expectStarts(page, initialStarts + 2);
      else await flushEvents(page);
      await expect(prompt(page)).toHaveValue(
        'Unsent draft while acknowledgment is pending',
      );
      if (background) await switchTask(page, 'Early completion conversation');
      if (status === 'completed') {
        await expect(queue(page)).toHaveCount(0);
        expect((await starts(page)).at(-1).args).toMatchObject({
          threadId: 'concurrent-1',
          prompt: 'Second early-completion step',
        });
      } else {
        await expect(entries(page)).toHaveCount(1);
        await expect(queue(page)).toContainText('Second early-completion step');
        await expect(queue(page)).not.toContainText(
          'First early-completion step',
        );
        await expect(
          queue(page).getByRole('button', { name: 'Resume queue' }),
        ).toBeVisible();
        await expectStarts(page, initialStarts + 1);
      }
      await page.evaluate(() => {
        const w = window as any;
        w.testEmit('turn-completed', w.queueEarlyCompletion);
        w.testEmit('turn-completed', w.queueEarlyCompletion);
      });
      await flushEvents(page);
      await expectStarts(
        page,
        initialStarts + (status === 'completed' ? 2 : 1),
      );
    });
  }
}

test('sending a new composer message while paused leaves the queue untouched', async ({
  page,
}) => {
  await queueFixture(page);
  await startTask(page);
  await enqueue(page, ['Wait for the queued request', 'Wait for this too']);
  await queue(page).getByRole('button', { name: 'Pause queue' }).click();
  await finish(page);
  await flushEvents(page);
  await startTask(page, 'A separate immediate request');
  await expectStarts(page, 2);
  await expect(entries(page)).toHaveCount(2);
  await expect(
    queue(page).getByRole('button', { name: 'Resume queue' }),
  ).toBeVisible();
  await finish(page);
  await flushEvents(page);
  await expectStarts(page, 2);
  await expect(entries(page).first()).toContainText(
    'Wait for the queued request',
  );
  expect((await starts(page))[1].args.prompt).toBe(
    'A separate immediate request',
  );
});

test('pausing survives a one-off Send now and newly queued steps until resumed', async ({
  page,
}) => {
  await queueFixture(page);
  await startTask(page);
  await enqueue(page, ['One-off follow-up', 'Wait for resume']);
  await queue(page).getByRole('button', { name: 'Pause queue' }).click();
  await finish(page);
  await expect(
    queue(page).getByRole('button', { name: 'Resume queue' }),
  ).toBeVisible();
  await flushEvents(page);
  await expectStarts(page, 1);
  await queue(page)
    .getByRole('button', { name: 'Send now', exact: true })
    .click();
  await expectStarts(page, 2);
  await expect(
    queue(page).getByRole('button', { name: 'Resume queue' }),
  ).toBeVisible();
  await enqueue(page, ['Also wait for resume']);
  await finish(page);
  await flushEvents(page);
  await expectStarts(page, 2);
  await expect(entries(page)).toHaveCount(2);
  await queue(page).getByRole('button', { name: 'Resume queue' }).click();
  await expectStarts(page, 3);
  await finish(page);
  await expectStarts(page, 4);
  await expect(queue(page)).toHaveCount(0);
});

for (const status of ['failed', 'interrupted']) {
  test(`${status} turns pause the remaining queue and require an explicit resume`, async ({
    page,
  }) => {
    await queueFixture(page);
    await startTask(page);
    await enqueue(page, ['Inspect the interruption', 'Continue afterward']);
    if (status === 'interrupted') {
      await page
        .getByRole('button', { name: 'Stop', exact: true })
        .first()
        .click();
    } else await finish(page, 'concurrent-1', status);
    await expect(
      queue(page).getByRole('button', { name: 'Resume queue' }),
    ).toBeVisible();
    await flushEvents(page);
    await expectStarts(page, 1);
    await expect(entries(page)).toHaveCount(2);
    await prompt(page).fill('A separate draft after the interruption');
    await queue(page).getByRole('button', { name: 'Resume queue' }).click();
    await expectStarts(page, 2);
    expect((await starts(page))[1].args.prompt).toBe(
      'Inspect the interruption',
    );
    await expect(prompt(page)).toHaveValue(
      'A separate draft after the interruption',
    );
  });
}

test('a lost connection pauses queued work and reconnecting does not silently resume it', async ({
  page,
}) => {
  await queueFixture(page);
  await startTask(page);
  await enqueue(page, ['Recover deliberately', 'Then continue']);
  await page.evaluate(() => {
    const w = window as any;
    w.concurrentThreads['concurrent-1'].turn.status = 'connectionLost';
    w.testEmit('connection', {
      type: 'disconnected',
      generation: 1,
      message: 'Fixture connection lost',
    });
  });
  await expect(
    queue(page).getByRole('button', { name: 'Resume queue' }),
  ).toBeVisible();
  await page.evaluate(() =>
    (window as any).testEmit('connection', { type: 'ready', generation: 2 }),
  );
  await flushEvents(page);
  await expectStarts(page, 1);
  await expect(entries(page)).toHaveCount(2);
  await expect(
    queue(page).getByRole('button', { name: 'Resume queue' }),
  ).toBeVisible();
});

test('an automatic send failure retains the first entry and pauses without overwriting a draft', async ({
  page,
}) => {
  await queueFixture(page);
  await startTask(page);
  await enqueue(page, ['Retry the same first step', 'Do not skip ahead']);
  await prompt(page).fill('Draft written while the task works');
  await page.evaluate(() => {
    (window as any).queueStartError = 'Fixture follow-up start rejected';
  });
  await finish(page);
  await expectStarts(page, 2);
  await expect(queue(page).getByRole('alert')).toContainText(
    'Fixture follow-up start rejected',
  );
  await expect(entries(page)).toHaveCount(2);
  await expect(entries(page).first()).toContainText(
    'Retry the same first step',
  );
  await expect(
    queue(page).getByRole('button', { name: 'Resume queue' }),
  ).toBeVisible();
  await expect(prompt(page)).toHaveValue('Draft written while the task works');
  await replayCompletion(page);
  await flushEvents(page);
  await expectStarts(page, 2);
  await page.evaluate(() => ((window as any).queueStartError = ''));
  await queue(page)
    .getByRole('button', { name: 'Send now', exact: true })
    .click();
  await expectStarts(page, 3);
  expect((await starts(page))[2].args.prompt).toBe('Retry the same first step');
  await expect(entries(page)).toHaveCount(1);
  await expect(
    queue(page).getByRole('button', { name: 'Resume queue' }),
  ).toBeVisible();
  await finish(page);
  await flushEvents(page);
  await expectStarts(page, 3);
  await expect(queue(page)).toContainText('Do not skip ahead');
});

test('repeated Send now clicks cannot dispatch or mutate a second entry while starting', async ({
  page,
}) => {
  await queueFixture(page);
  await startTask(page);
  await enqueue(page, ['Only one send', 'Keep the second entry']);
  await queue(page).getByRole('button', { name: 'Pause queue' }).click();
  await finish(page);
  await page.evaluate(() => ((window as any).queueHoldStart = true));
  await queue(page)
    .getByRole('button', { name: 'Send now', exact: true })
    .evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
      button.click();
    });
  await expectStarts(page, 2);
  await expect(
    queue(page).getByRole('button', { name: 'Send now', exact: true }),
  ).toBeDisabled();
  await expect(
    entries(page).first().getByRole('button', { name: 'Remove', exact: true }),
  ).toBeDisabled();
  await expect(
    entries(page).first().getByRole('button', { name: 'Edit', exact: true }),
  ).toBeDisabled();
  await expect(
    entries(page)
      .first()
      .getByRole('button', { name: /Move down/i }),
  ).toBeDisabled();
  await page.evaluate(() => {
    const w = window as any;
    w.queueHoldStart = false;
    w.queueReleaseStart();
  });
  await expect(entries(page)).toHaveCount(1);
  await expect(queue(page)).toContainText('Keep the second entry');
  await flushEvents(page);
  await expectStarts(page, 2);
});

test('Codex Send now steers only the first queued message and guards rapid repeats', async ({
  page,
}) => {
  await queueFixture(page);
  await startTask(page);
  await enqueue(page, ['Steer the active turn', 'Wait for the next turn']);
  await page.evaluate(() => ((window as any).testSteerDelay = 250));
  await queue(page)
    .getByRole('button', { name: 'Send now', exact: true })
    .evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
      button.click();
    });
  await expect.poll(async () => (await steers(page)).length).toBe(1);
  await expect(entries(page)).toHaveCount(1);
  expect((await steers(page))[0].args).toMatchObject({
    threadId: 'concurrent-1',
    prompt: 'Steer the active turn',
  });
  await expectStarts(page, 1);
  await expect(queue(page)).toContainText('Wait for the next turn');
  await finish(page);
  await expectStarts(page, 2);
  expect((await starts(page))[1].args.prompt).toBe('Wait for the next turn');
});

test('failed steering preserves the entire queue and retrying does not unpause it', async ({
  page,
}) => {
  await queueFixture(page);
  await startTask(page);
  await enqueue(page, ['Keep this on steer failure', 'Keep this second']);
  await page.evaluate(
    () => ((window as any).testSteerError = 'Fixture steer rejected'),
  );
  await queue(page)
    .getByRole('button', { name: 'Send now', exact: true })
    .click();
  await expect(queue(page).getByRole('alert')).toContainText(
    'Fixture steer rejected',
  );
  await expect(entries(page)).toHaveCount(2);
  await expect(
    queue(page).getByRole('button', { name: 'Resume queue' }),
  ).toBeVisible();
  await page.evaluate(() => ((window as any).testSteerError = ''));
  await queue(page)
    .getByRole('button', { name: 'Send now', exact: true })
    .click();
  await expect(entries(page)).toHaveCount(1);
  await expect.poll(async () => (await steers(page)).length).toBe(2);
  expect((await steers(page)).map((call: any) => call.args.prompt)).toEqual([
    'Keep this on steer failure',
    'Keep this on steer failure',
  ]);
  await finish(page);
  await flushEvents(page);
  await expectStarts(page, 1);
  await expect(queue(page)).toContainText('Keep this second');
});

test('each queued entry captures its settings, attachments, and quoted context', async ({
  page,
}) => {
  await queueFixture(page);
  await startTask(page);
  await page.evaluate(() => {
    const w = window as any;
    const thread = w.concurrentThreads['concurrent-1'];
    const item = {
      id: 'queue-context-source',
      threadId: thread.id,
      turnId: thread.turn.id,
      kind: 'message',
      title: 'Codex',
      text: 'Important source context for the queued plan.',
      status: 'completed',
    };
    thread.items.push(item);
    w.testEmit('timeline-item', item);
  });
  await page.getByRole('button', { name: 'Quote in reply' }).click();
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  await enqueue(page, ['Plan with the quoted context']);
  await expect(entries(page).first()).toContainText('brief.md');
  await expect(entries(page).first()).toContainText('screen.png');
  await expect(entries(page).first()).toContainText('Codex response');
  await page.getByRole('button', { name: 'Code', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Code', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await enqueue(page, ['Implement the second step']);
  await page.evaluate(() => {
    (window as any).testAttachments = [
      {
        id: 'new-draft-file',
        name: 'new-draft.md',
        kind: 'file',
        sizeBytes: 32,
      },
    ];
  });
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  await prompt(page).fill('Unsent draft with its own attachment');
  await finish(page);
  await expectStarts(page, 2);
  const first = (await starts(page))[1].args;
  expect(first).toMatchObject({
    threadId: 'concurrent-1',
    mode: 'plan',
    model: 'model-concurrent-1',
    effort: 'high',
    attachmentIds: ['brief', 'screen'],
  });
  expect(first.prompt).toContain('Plan with the quoted context');
  expect(first.prompt).toContain('--- Context: Codex response ---');
  expect(first.prompt).toContain(
    'Important source context for the queued plan.',
  );
  await finish(page);
  await expectStarts(page, 3);
  expect((await starts(page))[2].args).toMatchObject({
    prompt: 'Implement the second step',
    mode: 'default',
    model: 'fixture',
    effort: 'medium',
    attachmentIds: [],
  });
  await expect(prompt(page)).toHaveValue(
    'Unsent draft with its own attachment',
  );
  await expect(
    page.getByRole('button', { name: 'Remove attachment new-draft.md' }),
  ).toBeVisible();
});

test('background queues advance independently and restore their own pause and draft state', async ({
  page,
}) => {
  await queueFixture(page);
  await startTask(page, 'First conversation');
  await enqueue(page, ['First queue step A', 'First queue step B']);
  await prompt(page).fill('Draft belonging to the first conversation');
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await startTask(page, 'Second conversation');
  await enqueue(page, ['Second queue step A', 'Second queue step B']);
  await queue(page).getByRole('button', { name: 'Pause queue' }).click();
  await prompt(page).fill('Draft belonging to the second conversation');
  await finish(page, 'concurrent-1');
  await expectStarts(page, 3);
  await replayCompletion(page, 'concurrent-1');
  await flushEvents(page);
  await expectStarts(page, 3);
  expect((await starts(page))[2].args).toMatchObject({
    threadId: 'concurrent-1',
    prompt: 'First queue step A',
  });
  await expect(queue(page)).toContainText('Second queue step A');
  await expect(queue(page)).not.toContainText('First queue step');
  await expect(prompt(page)).toHaveValue(
    'Draft belonging to the second conversation',
  );
  await finish(page, 'concurrent-2');
  await finish(page, 'concurrent-1');
  await expectStarts(page, 4);
  expect((await starts(page))[3].args).toMatchObject({
    threadId: 'concurrent-1',
    prompt: 'First queue step B',
  });
  await switchTask(page, 'First conversation');
  await expect(queue(page)).toHaveCount(0);
  await expect(prompt(page)).toHaveValue(
    'Draft belonging to the first conversation',
  );
  await switchTask(page, 'Second conversation');
  await expandQueue(page);
  await expect(entries(page)).toHaveCount(2);
  await expect(
    queue(page).getByRole('button', { name: 'Resume queue' }),
  ).toBeVisible();
  await expect(prompt(page)).toHaveValue(
    'Draft belonging to the second conversation',
  );
  await queue(page).getByRole('button', { name: 'Resume queue' }).click();
  await expectStarts(page, 5);
  expect((await starts(page))[4].args).toMatchObject({
    threadId: 'concurrent-2',
    prompt: 'Second queue step A',
  });
});

test('a background send failure preserves order and pauses only that conversation', async ({
  page,
}) => {
  await queueFixture(page);
  await startTask(page, 'Background conversation');
  await enqueue(page, ['Background failed step', 'Background remaining step']);
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await startTask(page, 'Foreground conversation');
  await enqueue(page, ['Foreground next step']);
  await page.evaluate(
    () => ((window as any).queueStartError = 'Background send rejected'),
  );
  await finish(page, 'concurrent-1');
  await expectStarts(page, 3);
  await flushEvents(page);
  await page.evaluate(() => ((window as any).queueStartError = ''));
  await expect(queue(page)).toContainText('Foreground next step');
  await expect(
    queue(page).getByRole('button', { name: 'Pause queue' }),
  ).toBeVisible();
  await finish(page, 'concurrent-2');
  await expectStarts(page, 4);
  await switchTask(page, 'Background conversation');
  await expandQueue(page);
  await expect(entries(page)).toHaveCount(2);
  await expect(entries(page).first()).toContainText('Background failed step');
  await expect(queue(page).getByRole('alert')).toContainText(
    'Background send rejected',
  );
  await expect(
    queue(page).getByRole('button', { name: 'Resume queue' }),
  ).toBeVisible();
  await replayCompletion(page, 'concurrent-1');
  await flushEvents(page);
  await expectStarts(page, 4);
});

test('Claude queues multiple Send clicks and cannot steer while its turn is active', async ({
  page,
}) => {
  await openProject(page);
  await installClaudeFixture(page);
  await connectClaude(page);
  await page
    .getByRole('combobox', { name: 'Agent', exact: true })
    .selectOption('claude');
  await startTask(page, 'Claude initial task');
  for (const text of ['Claude first follow-up', 'Claude second follow-up']) {
    await prompt(page).fill(text);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
  }
  await expandQueue(page);
  await expect(entries(page)).toHaveCount(2);
  await expect(
    queue(page).getByRole('button', { name: 'Send now', exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => (window as any).testClaudeFinish());
  const calls = () =>
    page.evaluate(() =>
      (window as any).testAgentCalls.filter(
        (call: any) =>
          call.command === 'agent_start_turn' && call.args.harness === 'claude',
      ),
    );
  await expect.poll(async () => (await calls()).length).toBe(2);
  await expect(entries(page)).toHaveCount(1);
  await expect(queue(page)).toContainText('Claude second follow-up');
  await expect(
    queue(page).getByRole('button', { name: 'Send now', exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => (window as any).testClaudeFinish());
  await expect.poll(async () => (await calls()).length).toBe(3);
  expect((await calls()).map((call: any) => call.args.prompt)).toEqual([
    'Claude initial task',
    'Claude first follow-up',
    'Claude second follow-up',
  ]);
  expect(
    await page.evaluate(() =>
      (window as any).testAgentCalls.filter(
        (call: any) => call.command === 'agent_steer_turn',
      ),
    ),
  ).toHaveLength(0);
  await expect(queue(page)).toHaveCount(0);
});

test('a full queue is bounded on a laptop and removing an entry keeps the next draft recoverable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await queueFixture(page);
  await startTask(page);
  await enqueue(
    page,
    Array.from(
      { length: 20 },
      (_, index) =>
        `Queued step ${index + 1}: ${'Detailed instruction '.repeat(12)}`,
    ),
  );
  await expect(entries(page)).toHaveCount(20);
  await queue(page).getByRole('button', { name: 'Show less' }).click();
  await expect(entries(page)).toHaveCount(1);
  await expect(queue(page)).toContainText('20 queued');
  await expandQueue(page);
  await expect(entries(page)).toHaveCount(20);
  await prompt(page).fill('The twenty-first draft must not disappear');
  const enqueueButton = page.getByRole('button', {
    name: 'Queue for next turn',
    exact: true,
  });
  await expect(enqueueButton).toBeDisabled();
  const bounds = await queue(page).boundingBox();
  const composerBounds = await prompt(page).boundingBox();
  expect(bounds).not.toBeNull();
  expect(composerBounds).not.toBeNull();
  expect(bounds!.height).toBeLessThan(700 / 2);
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1100);
  expect(composerBounds!.y + composerBounds!.height).toBeLessThanOrEqual(700);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: 'test-results/task-queue-laptop.png' });
  await entries(page)
    .last()
    .getByRole('button', { name: 'Remove', exact: true })
    .click();
  await expect(entries(page)).toHaveCount(19);
  await expect(prompt(page)).toHaveValue(
    'The twenty-first draft must not disappear',
  );
  await expect(enqueueButton).toBeEnabled();
  await enqueueButton.click();
  await expect(entries(page)).toHaveCount(20);
  await expect(entries(page).last()).toContainText(
    'The twenty-first draft must not disappear',
  );
  await expect(prompt(page)).toHaveValue('');
});

test('removing every queued entry does not send anything and queues do not survive reload', async ({
  page,
}) => {
  await queueFixture(page);
  await startTask(page);
  await enqueue(page, ['Remove this first', 'Remove this second']);
  await entries(page)
    .first()
    .getByRole('button', { name: 'Remove', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Queued message', exact: true }),
  ).toBeVisible();
  await entries(page)
    .first()
    .getByRole('button', { name: 'Remove', exact: true })
    .click();
  await expect(queue(page)).toHaveCount(0);
  await expectStarts(page, 1);
  await enqueue(page, ['SESSION_ONLY_QUEUE_SENTINEL']);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    'SESSION_ONLY_QUEUE_SENTINEL',
  );
  await page.reload();
  await expect(
    page.getByText('fixture-project', { exact: true }).first(),
  ).toBeVisible();
  await expect(queue(page)).toHaveCount(0);
  await expect(
    page.getByText('SESSION_ONLY_QUEUE_SENTINEL', { exact: true }),
  ).toHaveCount(0);
});
