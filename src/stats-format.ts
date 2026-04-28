import type { ClaudeDailyUsage, ClaudeStatsReport } from './claude-stats.js';
import type { OpenCodeDailyUsage, OpenCodeStatsReport } from './opencode-stats.js';

const DEFAULT_BAR_WIDTH = 28;

export function formatClaudeStatsReport(report: ClaudeStatsReport): string {
  const lines = [
    'Claude Usage',
    `Date: ${report.targetDate}   Timezone: ${report.timezone}`,
    `Root: ${report.rootDir}`,
    '',
    `Sessions: ${formatInteger(report.targetDay.sessions)}   Messages: ${formatInteger(report.targetDay.messages)}   Log files scanned: ${formatInteger(report.logFileCount)}`,
    '',
    'Today vs previous daily average',
    renderComparisonRows([
      ['Fresh', report.targetDay.fresh, report.previousWindow?.dailyAverage.fresh ?? 0, formatTokenValue],
      ['Total', report.targetDay.total, report.previousWindow?.dailyAverage.total ?? 0, formatTokenValue],
    ]),
    '',
    'Today token mix',
    renderCompositionRows([
      ['Fresh', report.targetDay.fresh],
      ['Cache read', report.targetDay.cacheRead],
      ['Cache write', report.targetDay.cacheWrite],
    ], formatTokenValue),
    '',
    'Daily total tokens',
    renderDailyChart(report.dailyBreakdown, (entry) => entry.total, formatTokenValue),
    '',
    'Daily fresh tokens',
    renderDailyChart(report.dailyBreakdown, (entry) => entry.fresh, formatTokenValue),
  ];

  return `${lines.join('\n')}\n`;
}

export function formatOpenCodeStatsReport(report: OpenCodeStatsReport): string {
  const lines = [
    'OpenCode Usage',
    `Date: ${report.targetDate}   Timezone: ${report.timezone}`,
    `Database: ${report.dbPath}`,
    ...(report.project ? [`Project: ${report.project}`] : []),
    '',
    `Sessions: ${formatInteger(report.targetDay.sessions)}   Messages: ${formatInteger(report.targetDay.messages)}`,
    '',
    'Today vs previous daily average',
    renderComparisonRows([
      ['Fresh', report.targetDay.fresh, report.previousWindow?.dailyAverage.fresh ?? 0, formatTokenValue],
      ['Total', report.targetDay.total, report.previousWindow?.dailyAverage.total ?? 0, formatTokenValue],
      ['Cost', report.targetDay.cost, report.previousWindow?.dailyAverage.cost ?? 0, formatCurrency],
    ]),
    '',
    'Today token mix',
    renderCompositionRows([
      ['Fresh', report.targetDay.fresh],
      ['Cache read', report.targetDay.cacheRead],
      ['Cache write', report.targetDay.cacheWrite],
    ], formatTokenValue),
    '',
    'Daily total tokens',
    renderDailyChart(report.dailyBreakdown, (entry) => entry.total, formatTokenValue),
    '',
    'Daily cost',
    renderDailyChart(report.dailyBreakdown, (entry) => entry.cost, formatCurrency),
  ];

  return `${lines.join('\n')}\n`;
}

type ValueFormatter = (value: number) => string;

function renderComparisonRows(rows: Array<[string, number, number, ValueFormatter]>): string {
  const maxValue = Math.max(1, ...rows.flatMap(([, today, previous]) => [today, previous]));
  return rows.map(([label, today, previous, formatter]) => {
    const ratio = previous === 0 ? 'n/a' : `${formatRatio(today / previous)}x`;
    const delta = today - previous;
    return [
      `${padRight(label, 10)} today ${renderBar(today, maxValue)} ${padLeft(formatter(today), 8)}`,
      `${padRight('', 10)} avg   ${renderBar(previous, maxValue)} ${padLeft(formatter(previous), 8)}   delta ${formatSigned(delta, formatter)}   ratio ${ratio}`,
    ].join('\n');
  }).join('\n');
}

function renderCompositionRows(rows: Array<[string, number]>, formatter: ValueFormatter): string {
  const total = rows.reduce((sum, [, value]) => sum + value, 0);
  const maxValue = Math.max(1, ...rows.map(([, value]) => value));
  return rows.map(([label, value]) => {
    const pct = total === 0 ? 0 : (value / total) * 100;
    return `${padRight(label, 10)} ${renderBar(value, maxValue)} ${padLeft(formatter(value), 8)}   ${pct.toFixed(1).padStart(5)}%`;
  }).join('\n');
}

function renderDailyChart<T extends ClaudeDailyUsage | OpenCodeDailyUsage>(
  daily: T[],
  valueOf: (entry: T) => number,
  formatter: ValueFormatter,
): string {
  const maxValue = Math.max(1, ...daily.map((entry) => valueOf(entry)));
  return daily.map((entry) => {
    const label = entry.date.slice(5);
    const value = valueOf(entry);
    return `${label} ${renderBar(value, maxValue)} ${padLeft(formatter(value), 8)}`;
  }).join('\n');
}

function renderBar(value: number, maxValue: number, width = DEFAULT_BAR_WIDTH): string {
  if (maxValue <= 0) {
    return `[${'-'.repeat(width)}]`;
  }
  const filled = value <= 0 ? 0 : Math.max(1, Math.round((value / maxValue) * width));
  const clamped = Math.min(width, filled);
  return `[${'#'.repeat(clamped)}${'-'.repeat(width - clamped)}]`;
}

function formatTokenValue(value: number): string {
  return formatCompactNumber(value);
}

function formatCurrency(value: number): string {
  if (value === 0) {
    return '$0';
  }
  if (Math.abs(value) < 1) {
    return `$${value.toFixed(3)}`;
  }
  return `$${formatCompactNumber(value)}`;
}

function formatCompactNumber(value: number): string {
  const abs = Math.abs(value);
  const units: Array<[number, string]> = [
    [1_000_000_000, 'B'],
    [1_000_000, 'M'],
    [1_000, 'K'],
  ];

  for (const [threshold, suffix] of units) {
    if (abs >= threshold) {
      const scaled = value / threshold;
      const digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;
      return `${scaled.toFixed(digits)}${suffix}`;
    }
  }

  return Number.isInteger(value) ? formatInteger(value) : value.toFixed(1);
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

function formatSigned(value: number, formatter: ValueFormatter): string {
  if (value === 0) {
    return formatter(0);
  }
  return `${value > 0 ? '+' : '-'}${formatter(Math.abs(value))}`;
}

function formatRatio(value: number): string {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  if (value >= 10) {
    return value.toFixed(1);
  }
  return value.toFixed(2);
}

function padLeft(value: string, width: number): string {
  return value.padStart(width, ' ');
}

function padRight(value: string, width: number): string {
  return value.padEnd(width, ' ');
}
