import { describe, expect, it } from 'vitest';
import { formatClaudeStatsReport, formatOpenCodeStatsReport } from '../src/stats-format.js';

describe('stats formatting', () => {
  it('renders Claude stats as a readable ASCII chart', () => {
    const text = formatClaudeStatsReport({
      rootDir: '/tmp/.claude/projects',
      timezone: 'UTC',
      targetDate: '2026-04-28',
      compareDays: 2,
      logFileCount: 12,
      targetDay: {
        date: '2026-04-28',
        messages: 10,
        sessions: 2,
        input: 2000,
        output: 3000,
        cacheRead: 15000,
        cacheWrite: 7000,
        fresh: 5000,
        total: 27000,
      },
      previousWindow: {
        startDate: '2026-04-26',
        endDate: '2026-04-27',
        days: 2,
        totals: {
          messages: 8,
          sessions: 2,
          input: 1500,
          output: 1500,
          cacheRead: 4000,
          cacheWrite: 2000,
          fresh: 3000,
          total: 9000,
        },
        dailyAverage: {
          messages: 4,
          sessions: 1,
          input: 750,
          output: 750,
          cacheRead: 2000,
          cacheWrite: 1000,
          fresh: 1500,
          total: 4500,
        },
      },
      comparison: {
        fresh: { target: 5000, previousDailyAverage: 1500, delta: 3500, ratio: 5000 / 1500 },
        total: { target: 27000, previousDailyAverage: 4500, delta: 22500, ratio: 6 },
      },
      dailyBreakdown: [
        { date: '2026-04-26', messages: 0, sessions: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, fresh: 0, total: 0 },
        { date: '2026-04-27', messages: 8, sessions: 2, input: 1500, output: 1500, cacheRead: 4000, cacheWrite: 2000, fresh: 3000, total: 9000 },
        { date: '2026-04-28', messages: 10, sessions: 2, input: 2000, output: 3000, cacheRead: 15000, cacheWrite: 7000, fresh: 5000, total: 27000 },
      ],
    });

    expect(text).toContain('Claude Usage');
    expect(text).toContain('Today vs previous daily average');
    expect(text).toContain('Daily total tokens');
    expect(text).toContain('04-28 [############################]');
    expect(text).toContain('27.0K');
  });

  it('renders OpenCode stats with cost charts', () => {
    const text = formatOpenCodeStatsReport({
      dbPath: '/tmp/opencode.db',
      timezone: 'UTC',
      targetDate: '2026-04-28',
      compareDays: 1,
      project: '/tmp/repo',
      targetDay: {
        date: '2026-04-28',
        messages: 6,
        sessions: 2,
        input: 1000,
        output: 2500,
        cacheRead: 5000,
        cacheWrite: 0,
        fresh: 3500,
        total: 8500,
        cost: 0.375,
      },
      previousWindow: {
        startDate: '2026-04-27',
        endDate: '2026-04-27',
        days: 1,
        totals: {
          messages: 4,
          sessions: 1,
          input: 500,
          output: 1000,
          cacheRead: 2000,
          cacheWrite: 0,
          fresh: 1500,
          total: 3500,
          cost: 0.125,
        },
        dailyAverage: {
          messages: 4,
          sessions: 1,
          input: 500,
          output: 1000,
          cacheRead: 2000,
          cacheWrite: 0,
          fresh: 1500,
          total: 3500,
          cost: 0.125,
        },
      },
      comparison: {
        fresh: { target: 3500, previousDailyAverage: 1500, delta: 2000, ratio: 3500 / 1500 },
        total: { target: 8500, previousDailyAverage: 3500, delta: 5000, ratio: 8500 / 3500 },
        cost: { target: 0.375, previousDailyAverage: 0.125, delta: 0.25, ratio: 3 },
      },
      dailyBreakdown: [
        { date: '2026-04-27', messages: 4, sessions: 1, input: 500, output: 1000, cacheRead: 2000, cacheWrite: 0, fresh: 1500, total: 3500, cost: 0.125 },
        { date: '2026-04-28', messages: 6, sessions: 2, input: 1000, output: 2500, cacheRead: 5000, cacheWrite: 0, fresh: 3500, total: 8500, cost: 0.375 },
      ],
    });

    expect(text).toContain('OpenCode Usage');
    expect(text).toContain('Daily cost');
    expect(text).toContain('$0.375');
    expect(text).toContain('8.50K');
  });

  it('adds ANSI colors only when explicitly enabled', () => {
    const text = formatClaudeStatsReport({
      rootDir: '/tmp/.claude/projects',
      timezone: 'UTC',
      targetDate: '2026-04-28',
      compareDays: 0,
      logFileCount: 1,
      targetDay: {
        date: '2026-04-28',
        messages: 1,
        sessions: 1,
        input: 10,
        output: 20,
        cacheRead: 30,
        cacheWrite: 40,
        fresh: 30,
        total: 100,
      },
      dailyBreakdown: [
        { date: '2026-04-28', messages: 1, sessions: 1, input: 10, output: 20, cacheRead: 30, cacheWrite: 40, fresh: 30, total: 100 },
      ],
    }, { color: true });

    expect(text).toContain('\u001B[');
  });

  it('lets FORCE_COLOR override NO_COLOR', () => {
    const previousForce = process.env.FORCE_COLOR;
    const previousNoColor = process.env.NO_COLOR;
    process.env.FORCE_COLOR = '1';
    process.env.NO_COLOR = '1';

    try {
      const text = formatClaudeStatsReport({
        rootDir: '/tmp/.claude/projects',
        timezone: 'UTC',
        targetDate: '2026-04-28',
        compareDays: 0,
        logFileCount: 1,
        targetDay: {
          date: '2026-04-28',
          messages: 1,
          sessions: 1,
          input: 10,
          output: 20,
          cacheRead: 30,
          cacheWrite: 40,
          fresh: 30,
          total: 100,
        },
        dailyBreakdown: [
          { date: '2026-04-28', messages: 1, sessions: 1, input: 10, output: 20, cacheRead: 30, cacheWrite: 40, fresh: 30, total: 100 },
        ],
      });

      expect(text).toContain('\u001B[');
    } finally {
      if (previousForce === undefined) {
        delete process.env.FORCE_COLOR;
      } else {
        process.env.FORCE_COLOR = previousForce;
      }

      if (previousNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = previousNoColor;
      }
    }
  });
});
