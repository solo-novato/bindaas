import { test, expect } from '@playwright/test';
import { mockDesktop, resumeFixture } from './fixtures';

const now = new Date(2026, 9, 10).getTime() / 1000;
const day = 86400;
function status(used = 80, email = 'fixture@example.test') {
  const history = Array.from({ length: 28 }, (_, i) => {
    const at = now - (28 - i) * day;
    const dow = new Date(at * 1000).getDay();
    const base = {
      bucket: 'codex:secondary',
      minutes: 10080,
      reset: at + 7 * day,
    };
    return [
      { ...base, at, used: 0 },
      { ...base, at: at + day - 1, used: dow === 0 || dow === 6 ? 1 : 8 },
    ];
  }).flat();
  return {
    generation: 1,
    observedAt: now,
    history,
    account: { type: 'chatgpt', email, planType: 'pro' },
    accountError: null,
    limitsError: null,
    limits: {
      ordinaryUsageAllowed: true,
      buckets: [
        {
          id: 'codex',
          name: 'Codex',
          plan: 'pro',
          primary: null,
          secondary: {
            usedPercent: used,
            windowDurationMins: 10080,
            resetsAt: now + 2 * day,
          },
        },
      ],
    },
  };
}

test.beforeEach(async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
  await resumeFixture(page);
  await page.evaluate(() =>
    (window as any).testEmit('connection', { type: 'ready', generation: 1 }),
  );
  await expect(
    page
      .getByRole('region', { name: 'Account usage remaining' })
      .getByText('75% remaining'),
  ).toBeVisible();
});

test('bottom bar stays separate, forecasts weekends and changes its gradient as headroom shrinks', async ({
  page,
}) => {
  const bar = page.getByRole('region', { name: 'Account usage remaining' });
  await page.evaluate((value) => {
    (window as any).testAccountStatus = value;
    (window as any).testEmit('rate-limits-changed', { generation: 1 });
  }, status());
  await expect(bar.getByText('20% remaining')).toBeVisible();
  await expect(bar.getByText('Projected to last until reset')).toBeVisible();
  const healthy = await bar.locator('.gauge-fill').getAttribute('style');
  expect(healthy).toContain('linear-gradient');
  await bar.getByRole('button', { name: /Usage analysis/ }).click();
  const panel = page.getByRole('dialog', { name: 'Session controls' });
  await expect(panel.getByText('Average per day so far')).toBeVisible();
  await expect(panel.getByText('16.0%', { exact: true })).toBeVisible();
  await expect(panel.getByText(/Weekday-aware estimate/)).toBeVisible();
  await expect(
    panel.getByRole('meter', { name: /limit remaining/ }),
  ).toHaveCount(0);
  await panel.getByText('Daily usage · recent observations').click();
  await expect(
    panel.getByRole('table', { name: 'Observed daily usage' }),
  ).toBeVisible();
  await page.screenshot({ path: 'test-results/usage-analysis.png' });
  await page.keyboard.press('Escape');
  await page.evaluate((value) => {
    (window as any).testAccountStatus = value;
    (window as any).testEmit('rate-limits-changed', { generation: 1 });
  }, status(98));
  await expect(
    bar.getByText('Projected to run out before reset'),
  ).toBeVisible();
  await expect(bar.getByRole('meter')).toHaveAttribute('aria-valuenow', '2');
  expect(await bar.locator('.gauge-fill').getAttribute('style')).not.toBe(
    healthy,
  );
  await page.screenshot({ path: 'test-results/usage-bottom-bar.png' });
});

test('a newly started limit is neutral and account switches never reuse the previous forecast', async ({
  page,
}) => {
  const bar = page.getByRole('region', { name: 'Account usage remaining' });
  await page.evaluate((value) => {
    (window as any).testAccountStatus = value;
    (window as any).testEmit('rate-limits-changed', { generation: 1 });
  }, status());
  await expect(bar.getByText('Projected to last until reset')).toBeVisible();
  await page.evaluate(
    ({ value, reset }) => {
      value.limits.buckets[0].secondary.resetsAt = reset;
      (window as any).testAccountStatus = { ...value, history: [] };
      (window as any).testEmit('auth-updated', {
        generation: 1,
        changed: true,
      });
    },
    { value: status(10, 'new@example.test'), reset: now + 7 * day - 60 },
  );
  await expect(bar.getByText('Forecast learning')).toBeVisible();
  await expect(bar.getByText('90% remaining')).toBeVisible();
  expect(await bar.locator('.gauge-fill').getAttribute('style')).not.toContain(
    'linear-gradient',
  );
  await bar.getByRole('button', { name: /Usage analysis/ }).click();
  await expect(
    page.getByRole('dialog').getByText('new@example.test · pro'),
  ).toBeVisible();
  await expect(
    page
      .getByRole('dialog')
      .getByText('This limit period has only just started.', { exact: false }),
  ).toBeVisible();
});

