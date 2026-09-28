import { readFileSync, writeFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import {
  concurrentFixture,
  mockDesktop,
  openProject,
  switchTask,
} from './fixtures';

test.beforeEach(async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
});

test('Plan mode and attachments are sent; attachment-only turns work', async ({
  page,
}) => {
  await openProject(page);
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Remove attachment screen.png' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Remove attachment brief.md' })
    .click();
  await page.getByRole('button', { name: 'Send' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).testCalls.filter(
            (c: any) => c.command === 'codex_start_turn',
          ).length,
      ),
    )
    .toBe(1);
  const call = await page.evaluate(() =>
    (window as any).testCalls.find(
      (c: any) => c.command === 'codex_start_turn',
    ),
  );
  expect(call.args.mode).toBe('plan');
  expect(call.args.attachmentIds).toEqual(['screen']);
  await page.locator('.task-details > summary').click();
  await expect(page.getByText('Plan mode', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
  await page.getByRole('button', { name: 'Code', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Code', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
});

test('failed send keeps attachments and mode for retry', async ({ page }) => {
  await openProject(page);
  await page.evaluate(
    () => ((window as any).testSendError = 'Fixture send failed'),
  );
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Plan these changes');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('textbox', { name: 'Task prompt' })).toHaveValue(
    'Plan these changes',
  );
  await expect(
    page.getByRole('button', { name: 'Remove attachment screen.png' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Plan', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
});

test('queued follow-up retains mode and attachments without replacing a new draft', async ({
  page,
}) => {
  await openProject(page);
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Wait for approval');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('button', { name: 'Allow once' })).toBeVisible();
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Review attached design');
  await page.getByRole('button', { name: 'Queue for next turn' }).click();
  await page.getByRole('button', { name: 'Code', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Another unsent draft');
  await page.getByRole('button', { name: 'Allow once' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).testCalls.filter(
            (c: any) => c.command === 'codex_start_turn',
          ).length,
      ),
    )
    .toBe(2);
  const calls = await page.evaluate(() =>
    (window as any).testCalls.filter(
      (c: any) => c.command === 'codex_start_turn',
    ),
  );
  expect(calls[1].args.mode).toBe('plan');
  expect(calls[1].args.attachmentIds).toEqual(['brief', 'screen']);
  await expect(page.getByRole('textbox', { name: 'Task prompt' })).toHaveValue(
    'Another unsent draft',
  );
});

test('pasted screenshot becomes a removable image attachment', async ({
  page,
}) => {
  await openProject(page);
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([new Uint8Array([137, 80, 78, 71])], 'Clipboard.png', {
          type: 'image/png',
        }),
      );
      element.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: transfer,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  await expect(
    page.getByRole('button', { name: 'Remove attachment Clipboard.png' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Send' }).click();
  const call = await page.evaluate(() =>
    (window as any).testCalls.find(
      (c: any) => c.command === 'codex_start_turn',
    ),
  );
  expect(call.args.attachmentIds).toEqual(['pasted']);
});

test('composer grows with a draft and context can be inspected from the keyboard', async ({
  page,
}) => {
  await openProject(page);
  const prompt = page.getByRole('textbox', { name: 'Task prompt' });
  const initial = (await prompt.boundingBox())!.height;
  await prompt.fill(
    Array.from({ length: 12 }, (_, i) => `A detailed instruction ${i}`).join(
      '\n',
    ),
  );
  expect((await prompt.boundingBox())!.height).toBeGreaterThan(initial);
  await prompt.fill('Explain this');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Quote in reply' }).click();
  const context = page.getByRole('button', {
    name: 'Preview context Codex response',
  });
  await context.focus();
  await context.press('Enter');
  const preview = page.getByRole('dialog', { name: 'Context preview' });
  await expect(preview).toContainText('Updated hello.txt and ran the tests.');
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  await expect(context).toBeVisible();
  expect((await prompt.boundingBox())!.height).toBe(initial);
});

test('attachment inspection is lazy, renders text safely, and returns focus without changing the draft', async ({
  page,
}) => {
  await openProject(page);
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Use the attached brief');
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  expect(
    await page.evaluate(
      () =>
        (window as any).testCalls.filter(
          (c: any) => c.command === 'attachment_preview',
        ).length,
    ),
  ).toBe(0);
  const file = page.getByRole('button', {
    name: 'Preview attachment brief.md',
  });
  await file.focus();
  await file.press('Enter');
  const preview = page.getByRole('dialog', { name: 'Attachment preview' });
  await expect(preview.locator('pre')).toContainText(
    '<script>literal content</script>',
  );
  await expect(preview.locator('script')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(file).toBeFocused();
  await expect(page.getByRole('textbox', { name: 'Task prompt' })).toHaveValue(
    'Use the attached brief',
  );
  await page
    .getByRole('button', { name: 'Preview attachment screen.png' })
    .click();
  await expect(preview.getByRole('img', { name: 'screen.png' })).toBeVisible();
  await expect(preview).toContainText('1 × 1');
  await preview
    .getByRole('button', { name: 'Actual size', exact: true })
    .click();
  await expect(
    preview.getByRole('button', { name: 'Fit image', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await preview
    .getByRole('button', { name: 'Remove attachment', exact: true })
    .click();
  await expect(preview).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Preview attachment screen.png' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('textbox', { name: 'Task prompt' }),
  ).toBeFocused();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const sent = await page.evaluate(() =>
    (window as any).testCalls.find(
      (c: any) => c.command === 'codex_start_turn',
    ),
  );
  expect(sent.args.attachmentIds).toEqual(['brief']);
  expect(sent.args.prompt).toBe('Use the attached brief');
});

test('attachment preview handles slow close, retry, truncation, and unsupported files', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 650 });
  await openProject(page);
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  await page.evaluate(() => {
    (window as any).testPreviewDelay = true;
  });
  const trigger = page.getByRole('button', {
    name: 'Preview attachment brief.md',
  });
  await trigger.click();
  const preview = page.getByRole('dialog', { name: 'Attachment preview' });
  await expect(preview.getByRole('status')).toHaveText('Loading attachment…');
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const w = window as any;
    w.testPreviewDelay = false;
    w.testResolvePreview();
    w.testPreviewError = 'Attachment missing. Attach the file again.';
  });
  await expect(preview).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(preview.getByRole('alert')).toContainText('Attachment missing');
  await page.evaluate(() => {
    const w = window as any;
    w.testPreviewError = '';
    w.testAttachmentPreviews = {
      brief: {
        kind: 'text',
        text: 'Bounded text preview\n'.repeat(100),
        truncated: true,
      },
    };
  });
  await preview.getByRole('button', { name: 'Retry preview' }).click();
  await expect(preview).toContainText('First 64 KiB shown');
  await expect(preview.locator('pre')).toBeVisible();
  const bounds = await preview.boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(650);
  await page.screenshot({
    path: 'test-results/screenshots/attachment-text-preview.png',
    animations: 'disabled',
  });
  await preview.getByRole('button', { name: 'Back to message' }).click();
  await page.evaluate(() => {
    (window as any).testAttachmentPreviews.brief = {
      kind: 'unavailable',
      message:
        'Preview is available for text files and images. This file is still attached.',
    };
  });
  await trigger.click();
  await expect(preview).toContainText('This file is still attached.');
  await preview.getByRole('button', { name: 'Back to message' }).click();
  await expect(trigger).toBeVisible();
});

test('queued message is visible and send now steers with attachments without interrupting', async ({
  page,
}) => {
  await concurrentFixture(page);
  await page.getByRole('textbox', { name: 'Task prompt' }).fill('Keep working');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Prioritize the failing test');
  await page.getByRole('button', { name: 'Queue for next turn' }).click();
  const queue = page.getByRole('region', { name: 'Queued message' });
  await expect(queue).toBeVisible();
  await expect(queue).toContainText('Prioritize the failing test');
  const fits = await queue.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const parent = el.parentElement!.getBoundingClientRect();
    return box.top >= parent.top && box.bottom <= parent.bottom;
  });
  expect(fits).toBe(true);
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Keep my draft');
  await queue.getByRole('button', { name: 'Send now' }).click();
  await expect(queue).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Task prompt' })).toHaveValue(
    'Keep my draft',
  );
  const calls = await page.evaluate(() => (window as any).testCalls);
  const steer = calls.find((c: any) => c.command === 'codex_steer_turn');
  expect(steer.args).toMatchObject({
    threadId: 'concurrent-1',
    prompt: 'Prioritize the failing test',
    attachmentIds: ['brief', 'screen'],
  });
  expect(
    calls.filter((c: any) => c.command === 'codex_start_turn'),
  ).toHaveLength(1);
  expect(
    calls.filter((c: any) => c.command === 'codex_interrupt_turn'),
  ).toHaveLength(0);
  await page.evaluate(() => (window as any).concurrentFinish('concurrent-1'));
  await page.waitForTimeout(100);
  expect(
    await page.evaluate(
      () =>
        (window as any).testCalls.filter(
          (c: any) => c.command === 'codex_start_turn',
        ).length,
    ),
  ).toBe(1);
});

test('send-now completion race retains failed queue and does not auto-retry', async ({
  page,
}) => {
  await concurrentFixture(page);
  await page.getByRole('textbox', { name: 'Task prompt' }).fill('Running task');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Important follow-up');
  await page.getByRole('button', { name: 'Queue for next turn' }).click();
  await page.evaluate(() => {
    const w = window as any;
    w.testSteerDelay = 250;
    w.testSteerError = 'Turn already finished';
  });
  const queue = page.getByRole('region', { name: 'Queued message' });
  await queue.getByRole('button', { name: 'Send now' }).click();
  await page.evaluate(() => (window as any).concurrentFinish('concurrent-1'));
  await expect(queue).toContainText('Message remains queued');
  await expect(queue).toContainText('Important follow-up');
  await page.waitForTimeout(150);
  expect(
    await page.evaluate(
      () =>
        (window as any).testCalls.filter(
          (c: any) => c.command === 'codex_start_turn',
        ).length,
    ),
  ).toBe(1);
  await queue.getByRole('button', { name: 'Send now' }).click();
  await expect(queue).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as any).testCalls.filter(
          (c: any) => c.command === 'codex_start_turn',
        ).length,
    ),
  ).toBe(2);
});

