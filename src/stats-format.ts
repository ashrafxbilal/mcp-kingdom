import type { ClaudeDailyUsage, ClaudeStatsReport } from './claude-stats.js';
import type { OpenCodeDailyUsage, OpenCodeStatsReport } from './opencode-stats.js';

const DEFAULT_BAR_WIDTH = 28;

interface StatsFormatOptions {
  color?: boolean;
}

interface StatsTheme {
  header: (value: string) => string;
  muted: (value: string) => string;
  label: (value: string) => string;
  todayBar: (value: string) => string;
  averageBar: (value: string) => string;
  freshBar: (value: string) => string;
  cacheReadBar: (value: string) => string;
  cacheWriteBar: (value: string) => string;
  totalBar: (value: string) => string;
  costBar: (value: string) => string;
  positive: (value: string) => string;
  negative: (value: string) => string;
}

export function formatClaudeStatsReport(report: ClaudeStatsReport, options: StatsFormatOptions = {}): string {
  const theme = createTheme(options.color);
  const lines = [
    theme.header('Claude Usage'),
    `${theme.label('Date:')} ${report.targetDate}   ${theme.label('Timezone:')} ${report.timezone}`,
    `${theme.label('Root:')} ${report.rootDir}`,
    '',
    `${theme.label('Sessions:')} ${formatInteger(report.targetDay.sessions)}   ${theme.label('Messages:')} ${formatInteger(report.targetDay.messages)}   ${theme.label('Log files scanned:')} ${formatInteger(report.logFileCount)}`,
    '',
    theme.header('Today vs previous daily average'),
    renderComparisonRows([
      ['Fresh', report.targetDay.fresh, report.previousWindow?.dailyAverage.fresh ?? 0, formatTokenValue],
      ['Total', report.targetDay.total, report.previousWindow?.dailyAverage.total ?? 0, formatTokenValue],
    ], theme),
    '',
    theme.header('Today token mix'),
    renderCompositionRows([
      ['Fresh', report.targetDay.fresh, 'freshBar'],
      ['Cache read', report.targetDay.cacheRead, 'cacheReadBar'],
      ['Cache write', report.targetDay.cacheWrite, 'cacheWriteBar'],
    ], formatTokenValue, theme),
    '',
    theme.header('Daily total tokens'),
    renderDailyChart(report.dailyBreakdown, (entry) => entry.total, formatTokenValue, theme.totalBar),
    '',
    theme.header('Daily fresh tokens'),
    renderDailyChart(report.dailyBreakdown, (entry) => entry.fresh, formatTokenValue, theme.freshBar),
  ];

  return `${lines.join('\n')}\n`;
}

export function formatOpenCodeStatsReport(report: OpenCodeStatsReport, options: StatsFormatOptions = {}): string {
  const theme = createTheme(options.color);
  const lines = [
    theme.header('OpenCode Usage'),
    `${theme.label('Date:')} ${report.targetDate}   ${theme.label('Timezone:')} ${report.timezone}`,
    `${theme.label('Database:')} ${report.dbPath}`,
    ...(report.project ? [`${theme.label('Project:')} ${report.project}`] : []),
    '',
    `${theme.label('Sessions:')} ${formatInteger(report.targetDay.sessions)}   ${theme.label('Messages:')} ${formatInteger(report.targetDay.messages)}`,
    '',
    theme.header('Today vs previous daily average'),
    renderComparisonRows([
      ['Fresh', report.targetDay.fresh, report.previousWindow?.dailyAverage.fresh ?? 0, formatTokenValue],
      ['Total', report.targetDay.total, report.previousWindow?.dailyAverage.total ?? 0, formatTokenValue],
      ['Cost', report.targetDay.cost, report.previousWindow?.dailyAverage.cost ?? 0, formatCurrency],
    ], theme),
    '',
    theme.header('Today token mix'),
    renderCompositionRows([
      ['Fresh', report.targetDay.fresh, 'freshBar'],
      ['Cache read', report.targetDay.cacheRead, 'cacheReadBar'],
      ['Cache write', report.targetDay.cacheWrite, 'cacheWriteBar'],
    ], formatTokenValue, theme),
    '',
    theme.header('Daily total tokens'),
    renderDailyChart(report.dailyBreakdown, (entry) => entry.total, formatTokenValue, theme.totalBar),
    '',
    theme.header('Daily cost'),
    renderDailyChart(report.dailyBreakdown, (entry) => entry.cost, formatCurrency, theme.costBar),
  ];

  return `${lines.join('\n')}\n`;
}

