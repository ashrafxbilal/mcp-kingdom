#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_BACKEND_SNAPSHOT, DEFAULT_POLICY_PATH, DEFAULT_VERIFY_TIMEOUT_MS, GRAPH_TOOL_NAMES } from './constants.js';
import { loadMergedServerConfigs, snapshotMergedConfig } from './config.js';
import { GraphRegistry } from './clients.js';
import { installMcpGraph, type InstallTarget } from './install.js';
import { AuditLogger } from './logger.js';
import { loadGraphPolicy } from './policy.js';
import { ensureDir, fileExists, safeJsonStringify } from './utils.js';
import { runGraphServer } from './server.js';

async function main(): Promise<void> {
  const [command = 'serve', ...args] = process.argv.slice(2);

  switch (command) {
    case 'serve':
      await runGraphServer();
      return;
    case 'snapshot':
      await handleSnapshot(args);
      return;
    case 'inspect':
      await handleInspect(args);
      return;
    case 'install':
      await handleInstall(args);
      return;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return;
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
      ...(includeToolCounts ? {
        toolCount: inventory?.entries.find((item) => item.server.name === entry.name)?.toolCount ?? 0,
        error: inventory?.entries.find((item) => item.server.name === entry.name)?.error,
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
      policyPath: process.env.MCP_GRAPH_POLICY_PATH ?? DEFAULT_POLICY_PATH,
      policySummary: policy?.summary,
    } : {}),
  };
  process.stdout.write(`${safeJsonStringify(payload, 2)}\n`);
  await registry?.close();
}

async function loadInspectConfig(args: string[]) {
  const explicitBackend = readFlag(args, '--backend') ?? process.env.MCP_GRAPH_CONFIG_PATH;
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

  return activeConfig;
}

async function handleInstall(args: string[]): Promise<void> {
  const backendPath = readFlag(args, '--backend');
  const auditLogPath = readFlag(args, '--audit-log');
  const policyPath = readFlag(args, '--policy');
  const verifyTimeoutMs = readFlag(args, '--verify-timeout-ms');
  const dryRun = hasFlag(args, '--dry-run');
  const strictVerify = hasFlag(args, '--strict-verify');
  const targets = parseTargets(readFlag(args, '--targets'));
  const result = await installMcpGraph({
    backendPath,
    auditLogPath,
    policyPath,
    dryRun,
    strictVerify,
    targets,
    ...(verifyTimeoutMs ? { verifyTimeoutMs: Number.parseInt(verifyTimeoutMs, 10) } : {}),
  });

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

function parseTargets(value?: string): InstallTarget[] | undefined {
  if (!value) {
    return undefined;
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry): entry is InstallTarget => entry === 'claude' || entry === 'codex' || entry === 'opencode');
}

function printHelp(): void {
  process.stdout.write(`mcp-graph\n\nCommands:\n  serve               Run the MCP server over stdio (default)\n  snapshot            Merge discovered MCP configs and write a backend snapshot file\n  inspect             Print the merged server inventory and duplicate resolution\n  install             Snapshot backend MCPs, generate policy, and rewire Claude/Codex/OpenCode to use only mcp-graph\n\nExamples:\n  node dist/cli.js snapshot --output ~/.mcp-graph/backends.json\n  node dist/cli.js inspect --tool-counts\n  node dist/cli.js inspect --backend ~/.mcp-graph/backends.json --tool-counts\n  node dist/cli.js install\n  node dist/cli.js install --targets claude,codex,opencode --strict-verify\n  node dist/cli.js install --policy ~/.mcp-graph/policy.json --verify-timeout-ms ${DEFAULT_VERIFY_TIMEOUT_MS}\n  MCP_GRAPH_CONFIG_PATH=~/.mcp-graph/backends.json node dist/cli.js\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