test('queued card and question controls remain reachable in a small window', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 650 });
  await openProject(page);
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Ask questions before planning');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Keep this queued until we agree on scope.');
  await page.getByRole('button', { name: 'Queue for next turn' }).click();
  const queue = page.getByRole('region', { name: 'Queued message' });
  await expect(queue).toBeVisible();
  await expect(
    queue.getByRole('button', { name: 'Send now' }),
  ).toBeInViewport();
  await expect(
    page
      .getByRole('region', { name: 'Questions from Codex' })
      .getByRole('button', { name: 'Next →' }),
  ).toBeInViewport();
  await expect(
    page.getByRole('button', { name: 'Write another message' }),
  ).toBeInViewport();
  const bodyHeight = await page
    .locator('.question-body')
    .evaluate((el) => el.getBoundingClientRect().height);
  expect(bodyHeight).toBeGreaterThan(90);
  await page.screenshot({
    path: 'test-results/screenshots/queued-question.png',
  });
  if (process.env.WORKBENCH_AXE_PATH) {
    await page.evaluate(readFileSync(process.env.WORKBENCH_AXE_PATH, 'utf8'));
    const violations = await page.evaluate(async () =>
      (
        await (window as any).axe.run(document, {
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
        })
      ).violations.map((v: any) => v.id),
    );
    expect(violations).toEqual([]);
  }
});

