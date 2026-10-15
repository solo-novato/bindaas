import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  mockDesktop,
  trailFixture,
  longConversation,
  readingOffset,
  installClaudeFixture,
  connectClaude,
  openProject,
} from './fixtures';

test.beforeEach(async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
});

test('trail evidence is accessible in both themes and has no continuous idle animations', async ({
  page,
}) => {
  test.skip(
    !process.env.WORKBENCH_AXE_PATH,
    'Set WORKBENCH_AXE_PATH to run the accessibility audit.',
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await trailFixture(page);
  await page.getByRole('button', { name: 'Trail', exact: true }).click();
  const trail = page.getByRole('region', { name: 'Agent trail', exact: true });
  await trail.getByRole('button', { name: '1 failed action' }).click();
  await page.evaluate(readFileSync(process.env.WORKBENCH_AXE_PATH!, 'utf8'));
  for (const theme of ['dark', 'light']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.appearance = value;
    }, theme);
    const violations = await page.evaluate(
      async () =>
        (
          await (window as any).axe.run(
            document.querySelector('.agent-trail'),
            {
              runOnly: {
                type: 'tag',
                values: ['wcag2a', 'wcag2aa', 'wcag21aa'],
              },
            },
          )
        ).violations,
    );
    expect(violations).toEqual([]);
  }
  expect(
    await trail.evaluate(
      (el) =>
        el
          .getAnimations({ subtree: true })
          .filter(
            (a) =>
              a.playState === 'running' &&
              a.effect?.getTiming().iterations === Infinity,
          ).length,
    ),
  ).toBe(0);
});

