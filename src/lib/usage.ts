import type { UsageSample, UsageWindow } from './types';

const DAY = 86400;
export function remaining(window: UsageWindow) {
  const used = window.usedPercent;
  return typeof used === 'number' && Number.isFinite(used)
    ? Math.max(0, Math.min(100, 100 - used))
    : null;
}
function dayStart(at: number) {
  const date = new Date(at * 1000);
  date.setHours(0, 0, 0, 0);
  return date.getTime() / 1000;
}
function nextDay(at: number) {
  const date = new Date(at * 1000);
  date.setDate(date.getDate() + 1);
  date.setHours(0, 0, 0, 0);
  return date.getTime() / 1000;
}
export type UsageDay = {
  at: number;
  used: number;
  covered: number;
  seconds: number;
};

export type ForecastDay = {
  at: number;
  until: number;
  demand: number;
  fraction: number;
  observations: number;
  covered: number;
  source: 'weekday' | 'blended' | 'history' | 'current-period';
};

/** Only differences within the same quota cycle are comparable. Missing time is
 * never zero usage. Positive multi-day gaps cannot teach us weekday patterns. */
export function dailyUsage(
  samples: UsageSample[],
  bucket: string,
  minutes: number,
) {
  const points = samples
    .filter(
      (s) =>
        s.bucket === bucket &&
        s.minutes === minutes &&
        Number.isFinite(s.at) &&
        Number.isFinite(s.reset) &&
        Number.isFinite(s.used) &&
        s.used >= 0 &&
        s.used <= 100,
    )
    .sort((a, b) => a.at - b.at);
  const days = new Map<number, UsageDay>();
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    const seconds = b.at - a.at,
      delta = b.used - a.used;
    if (
      seconds <= 0 ||
      a.reset !== b.reset ||
      b.at > b.reset ||
      delta < 0 ||
      seconds > minutes * 60 ||
      (seconds > 36 * 3600 && delta > 0) ||
      // A saturated counter cannot reveal demand beyond the limit.
      a.used >= 100 ||
      b.used >= 100
    )
      continue;
    for (let cursor = a.at; cursor < b.at;) {
      const start = dayStart(cursor),
        end = nextDay(cursor);
      const until = Math.min(end, b.at),
        span = until - cursor;
      const day = days.get(start) ?? {
        at: start,
        used: 0,
        covered: 0,
        seconds: end - start,
      };
      day.used += (delta * span) / seconds;
      day.covered += span;
      days.set(start, day);
      cursor = until;
    }
  }
  return [...days.values()].sort((a, b) => a.at - b.at);
}

export function usageAnalysis(
  window: UsageWindow,
  samples: UsageSample[],
  bucket: string,
  now: number,
) {
  const left = remaining(window),
    minutes = window.windowDurationMins;
  const reset = window.resetsAt;
  const valid =
    left !== null &&
    minutes !== null &&
    minutes > 0 &&
    reset !== null &&
    reset > now &&
    reset - now <= minutes * 60;
  const daysLeft = valid ? (reset - now) / DAY : null;
  const elapsed = valid ? (minutes * 60 - (reset - now)) / DAY : 0;
  const days = minutes
    ? dailyUsage(
        samples.filter((s) => s.at <= now),
        bucket,
        minutes,
      )
    : [];
  const today = days.find((d) => d.at === dayStart(now));
  // Past days only. Partial days contribute observed usage and exposure, not
  // a zero for missing hours or the same weight as a fully observed day.
  const training = days.filter((d) => d.at < dayStart(now) && d.covered > 0);
  const exposure = (group: UsageDay[]) =>
    group.reduce((sum, d) => sum + d.covered / d.seconds, 0);
  const observedDayEquivalents = exposure(training);
  const average = observedDayEquivalents
    ? training.reduce((sum, d) => sum + d.used, 0) / observedDayEquivalents
    : 0;
  const weekdays = Array.from({ length: 7 }, (_, weekday) => {
    const group = training.filter(
      (d) => new Date(d.at * 1000).getDay() === weekday,
    );
    const covered = exposure(group);
    // Learn each weekday independently. Roughly two days of coverage support
    // its own rate; thinner evidence blends with the overall observed rate.
    const prior = Math.max(0, 1.8 - covered);
    return {
      rate:
        (group.reduce((sum, d) => sum + d.used, 0) + average * prior) /
        Math.max(1.8, covered),
      observations: group.length,
      covered,
      source:
        covered >= 1.8
          ? ('weekday' as const)
          : covered > 0
            ? ('blended' as const)
            : ('history' as const),
    };
  });
  let forecast: null | {
    demand: number;
    headroom: number;
    exhaustion: number | null;
    patterned: boolean;
    basis: 'weekday' | 'history' | 'current-period';
    hue: number;
    status: string;
    days: ForecastDay[];
    limited: boolean;
  } = null;
  const historical = observedDayEquivalents >= 2.7;
  // A current-cycle counter already summarizes usage since that cycle began.
  // Use it for an explicitly provisional estimate while history is sparse.
  // Wait at least an hour (or 10% of a short window) to avoid a near-zero divisor.
  const provisional =
    valid && elapsed * DAY >= Math.min(3600, minutes * 60 * 0.1);
  if (valid && (historical || provisional)) {
    const forecastDays: ForecastDay[] = [];
    let demand = 0,
      exhaustion: number | null = null;
    for (let cursor = now; cursor < reset;) {
      const end = Math.min(reset, nextDay(cursor));
      const weekday = weekdays[new Date(cursor * 1000).getDay()];
      const rate = historical ? weekday.rate : (100 - left) / elapsed;
      const cost = historical
        ? (rate * (end - cursor)) / (nextDay(cursor) - dayStart(cursor))
        : (rate * (end - cursor)) / DAY;
      if (exhaustion === null && cost > 0 && demand + cost >= left)
        exhaustion = cursor + ((left - demand) / cost) * (end - cursor);
      forecastDays.push({
        at: cursor,
        until: end,
        demand: cost,
        fraction: (end - cursor) / (nextDay(cursor) - dayStart(cursor)),
        observations: historical ? weekday.observations : 0,
        covered: historical ? weekday.covered : 0,
        source: historical ? weekday.source : 'current-period',
      });
      demand += cost;
      cursor = end;
    }
    const headroom = left - demand;
    // Continuous hue: 0 red at a large deficit, 55 amber near the boundary,
    // 125 green with comfortable headroom. No artificial three-color steps.
    const margin = (left - demand) / Math.max(10, left, demand);
    const hue = Math.max(0, Math.min(125, 55 + margin * 140));
    const patterned = forecastDays.some(
      (d) => d.source === 'weekday' || d.source === 'blended',
    );
    forecast = {
      demand,
      headroom,
      exhaustion,
      patterned,
      basis: patterned ? 'weekday' : historical ? 'history' : 'current-period',
      days: forecastDays,
      limited: forecastDays.some((d) => d.source !== 'weekday'),
      hue,
      status:
        headroom < 0
          ? 'Projected to run out before reset'
          : headroom < 10
            ? 'Close to the limit at reset'
            : 'Projected to last until reset',
    };
  }
  return {
    left,
    daysLeft,
    dailyAverage: elapsed > 0 ? (100 - left!) / elapsed : null,
    dailyBudget: daysLeft ? left! / daysLeft : null,
    days,
    today,
    observedDays: training.length,
    observedDayEquivalents,
    forecast,
  };
}