type ValueFormatter = (value: number) => string;
type ThemeBarKey = 'freshBar' | 'cacheReadBar' | 'cacheWriteBar' | 'totalBar' | 'costBar';

function renderComparisonRows(rows: Array<[string, number, number, ValueFormatter]>, theme: StatsTheme): string {
  const maxValue = Math.max(1, ...rows.flatMap(([, today, previous]) => [today, previous]));
  return rows.map(([label, today, previous, formatter]) => {
    const ratio = previous === 0 ? 'n/a' : `${formatRatio(today / previous)}x`;
    const delta = today - previous;
    const deltaText = formatSigned(delta, formatter);
    return [
      `${theme.label(padRight(label, 10))} ${theme.muted('today')} ${renderBar(today, maxValue, DEFAULT_BAR_WIDTH, theme.todayBar)} ${padLeft(formatter(today), 8)}`,
      `${theme.label(padRight('', 10))} ${theme.muted('avg  ')} ${renderBar(previous, maxValue, DEFAULT_BAR_WIDTH, theme.averageBar)} ${padLeft(formatter(previous), 8)}   ${theme.muted('delta')} ${delta >= 0 ? theme.positive(deltaText) : theme.negative(deltaText)}   ${theme.muted('ratio')} ${ratio}`,
    ].join('\n');
  }).join('\n');
}

function renderCompositionRows(
  rows: Array<[string, number, ThemeBarKey]>,
  formatter: ValueFormatter,
  theme: StatsTheme,
): string {
  const total = rows.reduce((sum, [, value]) => sum + value, 0);
  const maxValue = Math.max(1, ...rows.map(([, value]) => value));
  return rows.map(([label, value, barKey]) => {
    const pct = total === 0 ? 0 : (value / total) * 100;
    return `${theme.label(padRight(label, 10))} ${renderBar(value, maxValue, DEFAULT_BAR_WIDTH, theme[barKey])} ${padLeft(formatter(value), 8)}   ${pct.toFixed(1).padStart(5)}%`;
  }).join('\n');
}

function renderDailyChart<T extends ClaudeDailyUsage | OpenCodeDailyUsage>(
  daily: T[],
  valueOf: (entry: T) => number,
  formatter: ValueFormatter,
  colorize: (value: string) => string,
): string {
  const maxValue = Math.max(1, ...daily.map((entry) => valueOf(entry)));
  return daily.map((entry) => {
    const label = entry.date.slice(5);
    const value = valueOf(entry);
    return `${label} ${renderBar(value, maxValue, DEFAULT_BAR_WIDTH, colorize)} ${padLeft(formatter(value), 8)}`;
  }).join('\n');
}

function renderBar(
  value: number,
  maxValue: number,
  width = DEFAULT_BAR_WIDTH,
  colorize: (value: string) => string = identity,
): string {
  if (maxValue <= 0) {
    return `[${'-'.repeat(width)}]`;
  }
  const filled = value <= 0 ? 0 : Math.max(1, Math.round((value / maxValue) * width));
  const clamped = Math.min(width, filled);
  return `[${colorize('#'.repeat(clamped))}${'-'.repeat(width - clamped)}]`;
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

function createTheme(forceColor?: boolean): StatsTheme {
  const colorEnabled = typeof forceColor === 'boolean' ? forceColor : supportsColor();
  if (!colorEnabled) {
    return {
      header: identity,
      muted: identity,
      label: identity,
      todayBar: identity,
      averageBar: identity,
      freshBar: identity,
      cacheReadBar: identity,
      cacheWriteBar: identity,
      totalBar: identity,
      costBar: identity,
      positive: identity,
      negative: identity,
    };
  }

  return {
    header: ansi(1, 36),
    muted: ansi(2, 37),
    label: ansi(1, 97),
    todayBar: ansi(1, 32),
    averageBar: ansi(1, 34),
    freshBar: ansi(1, 32),
    cacheReadBar: ansi(1, 33),
    cacheWriteBar: ansi(1, 35),
    totalBar: ansi(1, 36),
    costBar: ansi(1, 33),
    positive: ansi(1, 32),
    negative: ansi(1, 31),
  };
}

function supportsColor(): boolean {
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') {
    return true;
  }
  if (process.env.NO_COLOR !== undefined) {
    return false;
  }
  return Boolean(process.stdout.isTTY && process.env.TERM !== 'dumb');
}

function ansi(...codes: number[]): (value: string) => string {
  return (value: string) => `\u001B[${codes.join(';')}m${value}\u001B[0m`;
}

function identity(value: string): string {
  return value;
}
