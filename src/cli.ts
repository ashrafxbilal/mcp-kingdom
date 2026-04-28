#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_BACKEND_SNAPSHOT,
  DEFAULT_POLICY_PATH,
  DEFAULT_VERIFY_TIMEOUT_MS,
  GRAPH_TOOL_NAMES,
  LEGACY_BACKEND_SNAPSHOT,
} from './constants.js';
import { buildClaudeStatsReport } from './claude-stats.js';
import { buildOpenCodeStatsReport } from './opencode-stats.js';
import { loadMergedServerConfigs, snapshotMergedConfig } from './config.js';
import { GraphRegistry } from './clients.js';
import { doctorMcpKingdom } from './doctor.js';
import { installMcpKingdom, type InstallOptions, type InstallTarget } from './install.js';
import { runInteractiveInstall, shouldUseInteractiveInstall } from './install-ui.js';
import { AuditLogger } from './logger.js';
import { authLogin } from './oauth.js';
import { loadGraphPolicy } from './policy.js';
import { formatClaudeStatsReport, formatOpenCodeStatsReport } from './stats-format.js';
import { ensureDir, fileExists, safeJsonStringify } from './utils.js';
import { runGraphServer } from './server.js';

async function main(): Promise<boolean> {
  const [command = 'serve', ...args] = process.argv.slice(2);

  switch (command) {
    case 'serve':
      await runGraphServer();
      return true;
    case 'snapshot':
      await handleSnapshot(args);
      return false;
    case 'inspect':
      await handleInspect(args);
      return false;
    case 'install':
      await handleInstall(args);
      return false;
    case 'rediscover':
      await handleRediscover(args);
      return false;
    case 'doctor':
      await handleDoctor(args);
      return false;
    case 'claude-stats':
      await handleClaudeStats(args);
      return false;
    case 'opencode-stats':
      await handleOpenCodeStats(args);
      return false;
    case 'auth':
      await handleAuth(args);
      return false;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return false;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function handleSnapshot(args: string[]): Promise<void> {
  const output = readFlag(args, '--output') ?? DEFAULT_BACKEND_SNAPSHOT;
  const config = await snapshotMergedConfig();
  await ensureDir(path.dirname(output));
  await fs.writeFile(output, `${safeJsonStringify(config, 2)}\n`, 'utf8');
  process.stdout.write(`Wrote backend snapshot to ${output}\n`);
}

async function handleInspect(args: string[]): Promise<void> {
  const config = await loadInspectConfig(args);
  const includeToolCounts = hasFlag(args, '--tool-counts');
  const refresh = hasFlag(args, '--refresh');
  const policy = await loadGraphPolicy();
  const registry = includeToolCounts ? new GraphRegistry(config, new AuditLogger(), policy) : undefined;
  const inventory = includeToolCounts
    ? await registry?.getServerInventory({ includeToolCounts: true, refresh })
    : undefined;
  const payload = {
    loadedFiles: config.loadedFiles,
    serverCount: config.servers.length,
    servers: config.servers.map((entry) => ({
      name: entry.name,
      transport: entry.transport,
      sourceKind: entry.sourceKind,
      sourceFile: entry.sourceFile,
      ...(Array.isArray(entry.metadata?.aliases) && entry.metadata.aliases.length > 0
        ? {
          aliases: entry.metadata.aliases.filter((value): value is string => typeof value === 'string'),
        }
        : {}),
      ...(includeToolCounts ? {
        toolCount: inventory?.entries.find((item) => item.server.name === entry.name)?.toolCount ?? 0,
        error: inventory?.entries.find((item) => item.server.name === entry.name)?.error,
        connection: inventory?.entries.find((item) => item.server.name === entry.name)?.connection,
        policyMode: policy?.servers?.[entry.name]?.mode,
        allowedToolCount: policy?.servers?.[entry.name]?.allowedTools.length,
      } : {}),
    })),
    duplicates: config.duplicates.map((entry) => ({
      name: entry.name,
      keptFrom: entry.kept.sourceFile,
      discardedFrom: entry.discarded.sourceFile,
    })),
    ...(includeToolCounts ? {
      totalBackendTools: inventory?.entries.reduce((sum, item) => sum + (item.toolCount ?? 0), 0) ?? 0,
      frontDoorToolCount: GRAPH_TOOL_NAMES.length,
      errors: inventory?.errors ?? [],
      policyPath: process.env.MCP_KINGDOM_POLICY_PATH ?? process.env.MCP_GRAPH_POLICY_PATH ?? DEFAULT_POLICY_PATH,
      policySummary: policy?.summary,
    } : {}),
  };
  process.stdout.write(`${safeJsonStringify(payload, 2)}\n`);
  await registry?.close();
}

async function loadInspectConfig(args: string[]) {
  const explicitBackend = readFlag(args, '--backend') ?? process.env.MCP_KINGDOM_CONFIG_PATH ?? process.env.MCP_GRAPH_CONFIG_PATH;
  if (explicitBackend) {
    return loadMergedServerConfigs({ explicitConfigPaths: [explicitBackend] });
  }

  const activeConfig = await loadMergedServerConfigs();
  if (activeConfig.servers.length > 0) {
    return activeConfig;
  }

  if (await fileExists(DEFAULT_BACKEND_SNAPSHOT)) {
    return loadMergedServerConfigs({ explicitConfigPaths: [DEFAULT_BACKEND_SNAPSHOT] });
  }
  if (await fileExists(LEGACY_BACKEND_SNAPSHOT)) {
    return loadMergedServerConfigs({ explicitConfigPaths: [LEGACY_BACKEND_SNAPSHOT] });
  }

  return activeConfig;
}

async function handleInstall(args: string[]): Promise<void> {
  const options = parseInstallOptions(args);
  if (shouldUseInteractiveInstall(args)) {
    await runInteractiveInstall(options);
    return;
  }

  const result = await installMcpKingdom(options);

  process.stdout.write(`${safeJsonStringify(result, 2)}\n`);
}

async function handleRediscover(args: string[]): Promise<void> {
  const result = await installMcpKingdom(parseInstallOptions(args));
  process.stdout.write(`${safeJsonStringify(result, 2)}\n`);
}

async function handleDoctor(args: string[]): Promise<void> {
  const options = parseInstallOptions(args);
  const result = await doctorMcpKingdom(options);
  process.stdout.write(`${safeJsonStringify(result, 2)}\n`);
}

async function handleClaudeStats(args: string[]): Promise<void> {
  const rootDir = readFlag(args, '--root');
  const timezone = readFlag(args, '--timezone');
  const compareDays = readFlag(args, '--compare-days');
  const report = await buildClaudeStatsReport({
    rootDir,
    timezone,
    targetDate: readFlag(args, '--date'),
    ...(compareDays ? { compareDays: Number.parseInt(compareDays, 10) } : {}),
  });

  if (hasFlag(args, '--json')) {
    process.stdout.write(`${safeJsonStringify(report, 2)}\n`);
    return;
  }

  process.stdout.write(formatClaudeStatsReport(report));
}

async function handleOpenCodeStats(args: string[]): Promise<void> {
  const dbPath = readFlag(args, '--db');
  const timezone = readFlag(args, '--timezone');
  const compareDays = readFlag(args, '--compare-days');
  const project = readFlag(args, '--project');
  const report = await buildOpenCodeStatsReport({
    dbPath,
    timezone,
    project,
    targetDate: readFlag(args, '--date'),
    ...(compareDays ? { compareDays: Number.parseInt(compareDays, 10) } : {}),
  });

  if (hasFlag(args, '--json')) {
    process.stdout.write(`${safeJsonStringify(report, 2)}\n`);
    return;
  }

  process.stdout.write(formatOpenCodeStatsReport(report));
}

async function handleAuth(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand !== 'login') {
    throw new Error(`Unknown auth command: ${subcommand ?? '(missing)'}`);
  }

  const server = readFlag(rest, '--server');
  if (!server) {
    throw new Error('Missing value for --server');
  }

  const config = await loadInspectConfig(rest);
  const result = await authLogin(config, server);
  process.stdout.write(`${safeJsonStringify(result, 2)}\n`);
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.findIndex((arg) => arg === flag);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function parseInstallOptions(args: string[]): InstallOptions {
  const verifyTimeoutMs = readFlag(args, '--verify-timeout-ms');
  return {
    backendPath: readFlag(args, '--backend'),
    auditLogPath: readFlag(args, '--audit-log'),
    policyPath: readFlag(args, '--policy'),
    shortcutBinDir: readFlag(args, '--shortcut-bin'),
    excludeServers: parseStringList(readFlag(args, '--exclude-servers')),
    dryRun: hasFlag(args, '--dry-run'),
    installShortcuts: !hasFlag(args, '--skip-shortcuts'),
    strictVerify: hasFlag(args, '--strict-verify'),
    targets: parseTargets(readFlag(args, '--targets')),
    ...(verifyTimeoutMs ? { verifyTimeoutMs: Number.parseInt(verifyTimeoutMs, 10) } : {}),
  };
}

function parseTargets(value?: string): InstallTarget[] | undefined {
  if (!value) {
    return undefined;
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry): entry is InstallTarget => entry === 'claude' || entry === 'codex' || entry === 'opencode');
}

function parseStringList(value?: string): string[] | undefined {
  if (!value) {
    return undefined;
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function printHelp(): void {
  process.stdout.write(`mcp-kingdom\n\nCommands:\n  serve               Run the MCP server over stdio (default)\n  snapshot            Merge discovered MCP configs and write a backend snapshot file\n  inspect             Print the merged server inventory and duplicate resolution\n  install             Snapshot backend MCPs, generate policy, install helper commands, and rewire Claude/Codex/OpenCode to use only mcp-kingdom\n  rediscover          Re-run backend discovery after adding MCPs and rewire clients back to one front door\n  doctor              Dry-run setup and print what would change before install\n  claude-stats        Summarize Claude usage from ~/.claude/projects with day/week comparisons\n  opencode-stats      Summarize OpenCode usage from the local SQLite database with day/week comparisons\n  auth login          Bootstrap OAuth tokens for an auth-gated backend server\n\nInstall flags:\n  --targets <list>        Limit install to claude,codex,opencode\n  --strict-verify         Fail install if backend verification reports failures\n  --exclude-servers <x>   Exclude backend names from the snapshot\n  --shortcut-bin <dir>    Override where helper commands are installed\n  --skip-shortcuts        Skip installing helper commands\n  --yes                   Skip the interactive preview/confirmation prompt\n  --no-interactive        Force plain non-interactive output\n\nStats flags:\n  --json                  Print raw JSON instead of the default graph view\n\nExamples:\n  node dist/cli.js snapshot --output ~/.mcp-kingdom/backends.json\n  node dist/cli.js inspect --tool-counts\n  node dist/cli.js inspect --backend ~/.mcp-kingdom/backends.json --tool-counts\n  node dist/cli.js doctor\n  node dist/cli.js install\n  node dist/cli.js install --yes\n  node dist/cli.js rediscover\n  node dist/cli.js install --targets claude,codex,opencode --strict-verify\n  node dist/cli.js install --exclude-servers blade-mcp,slack\n  node dist/cli.js install --policy ~/.mcp-kingdom/policy.json --verify-timeout-ms ${DEFAULT_VERIFY_TIMEOUT_MS}\n  node dist/cli.js claude-stats --date today --compare-days 7\n  node dist/cli.js claude-stats --json --date today --compare-days 7\n  node dist/cli.js claude-stats --root ~/.claude/projects --date 2026-04-27 --timezone Asia/Kolkata\n  node dist/cli.js opencode-stats --date today --compare-days 7\n  node dist/cli.js opencode-stats --json --project /absolute/project/path --date today\n  node dist/cli.js auth login --server slack\n  MCP_KINGDOM_CONFIG_PATH=~/.mcp-kingdom/backends.json node dist/cli.js\n`);
}

main()
  .then((keepAlive) => {
    if (!keepAlive) {
      process.exit(0);
    }
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