test('Send and keyboard send steer immediately, track pickup by client ID, and survive switching tasks', async ({
  page,
}) => {
  await concurrentFixture(page);
  const prompt = page.getByRole('textbox', { name: 'Task prompt' });
  await prompt.fill('Running steering task');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.evaluate(() => {
    (window as any).testHoldSteer = true;
  });
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  await prompt.fill('Focus on the failing tests');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const receipts = page.getByText('Sent to running task · awaiting pickup', {
    exact: true,
  });
  await expect(receipts).toHaveCount(1);
  await expect(
    page.getByRole('region', { name: 'Queued message' }),
  ).toHaveCount(0);
  await expect(prompt).toHaveValue('');
  await prompt.fill('Keep the public API unchanged');
  await prompt.press('Control+Enter');
  await expect(receipts).toHaveCount(2);
  const calls = await page.evaluate(() => (window as any).testCalls);
  const steers = calls.filter((c: any) => c.command === 'codex_steer_turn');
  expect(steers).toHaveLength(2);
  expect(steers[0].args).toMatchObject({
    threadId: 'concurrent-1',
    prompt: 'Focus on the failing tests',
    attachmentIds: ['brief', 'screen'],
  });
  expect(steers[0].args.turnId).toBe(steers[1].args.turnId);
  expect(steers[0].args.clientUserMessageId).not.toBe(
    steers[1].args.clientUserMessageId,
  );
  expect(
    calls.filter((c: any) => c.command === 'codex_start_turn'),
  ).toHaveLength(1);
  expect(
    calls.filter((c: any) => c.command === 'codex_interrupt_turn'),
  ).toHaveLength(0);
  // Pick up the second input first: only its own optimistic receipt is replaced.
  await page.evaluate(() => {
    const w = window as any;
    const item = w.heldSteers.pop();
    w.concurrentThreads[item.threadId].items.push(item);
    w.testEmit('timeline-item', item);
  });
  await expect(receipts).toHaveCount(1);
  await expect(
    page
      .locator('.timeline')
      .getByText('Keep the public API unchanged', { exact: true }),
  ).toHaveCount(1);
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await switchTask(page, 'Running steering task');
  await expect(receipts).toHaveCount(1);
  await page.evaluate(() => {
    const w = window as any;
    const item = w.heldSteers.pop();
    w.concurrentThreads[item.threadId].items.push(item);
    w.testEmit('timeline-item', item);
  });
  await expect(receipts).toHaveCount(0);
  await expect(
    page
      .locator('.timeline')
      .getByText('Focus on the failing tests', { exact: true }),
  ).toHaveCount(1);
});