test('trail groups exploration and opens exact evidence without sending any agent messages', async ({
  page,
}) => {
  await trailFixture(page);
  await page.getByRole('button', { name: 'Trail', exact: true }).click();
  const trail = page.getByRole('region', { name: 'Agent trail', exact: true });
  await trail.getByRole('button', { name: /Read 2 files/ }).click();
  const evidence = trail.getByRole('region', { name: 'Moment evidence' });
  await expect(evidence).toContainText('cat src/main.ts');
  await evidence.getByRole('button', { name: '2. Read README.md' }).click();
  await expect(evidence).toContainText('# Session lifecycle');
  await trail.getByRole('button', { name: '1 failed action' }).click();
  await expect(evidence).toContainText('Expected: signed_out');
  await expect(evidence).toContainText('Failed · Exit 1');
  await expect(trail.getByRole('button', { name: /Run checks/ })).toContainText(
    'In progress',
  );
  await page.screenshot({
    path: 'test-results/screenshots/trail-dark.png',
    animations: 'disabled',
  });
  await page.evaluate(() => {
    document.documentElement.dataset.appearance = 'light';
  });
  await page.screenshot({
    path: 'test-results/screenshots/trail-light.png',
    animations: 'disabled',
  });
  await evidence.getByRole('button', { name: 'Show in transcript' }).click();
  await expect(
    page.getByRole('button', { name: 'Transcript', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.locator('[data-reading-key$=":check-failed"]'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Trail', exact: true }).click();
  await expect(evidence).toContainText('Expected: signed_out');
  const calls = await page.evaluate(() => (window as any).testCalls);
  expect(
    calls.filter((c: any) => c.command === 'codex_start_turn'),
  ).toHaveLength(1);
  expect(
    calls.filter((c: any) => c.command === 'codex_turn_items'),
  ).toHaveLength(0);
});

test('trail file buttons preserve literal percent and fragment characters', async ({
  page,
}) => {
  await trailFixture(page);
  await page.evaluate(() => {
    (window as any).trailEmit({
      id: 'literal-file',
      kind: 'command',
      title: 'Read',
      command: 'cat src/a%20b#1.ts',
      commandActions: [
        { type: 'read', path: '/fixture/project/src/a%20b#1.ts' },
      ],
      status: 'completed',
      exitCode: 0,
    });
  });
  await page.getByRole('button', { name: 'Trail', exact: true }).click();
  const trail = page.getByRole('region', { name: 'Agent trail', exact: true });
  await trail.getByRole('button', { name: /Read a%20b#1.ts/ }).click();
  await trail
    .getByRole('region', { name: 'Moment evidence' })
    .getByRole('button', {
      name: '/fixture/project/src/a%20b#1.ts',
      exact: true,
    })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).testCalls
            .filter((call: any) => call.command === 'file_read')
            .at(-1)?.args.relativePath,
      ),
    )
    .toBe('src/a%20b#1.ts');
});

test('live completion keeps the selected evidence and shows unknown outcomes after interruption', async ({
  page,
}) => {
  await trailFixture(page);
  await page.getByRole('button', { name: 'Trail', exact: true }).click();
  const trail = page.getByRole('region', { name: 'Agent trail', exact: true });
  await trail.getByRole('button', { name: '1 failed action' }).click();
  await page.evaluate(() =>
    (window as any).trailEmit({
      id: 'check-final',
      kind: 'command',
      title: 'Command',
      command: 'npm test -- session.test.ts',
      output: '12 passed, 0 failed',
      status: 'completed',
      exitCode: 0,
    }),
  );
  await expect(
    trail.getByRole('button', { name: /Check passed/ }),
  ).toBeVisible();
  await expect(
    trail.getByRole('region', { name: 'Moment evidence' }),
  ).toContainText('Expected: signed_out');
  await page.evaluate(() => {
    (window as any).trailEmit({
      id: 'unfinished',
      kind: 'command',
      title: 'Command',
      command: 'npm run build',
      status: 'inProgress',
    });
    (window as any).trailEmit({
      id: 'unfinished-note',
      kind: 'message',
      title: 'Codex',
      text: 'Still investigating the remaining issue',
      status: 'inProgress',
    });
  });
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(
    trail.getByRole('button', { name: /Run a command.*npm run build/ }),
  ).toContainText('Outcome unavailable');
  await expect(trail.locator('[data-status="running"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Transcript', exact: true }).click();
  const unfinished = page.locator('[data-reading-key$=":unfinished"]');
  await expect(unfinished).not.toHaveClass(/running/);
  await expect(unfinished).toContainText('Outcome unavailable');
  await unfinished.getByRole('button').first().click();
  await expect(unfinished).toContainText('No output was recorded.');
  const note = page.locator('[data-reading-key$=":unfinished-note"]');
  await expect(note).not.toHaveClass(/streaming/);
  await expect(note).toContainText('Outcome unavailable');
  await expect(
    note.getByRole('button', { name: 'Copy Codex response' }),
  ).toBeVisible();
  expect(
    await page
      .locator('.timeline')
      .evaluate(
        (node) =>
          node
            .getAnimations({ subtree: true })
            .filter(
              (animation) =>
                animation.playState === 'running' &&
                animation.effect?.getTiming().iterations === Infinity,
            ).length,
      ),
  ).toBe(0);
});

test('saved trail pages beyond the live window and reloads exact evidence on demand', async ({
  page,
}) => {
  await trailFixture(page);
  await page.evaluate(() => {
    const w = window as any,
      t = w.concurrentThreads['concurrent-1'];
    const old = Array.from({ length: 125 }, (_, i) => ({
      id: 'saved-' + i,
      threadId: t.id,
      turnId: t.turn.id,
      kind: 'command',
      title: 'Command',
      command: 'inspect-step-' + i,
      status: 'completed',
      output: 'Evidence for step ' + i,
      exitCode: 0,
    }));
    const invoke = w.testConcurrentInvoke;
    w.testConcurrentInvoke = (command: string, args: any) =>
      command === 'codex_turn_items'
        ? {
            data: old.slice(
              Number(args.cursor ?? 0),
              Number(args.cursor ?? 0) + 100,
            ),
            nextCursor: args.cursor ? null : '100',
          }
        : invoke(command, args);
  });
  await page.getByRole('button', { name: 'Trail', exact: true }).click();
  const trail = page.getByRole('region', { name: 'Agent trail', exact: true });
  await trail
    .getByRole('button', { name: 'From beginning', exact: true })
    .click();
  await expect(trail.locator('.trail-moment')).toHaveCount(100);
  await trail.getByRole('button', { name: 'Load next activity' }).click();
  await expect(trail.locator('.trail-moment')).toHaveCount(125);
  await trail.locator('.trail-moment').first().click();
  await expect(
    trail.getByRole('region', { name: 'Moment evidence' }),
  ).toContainText('Evidence for step 0');
  await expect(
    trail.getByRole('button', { name: 'Show in transcript' }),
  ).toHaveCount(0);
  await trail.getByRole('button', { name: 'Latest activity' }).click();
  await expect(
    trail.getByRole('button', { name: '1 failed action' }),
  ).toBeVisible();
});

test('retrying a failed history refresh starts from the beginning instead of appending another page', async ({
  page,
}) => {
  await trailFixture(page);
  await page.evaluate(() => {
    const w = window as any,
      invoke = w.testConcurrentInvoke,
      t = w.concurrentThreads['concurrent-1'];
    w.trailHistoryCursors = [];
    w.testConcurrentInvoke = (command: string, args: any) => {
      if (command !== 'codex_turn_items') return invoke(command, args);
      w.trailHistoryCursors.push(args.cursor);
      if (w.failTrailRefresh) {
        w.failTrailRefresh = false;
        throw Error('Refresh temporarily unavailable');
      }
      return {
        data: [
          {
            id: args.cursor ? 'next-saved' : 'first-saved',
            threadId: t.id,
            turnId: t.turn.id,
            kind: 'message',
            title: 'Codex',
            text: args.cursor ? 'Next saved page' : 'First saved page',
            status: 'completed',
          },
        ],
        nextCursor: args.cursor ? null : 'next',
      };
    };
  });
  await page.getByRole('button', { name: 'Trail', exact: true }).click();
  const trail = page.getByRole('region', { name: 'Agent trail', exact: true });
  await trail
    .getByRole('button', { name: 'From beginning', exact: true })
    .click();
  await expect(trail.locator('.trail-moment')).toHaveCount(1);
  await page.evaluate(() => {
    (window as any).failTrailRefresh = true;
  });
  await trail
    .getByRole('button', { name: 'Refresh history', exact: true })
    .click();
  await expect(trail).toContainText('Refresh temporarily unavailable');
  await trail.getByRole('button', { name: 'Retry history' }).click();
  await expect(trail).not.toContainText('Refresh temporarily unavailable');
  await expect(trail.locator('.trail-moment')).toHaveCount(1);
  expect(
    await page.evaluate(() => (window as any).trailHistoryCursors),
  ).toEqual([null, null, null]);
  await trail.getByRole('button', { name: 'Load next activity' }).click();
  await expect(trail.locator('.trail-moment')).toHaveCount(2);
});

test('history errors preserve the trail and an in-flight result cannot enter another conversation', async ({
  page,
}) => {
  await trailFixture(page);
  await page.evaluate(() => {
    const w = window as any,
      invoke = w.testConcurrentInvoke;
    w.testConcurrentInvoke = (command: string, args: any) => {
      if (command === 'codex_turn_items') {
        if (!w.holdTrailHistory) throw Error('History temporarily unavailable');
        return new Promise((resolve) => {
          w.resolveTrail = resolve;
        });
      }
      return invoke(command, args);
    };
  });
  await page.getByRole('button', { name: 'Trail', exact: true }).click();
  await page
    .getByRole('button', { name: 'From beginning', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Agent trail', exact: true }),
  ).toContainText('History temporarily unavailable');
  await expect(
    page.getByRole('button', { name: /Read 2 files/ }),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as any).holdTrailHistory = true;
  });
  await page.getByRole('button', { name: 'Retry history' }).click();
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('A separate request');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.evaluate(() => {
    (window as any).resolveTrail({
      data: [
        {
          id: 'stale',
          threadId: 'concurrent-1',
          turnId: 'turn-1',
          kind: 'message',
          title: 'Codex',
          text: 'STALE HISTORY',
          status: 'completed',
        },
      ],
      nextCursor: null,
    });
  });
  await page.getByRole('button', { name: 'Trail', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Agent trail', exact: true }),
  ).not.toContainText('STALE HISTORY');
});

test('trail switching preserves a scrolled transcript and keyboard navigation works in compact layouts', async ({
  page,
}) => {
  await longConversation(page);
  const before = await readingOffset(page);
  await page.getByRole('button', { name: 'Trail', exact: true }).click();
  await page.getByRole('button', { name: 'Transcript', exact: true }).click();
  expect(Math.abs((await readingOffset(page)) - before)).toBeLessThan(4);
  await page.setViewportSize({ width: 1440, height: 768 });
  await page.getByRole('separator', { name: 'Resize inspector' }).focus();
  await page.keyboard.press('End');
  await page.getByRole('button', { name: 'Trail', exact: true }).click();
  const trail = page.getByRole('region', { name: 'Agent trail', exact: true });
  await trail.locator('.trail-moment').first().focus();
  await page.keyboard.press('Enter');
  await expect(
    trail.getByRole('button', { name: 'All moments' }),
  ).toBeVisible();
  await expect(trail.locator('.trail-evidence-title h3')).toBeFocused();
  await trail.getByRole('button', { name: 'All moments' }).click();
  await expect(trail.locator('.trail-moment').first()).toBeVisible();
  await expect(trail.locator('.trail-moment').first()).toBeFocused();
  await expect(
    trail.getByRole('region', { name: 'Moment evidence' }),
  ).toBeHidden();
  const overflow = await trail.evaluate(
    (el) => el.scrollWidth > el.clientWidth + 1,
  );
  expect(overflow).toBe(false);
  await page.screenshot({
    path: 'test-results/screenshots/trail-compact.png',
    animations: 'disabled',
  });
});

test('Claude read metadata and delegated relationships produce the same trail without invented exit codes', async ({
  page,
}) => {
  await openProject(page);
  await installClaudeFixture(page);
  await connectClaude(page);
  await page
    .getByRole('combobox', { name: 'Agent', exact: true })
    .selectOption('claude');
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Inspect session handling');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.evaluate(() => {
    const w = window as any;
    w.testEmit('timeline-item', {
      id: 'claude-read',
      threadId: 'claude:11111111-1111-4111-8111-111111111111',
      turnId: 'claude-turn-1',
      kind: 'tool',
      title: 'Read',
      status: 'completed',
      toolInput: { path: 'src/main.ts' },
      output: 'Claude source evidence',
      parentToolId: 'delegate-1',
    });
  });
  await page.getByRole('button', { name: 'Trail', exact: true }).click();
  const trail = page.getByRole('region', { name: 'Agent trail', exact: true });
  await trail.getByRole('button', { name: /Read main.ts/ }).click();
  await expect(
    trail.getByRole('region', { name: 'Moment evidence' }),
  ).toContainText('Claude source evidence');
  await expect(
    trail.getByRole('region', { name: 'Moment evidence' }),
  ).toContainText('Delegated from an activity outside this view');
  await expect(
    trail.getByRole('region', { name: 'Moment evidence' }),
  ).not.toContainText('Exit 0');
});
