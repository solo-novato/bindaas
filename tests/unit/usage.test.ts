import { describe, expect, it } from 'vitest';
import { dailyUsage, remaining, usageAnalysis } from '../../src/lib/usage';
import type { UsageSample, UsageWindow } from '../../src/lib/types';

const day = 86400;
const now = new Date(2026, 9, 10).getTime() / 1000; // Saturday in local time.
const bucket = 'codex:secondary';
function window(used = 80, reset = now + 2 * day): UsageWindow {
  return { usedPercent: used, windowDurationMins: 10080, resetsAt: reset };
}
function history(count = 28, weekday = 8, weekend = 1): UsageSample[] {
  return Array.from({ length: count }, (_, i) => {
    const at = now - (count - i) * day;
    const dow = new Date(at * 1000).getDay();
    const used = dow === 0 || dow === 6 ? weekend : weekday;
    const base = { bucket, minutes: 10080, reset: at + 7 * day };
    return [
      { ...base, at, used: 0 },
      { ...base, at: at + day - 1, used },
    ];
  }).flat();
}

describe('account usage forecast', () => {
  it('learns lighter weekends from all historical days instead of assuming a flat daily rate', () => {
    const analysis = usageAnalysis(window(), history(), bucket, now);
    expect(analysis.observedDays).toBe(28);
    expect(analysis.forecast?.patterned).toBe(true);
    expect(analysis.forecast!.demand).toBeLessThan(6);
    expect(analysis.forecast!.headroom).toBeGreaterThan(14);
    expect(analysis.forecast!.status).toBe('Projected to last until reset');
    expect(analysis.dailyAverage).toBe(16);
    expect(analysis.dailyBudget).toBe(10);
  });
  it('forecasts depletion and varies hue continuously with headroom', () => {
    const hues = [98, 97, 96, 95, 94, 93, 92].map(
      (used) =>
        usageAnalysis(window(used), history(), bucket, now).forecast!.hue,
    );
    expect(new Set(hues).size).toBe(hues.length);
    expect(hues).toEqual([...hues].sort((a, b) => a - b));
    const forecast = usageAnalysis(
      window(98),
      history(),
      bucket,
      now,
    ).forecast!;
    expect(forecast.exhaustion).toBeGreaterThan(now);
    expect(forecast.exhaustion).toBeLessThan(now + 2 * day);
    expect(forecast.headroom).toBeLessThan(0);
  });
  it('uses a provisional current-cycle pace until enough historical exposure is available', () => {
    const provisional = usageAnalysis(window(), [], bucket, now).forecast!;
    expect(provisional.basis).toBe('current-period');
    expect(provisional.demand).toBe(32);
    expect(provisional.headroom).toBe(-12);
    expect(provisional.patterned).toBe(false);
    expect(
      usageAnalysis(window(), history(2), bucket, now).forecast?.basis,
    ).toBe('current-period');
    expect(
      usageAnalysis(window(), history(3), bucket, now).forecast?.basis,
    ).toBe('history');
    expect(
      usageAnalysis(window(), history(14), bucket, now).forecast?.basis,
    ).toBe('weekday');
    expect(usageAnalysis(window(), [], bucket, now).today).toBeUndefined();
  });
  it('waits for a meaningful elapsed period before extrapolating a new limit', () => {
    expect(
      usageAnalysis(window(1, now + 7 * day - 60), [], bucket, now).forecast,
    ).toBeNull();
    const short = {
      usedPercent: 20,
      windowDurationMins: 300,
      resetsAt: now + 300 * 60 - 1800,
    };
    expect(usageAnalysis(short, [], bucket, now).forecast?.basis).toBe(
      'current-period',
    );
    expect(
      usageAnalysis({ ...short, resetsAt: short.resetsAt + 1 }, [], bucket, now)
        .forecast,
    ).toBeNull();
  });
  it('uses partial historical days by their exposure and excludes future or unrelated samples', () => {
    const partial = history().map((s, i) =>
      i % 2 ? { ...s, at: s.at - 4 * 3600 } : s,
    );
    const result = usageAnalysis(window(), partial, bucket, now);
    expect(result.observedDays).toBe(28);
    expect(result.observedDayEquivalents).toBeCloseTo((28 * 20) / 24, 2);
    expect(result.forecast?.basis).toBe('weekday');
    expect(result.forecast?.demand).toBeCloseTo(2.4, 2);
    for (const [samples, id] of [
      [history(), 'other:secondary'],
      [history().map((s) => ({ ...s, at: s.at + 60 * day })), bucket],
    ] as const) {
      const excluded = usageAnalysis(window(), [...samples], id, now);
      expect(excluded.observedDays).toBe(0);
      expect(excluded.forecast?.basis).toBe('current-period');
      expect(excluded.forecast?.demand).toBe(32);
    }
    expect(
      usageAnalysis(
        { ...window(), windowDurationMins: 300 },
        history(),
        bucket,
        now,
      ).forecast,
    ).toBeNull();
  });
  it('20% lasts through quiet Saturday and Sunday but not busy Tuesday and Wednesday, without other weekdays', () => {
    const samples = history(28, 15, 3.5).filter((s) =>
      [0, 2, 3, 6].includes(new Date(s.at * 1000).getDay()),
    );
    const weekend = usageAnalysis(window(), samples, bucket, now).forecast!;
    const tuesday = now + 3 * day;
    const workweek = usageAnalysis(
      window(80, tuesday + 2 * day),
      samples,
      bucket,
      tuesday,
    ).forecast!;
    expect(weekend.basis).toBe('weekday');
    expect(weekend.demand).toBeCloseTo(7, 2);
    expect(weekend.headroom).toBeCloseTo(13, 2);
    expect(weekend.exhaustion).toBeNull();
    expect(workweek.demand).toBeCloseTo(30, 2);
    expect(workweek.headroom).toBeCloseTo(-10, 2);
    expect(workweek.exhaustion).toBeGreaterThan(tuesday + day);
    expect(workweek.exhaustion).toBeLessThan(tuesday + 2 * day);
    expect(weekend.limited).toBe(false);
    expect(workweek.limited).toBe(false);
  });
  it('prorates actual remaining dates and falls back only for a missing weekday', () => {
    const samples = history().filter(
      (s) => new Date(s.at * 1000).getDay() !== 0,
    );
    const forecast = usageAnalysis(
      window(80, now + 1.5 * day),
      samples,
      bucket,
      now + 0.5 * day,
    ).forecast!;
    expect(forecast.days).toHaveLength(2);
    expect(forecast.days[0].source).toBe('weekday');
    expect(forecast.days[0].demand).toBeCloseTo(0.5, 2);
    expect(forecast.days[0].fraction).toBe(0.5);
    expect(forecast.days[1].source).toBe('history');
    expect(forecast.days[1].observations).toBe(0);
    expect(forecast.days[1].demand).toBeGreaterThan(0);
    expect(forecast.limited).toBe(true);
    expect(forecast.demand).toBe(
      forecast.days.reduce((sum, d) => sum + d.demand, 0),
    );
  });
  it('weights a short observation by its duration rather than treating it as a whole day', () => {
    const samples = Array.from({ length: 4 }, (_, i) => {
      const at = now - (i + 1) * 7 * day;
      const base = { bucket, minutes: 10080, reset: at + 7 * day };
      return [
        { ...base, at, used: 0 },
        { ...base, at: at + (i === 0 ? 3600 : day), used: i === 0 ? 1 : 8 },
      ];
    }).flat();
    const result = usageAnalysis(window(80, now + day), samples, bucket, now);
    expect(result.observedDays).toBe(4);
    expect(result.observedDayEquivalents).toBeCloseTo(3 + 1 / 24);
    expect(result.forecast?.days[0].source).toBe('weekday');
    expect(result.forecast?.demand).toBeCloseTo(25 / (3 + 1 / 24));
  });
  it('does not turn missing/reset/corrected/saturated counters into measured daily usage', () => {
    const a = {
      at: now,
      used: 20,
      reset: now + 7 * day,
      minutes: 10080,
      bucket,
    };
    for (const b of [
      { ...a, at: now + day, reset: now + 8 * day, used: 30 },
      { ...a, at: now + day, used: 10 },
      { ...a, at: now + day, used: 100 },
      { ...a, at: now + 3 * day, used: 40 },
    ])
      expect(dailyUsage([a, b], bucket, 10080)).toEqual([]);
    // A flat counter across a quiet weekend is real evidence of zero usage.
    const quiet = dailyUsage([a, { ...a, at: now + 2 * day }], bucket, 10080);
    expect(quiet).toHaveLength(2);
    expect(quiet.every((d) => d.used === 0 && d.covered === d.seconds)).toBe(
      true,
    );
  });
  it('keeps missing and expired limits unknown; zero-use history is valid', () => {
    expect(remaining({ ...window(), usedPercent: null })).toBeNull();
    expect(remaining({ ...window(), usedPercent: NaN })).toBeNull();
    expect(
      usageAnalysis(window(80, now), history(), bucket, now).forecast,
    ).toBeNull();
    expect(
      usageAnalysis(window(80, now + 20 * day), history(), bucket, now)
        .forecast,
    ).toBeNull();
    expect(
      usageAnalysis(window(), history(28, 0, 0), bucket, now).forecast?.demand,
    ).toBe(0);
  });
});