test('stale or unavailable included usage never keeps a healthy forecast color', async ({
  page,
}) => {
  const bar = page.getByRole('region', { name: 'Account usage remaining' });
  await page.evaluate((value) => {
    (window as any).testAccountStatus = value;
    (window as any).testEmit('rate-limits-changed', { generation: 1 });
  }, status());
  await expect(bar.getByText('Projected to last until reset')).toBeVisible();
  await page.evaluate(() =>
    (window as any).testEmit('connection', { type: 'sleeping', generation: 1 }),
  );
  await expect(
    bar.getByText('Last reported · refresh to update'),
  ).toBeVisible();
  expect(await bar.locator('.gauge-fill').getAttribute('style')).not.toContain(
    'linear-gradient',
  );
  await page.evaluate((value) => {
    value.limits.ordinaryUsageAllowed = false;
    (window as any).testAccountStatus = value;
    (window as any).testEmit('connection', { type: 'ready', generation: 1 });
  }, status());
  await expect(bar.getByRole('meter')).toHaveAttribute(
    'aria-valuetext',
    /Included usage unavailable/,
  );
  expect(await bar.locator('.gauge-fill').getAttribute('style')).not.toContain(
    'linear-gradient',
  );
  await bar.getByRole('button', { name: /Usage analysis/ }).click();
  await expect(
    page
      .getByRole('dialog')
      .getByText(
        'Included usage is unavailable. Forecast paused until Codex reports recovery.',
      ),
  ).toBeVisible();
});

test('a primary limit with unknown timing still shows its reported allowance', async ({
  page,
}) => {
  const bar = page.getByRole('region', { name: 'Account usage remaining' });
  await page.evaluate((value) => {
    (window as any).testAccountStatus = {
      ...value,
      limits: {
        ...value.limits,
        buckets: [
          {
            ...value.limits.buckets[0],
            primary: {
              usedPercent: 80,
              windowDurationMins: null,
              resetsAt: null,
            },
            secondary: null,
          },
        ],
      },
    };
    (window as any).testEmit('rate-limits-changed', { generation: 1 });
  }, status());
  await expect(bar.getByText('20% remaining')).toBeVisible();
  await bar.getByRole('button', { name: /Usage analysis/ }).click();
  const panel = page.getByRole('dialog');
  await expect(panel.getByText('80.0%', { exact: true })).toBeVisible();
  await expect(panel.getByText('20.0%', { exact: true })).toBeVisible();
  await expect(
    panel.getByText('Reset timing unavailable.', { exact: false }),
  ).toBeVisible();
  await expect(
    panel.getByRole('table', { name: 'Forecast by day' }),
  ).toHaveCount(0);
});

test('an open overview pauses stale forecasts and recovers with the shared usage refresh', async ({
  page,
}) => {
  const bar = page.getByRole('region', { name: 'Account usage remaining' });
  await page.evaluate((value) => {
    (window as any).testAccountStatus = value;
    (window as any).testEmit('rate-limits-changed', { generation: 1 });
  }, status());
  await expect(bar.getByText('Projected to last until reset')).toBeVisible();
  await bar.getByRole('button', { name: /Usage analysis/ }).click();
  const panel = page.getByRole('dialog');
  await expect(
    panel.getByRole('table', { name: 'Forecast by day' }),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as any).testEmit('connection', { type: 'sleeping', generation: 1 });
  });
  await expect(
    panel.getByText(
      'Last reported usage. Refresh status to update the forecast.',
    ),
  ).toBeVisible();
  await expect(
    panel.getByRole('table', { name: 'Forecast by day' }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).testConcurrentInvoke = (command: string) => {
      if (command === 'codex_account_status') throw Error('Quota read failed');
    };
  });
  await panel.getByRole('button', { name: 'Refresh status' }).click();
  await expect(
    panel.getByText('Quota read failed', { exact: false }),
  ).toBeVisible();
  await expect(
    panel.getByRole('table', { name: 'Forecast by day' }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).testConcurrentInvoke = undefined;
    (window as any).testEmit('rate-limits-changed', { generation: 1 });
  });
  await expect(
    panel.getByRole('table', { name: 'Forecast by day' }),
  ).toBeVisible();
  await expect(
    panel.getByText('Quota read failed', { exact: false }),
  ).toHaveCount(0);
  await expect(
    panel.getByText('Last reported usage.', { exact: false }),
  ).toHaveCount(0);
});