test('failed default steering restores input and attachments without replacing an explicit next-turn queue', async ({
  page,
}) => {
  await concurrentFixture(page);
  const prompt = page.getByRole('textbox', { name: 'Task prompt' });
  await prompt.fill('Running task');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await prompt.fill('Do this after finishing');
  await page.getByRole('button', { name: 'Queue for next turn' }).click();
  await page.evaluate(() => {
    (window as any).testSteerError = 'Connection rejected input';
  });
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  await prompt.fill('Important correction');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(prompt).toHaveValue('Important correction');
  await expect(
    page.getByText(/Message not confirmed. Your draft is restored/),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Queued message' }),
  ).toContainText('Do this after finishing');
  await expect(
    page.getByRole('button', { name: 'Remove attachment brief.md' }),
  ).toBeVisible();
  await expect(
    page.getByText('Sent to running task · awaiting pickup'),
  ).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).testSteerError = null;
  });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(prompt).toHaveValue('');
  await expect(
    page
      .locator('.timeline')
      .getByText('Important correction', { exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole('region', { name: 'Queued message' }),
  ).toContainText('Do this after finishing');
});

test('@ mentions search the project only while typing and insert file paths', async ({
  page,
}) => {
  await openProject(page);
  const prompt = page.getByRole('textbox', { name: 'Task prompt' });
  await prompt.click();
  await page.keyboard.type('Explain @');
  const list = page.getByRole('listbox', { name: 'Files to mention' });
  await expect(list).toBeVisible();
  await expect(list.getByRole('option', { name: /hello\.txt/ })).toBeVisible();
  const searches = () =>
    page.evaluate(() =>
      (window as any).testCalls
        .filter((c: any) => c.command === 'codex_fuzzy_file_search')
        .map((c: any) => c.args.query),
    );
  expect(await searches()).toEqual([]);
  await page.keyboard.type('util');
  await expect(list.getByRole('option', { name: /util\.ts/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(prompt).toHaveValue('Explain @src/lib/deep/util.ts ');
  await expect(list).toHaveCount(0);
  expect(await searches()).toContain('util');
  expect(
    await page.evaluate(() =>
      (window as any).testCalls.some(
        (c: any) => c.command === 'codex_start_turn',
      ),
    ),
  ).toBe(false);
  // Without search, known files remain available.
  await page.evaluate(() => ((window as any).testSearchFails = true));
  await page.keyboard.type('and @hel');
  await expect(page.getByText('Showing files you have opened')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(prompt).toHaveValue(
    'Explain @src/lib/deep/util.ts and @hello.txt ',
  );
  await page.keyboard.type('@');
  await expect(list).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
});

test('retry resends a failed task and rewrite reverts history without sending', async ({
  page,
}) => {
  await concurrentFixture(page);
  const prompt = page.getByRole('textbox', { name: 'Task prompt' });
  await prompt.fill('Flaky task');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.evaluate(() => {
    const w = window as any;
    const t = w.concurrentThreads['concurrent-1'];
    t.turn.status = 'failed';
    w.testEmit('turn-completed', { threadId: t.id, turn: { ...t.turn } });
  });
  await expect(page.getByText('× Task failed')).toBeVisible();
  const starts = () =>
    page.evaluate(() =>
      (window as any).testCalls
        .filter((c: any) => c.command === 'codex_start_turn')
        .map((c: any) => c.args.prompt),
    );
  await page.getByRole('button', { name: '↻ Retry' }).click();
  await expect.poll(starts).toEqual(['Flaky task', 'Flaky task']);
  await page.evaluate(() => (window as any).concurrentFinish('concurrent-1'));
  await expect(page.getByText('✓ Task completed')).toBeVisible();
  const turnId = await page.evaluate(
    () => (window as any).concurrentThreads['concurrent-1'].turn.id,
  );
  const bubble = page.locator('.message.user').last();
  await bubble.hover();
  await bubble.getByRole('button', { name: 'Rewrite' }).click();
  const confirm = page.getByRole('dialog');
  await expect(confirm).toContainText(
    'Files Codex already changed stay as they are',
  );
  await confirm.getByRole('button', { name: 'Remove and edit' }).click();
  await expect(prompt).toHaveValue('Flaky task');
  const reverts = await page.evaluate(() =>
    (window as any).testCalls
      .filter((c: any) => c.command === 'codex_revert_thread')
      .map((c: any) => c.args),
  );
  expect(reverts).toEqual([{ threadId: 'concurrent-1', beforeTurnId: turnId }]);
  expect(await starts()).toEqual(['Flaky task', 'Flaky task']);
});