test('current-period estimate is available without waiting for new history and imported evidence is explained', async ({
  page,
}) => {
  const bar = page.getByRole('region', { name: 'Account usage remaining' });
  await page.evaluate((value) => {
    (window as any).testAccountStatus = {
      ...value,
      history: [],
      historyImport: {
        at: value.observedAt,
        files: 39,
        observations: 3275,
        legacyFiles: 12,
        limited: false,
      },
    };
    (window as any).testEmit('rate-limits-changed', { generation: 1 });
  }, status());
  await expect(
    bar.getByText('Provisional · Projected to run out before reset'),
  ).toBeVisible();
  expect(await bar.locator('.gauge-fill').getAttribute('style')).toContain(
    'linear-gradient',
  );
  await bar.getByRole('button', { name: /Usage analysis/ }).click();
  const panel = page.getByRole('dialog');
  await expect(
    panel.getByText('Based on usage since this limit period began.', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    panel.getByText(
      'Imported 3,275 usage observations from 39 Codex sessions across this profile.',
      { exact: false },
    ),
  ).toBeVisible();
  await expect(
    panel.getByText(/across all projects in this Codex profile/),
  ).toBeVisible();
  await expect(
    panel.getByText(/12 older sessions predate account IDs/),
  ).toBeVisible();
  await expect(
    panel
      .getByRole('table', { name: 'Forecast by day' })
      .getByRole('row')
      .filter({ hasText: 'Total until reset' }),
  ).toContainText('32.0%');
});

test('the same remaining allowance changes outlook for weekends versus weekdays and shows the daily calculation', async ({
  page,
}) => {
  const value = status();
  value.history = value.history
    .filter((s) => [0, 2, 3, 6].includes(new Date(s.at * 1000).getDay()))
    .map((s) => ({
      ...s,
      used:
        s.used === 0
          ? 0
          : [0, 6].includes(new Date(s.at * 1000).getDay())
            ? 3.5
            : 15,
    }));
  const bar = page.getByRole('region', { name: 'Account usage remaining' });
  await page.evaluate((value) => {
    (window as any).testAccountStatus = value;
    (window as any).testEmit('rate-limits-changed', { generation: 1 });
  }, value);
  await expect(bar.getByText('20% remaining')).toBeVisible();
  await expect(bar.getByText('Projected to last until reset')).toBeVisible();
  await bar.getByRole('button', { name: /Usage analysis/ }).click();
  const table = page.getByRole('table', { name: 'Forecast by day' });
  await expect(table.getByRole('row').filter({ hasText: 'Sat' })).toContainText(
    '3.5%',
  );
  await expect(table.getByRole('row').filter({ hasText: 'Sun' })).toContainText(
    '3.5%',
  );
  await expect(
    table.getByRole('row').filter({ hasText: 'Total until reset' }),
  ).toContainText('7.0%');
  await expect(
    page.getByRole('dialog').getByText(/13.0% expected to remain/),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await page.evaluate((value) => {
    (window as any).testAccountStatus = {
      ...value,
      history: value.history.filter(
        (s) => new Date(s.at * 1000).getDay() !== 0,
      ),
    };
    (window as any).testEmit('rate-limits-changed', { generation: 1 });
  }, value);
  await bar.getByRole('button', { name: /Usage analysis/ }).click();
  await expect(table.getByRole('row').filter({ hasText: 'Sun' })).toContainText(
    'Overall average · no observations for this weekday',
  );
  await expect(
    page
      .getByRole('dialog')
      .getByText('Some dates have limited weekday coverage.', { exact: false }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  value.observedAt += 3 * day;
  value.limits.buckets[0].secondary.resetsAt += 3 * day;
  await page.evaluate((value) => {
    (window as any).testAccountStatus = value;
    (window as any).testEmit('rate-limits-changed', { generation: 1 });
  }, value);
  await expect(bar.getByText('20% remaining')).toBeVisible();
  await expect(
    bar.getByText('Projected to run out before reset'),
  ).toBeVisible();
  await bar.getByRole('button', { name: /Usage analysis/ }).click();
  await expect(table.getByRole('row').filter({ hasText: 'Tue' })).toContainText(
    '15.0%',
  );
  await expect(table.getByRole('row').filter({ hasText: 'Wed' })).toContainText(
    '15.0%',
  );
  await expect(
    table.getByRole('row').filter({ hasText: 'Total until reset' }),
  ).toContainText('30.0%');
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    );
  });
  await expect(page.getByRole('dialog')).toHaveCSS('opacity', '1');
  await page.screenshot({ path: 'test-results/usage-daily-forecast.png' });
});
