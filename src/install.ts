import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_AUDIT_LOG_PATH, DEFAULT_BACKEND_SNAPSHOT, GRAPH_TOOL_NAMES } from './constants.js';
import { snapshotMergedConfig } from './config.js';
import { ensureDir, fileExists, readJsonFile, safeJsonStringify, timestampId, writeJsonFile } from './utils.js';

export type InstallTarget = 'claude' | 'codex' | 'opencode';

export interface InstallOptions {
  cwd?: string;
  homeDir?: string;
  backendPath?: string;
  auditLogPath?: string;
  targets?: InstallTarget[];
  dryRun?: boolean;
}

export interface InstallSummary {
  backendPath: string;
  auditLogPath: string;
  backendServerCount: number;
  targets: InstallTarget[];
  changedFiles: string[];
  backups: string[];
}

const GRAPH_TOOL_ALLOWLIST = [
  ...GRAPH_TOOL_NAMES.map((toolName) => `mcp__mcp-graph__${toolName}`),
];

interface GraphLaunchSpec {
  command: string;
  args: string[];
}

export async function installMcpGraph(options: InstallOptions = {}): Promise<InstallSummary> {
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? cwd;
  const backendPath = options.backendPath ?? DEFAULT_BACKEND_SNAPSHOT;
  const auditLogPath = options.auditLogPath ?? DEFAULT_AUDIT_LOG_PATH;
  const graphLaunch = await resolveGraphLaunchSpec();
  const targets = options.targets ?? await detectInstallTargets(homeDir);
  const changedFiles: string[] = [];
  const backups: string[] = [];

  if (targets.length === 0) {
    throw new Error('No supported targets detected. Pass --targets claude,codex,opencode to create config files explicitly.');
  }

  const mergedSnapshot = await snapshotMergedConfig({ cwd, homeDir, excludeServers: ['mcp-graph'] });
  const existingBackend = await readExistingBackendSnapshot(backendPath);
  const finalSnapshot = {
    mcpServers: {
      ...existingBackend,
      ...mergedSnapshot.mcpServers,
    },
  };
  delete finalSnapshot.mcpServers['mcp-graph'];

  if (!options.dryRun) {
    await ensureDir(path.dirname(backendPath));
    await writeJsonFile(backendPath, finalSnapshot);
    changedFiles.push(backendPath);
  }

  for (const target of targets) {
    if (target === 'claude') {
      const result = await installClaude({ homeDir, backendPath, auditLogPath, graphLaunch, dryRun: options.dryRun });
      changedFiles.push(...result.changedFiles);
      backups.push(...result.backups);
      continue;
    }
    if (target === 'codex') {
      const result = await installCodex({ homeDir, backendPath, auditLogPath, graphLaunch, dryRun: options.dryRun });
      changedFiles.push(...result.changedFiles);
      backups.push(...result.backups);
      continue;
    }
    if (target === 'opencode') {
      const result = await installOpenCode({ homeDir, backendPath, auditLogPath, graphLaunch, dryRun: options.dryRun });
      changedFiles.push(...result.changedFiles);
      backups.push(...result.backups);
    }
  }

  return {
    backendPath,
    auditLogPath,
    backendServerCount: Object.keys(finalSnapshot.mcpServers).length,
    targets,
    changedFiles: [...new Set(changedFiles)],
    backups: [...new Set(backups)],
  };
}

export async function detectInstallTargets(homeDir: string): Promise<InstallTarget[]> {
  const targets: InstallTarget[] = [];

  if (
    await fileExists(path.join(homeDir, '.claude.json')) ||
    await fileExists(path.join(homeDir, '.claude', 'settings.json')) ||
    await fileExists(path.join(homeDir, '.claude', 'mcp.json'))
  ) {
    targets.push('claude');
  }

  if (await fileExists(path.join(homeDir, '.codex', 'config.toml'))) {
    targets.push('codex');
  }

  if (
    await fileExists(path.join(homeDir, '.config', 'opencode', 'opencode.json')) ||
    await fileExists(path.join(homeDir, '.opencode.json'))
  ) {
    targets.push('opencode');
  }

  return targets;
}

async function readExistingBackendSnapshot(backendPath: string): Promise<Record<string, unknown>> {
  if (!(await fileExists(backendPath))) {
    return {};
  }
  const existing = await readJsonFile<{ mcpServers?: Record<string, unknown> }>(backendPath);
  return existing.mcpServers ?? {};
}

async function installClaude({
  homeDir,
  backendPath,
  auditLogPath,
  graphLaunch,
  dryRun,
}: {
  homeDir: string;
  backendPath: string;
  auditLogPath: string;
  graphLaunch: GraphLaunchSpec;
  dryRun?: boolean;
}): Promise<{ changedFiles: string[]; backups: string[] }> {
  const changedFiles: string[] = [];
  const backups: string[] = [];
  const entry = createClaudeGraphEntry(graphLaunch, backendPath, auditLogPath);

  for (const filePath of [
    path.join(homeDir, '.claude.json'),
    path.join(homeDir, '.claude', 'mcp.json'),
  ]) {
    const fileChanged = await writeClaudeLikeJson(filePath, (current) => ({
      ...current,
      mcpServers: {
        'mcp-graph': entry,
      },
    }), dryRun);
    if (fileChanged.changed) {
      changedFiles.push(filePath);
    }
    if (fileChanged.backup) {
      backups.push(fileChanged.backup);
    }
  }

  const settingsPath = path.join(homeDir, '.claude', 'settings.json');
  const settingsChanged = await writeClaudeLikeJson(settingsPath, (current) => {
    const permissions = current.permissions && typeof current.permissions === 'object' && !Array.isArray(current.permissions)
      ? { ...current.permissions as Record<string, unknown> }
      : {};
    const allow = Array.isArray(permissions.allow) ? [...permissions.allow as unknown[]] : [];
    for (const toolName of GRAPH_TOOL_ALLOWLIST) {
      if (!allow.includes(toolName)) {
        allow.push(toolName);
      }
    }

    return {
      ...current,
      mcpServers: {
        'mcp-graph': entry,
      },
      permissions: {
        ...permissions,
        allow,
      },
    };
  }, dryRun);

  if (settingsChanged.changed) {
    changedFiles.push(settingsPath);
  }
  if (settingsChanged.backup) {
    backups.push(settingsChanged.backup);
  }

  return { changedFiles, backups };
}

async function installOpenCode({
  homeDir,
  backendPath,
  auditLogPath,
  graphLaunch,
  dryRun,
}: {
  homeDir: string;
  backendPath: string;
  auditLogPath: string;
  graphLaunch: GraphLaunchSpec;
  dryRun?: boolean;
}): Promise<{ changedFiles: string[]; backups: string[] }> {
  const filePath = await resolveOpenCodeConfigPath(homeDir);
  const changed = await writeClaudeLikeJson(filePath, (current) => {
    const next: Record<string, unknown> = {
      ...current,
      $schema: current.$schema ?? 'https://opencode.ai/config.json',
      mcp: {
        'mcp-graph': {
          type: 'local',
          command: [graphLaunch.command, ...graphLaunch.args],
          enabled: true,
          environment: {
            MCP_GRAPH_CONFIG_PATH: backendPath,
            MCP_GRAPH_AUDIT_LOG_PATH: auditLogPath,
          },
        },
      },
    };
    const permission = sanitizeOpenCodePermission(current.permission);
    if (permission !== undefined) {
      next.permission = permission;
    }
    return next;
  }, dryRun);

  return {
    changedFiles: changed.changed ? [filePath] : [],
    backups: changed.backup ? [changed.backup] : [],
  };
}

async function installCodex({
  homeDir,
  backendPath,
  auditLogPath,
  graphLaunch,
  dryRun,
}: {
  homeDir: string;
  backendPath: string;
  auditLogPath: string;
  graphLaunch: GraphLaunchSpec;
  dryRun?: boolean;
}): Promise<{ changedFiles: string[]; backups: string[] }> {
  const filePath = path.join(homeDir, '.codex', 'config.toml');
  const existing = await readFileOrEmpty(filePath);
  const backup = existing ? `${filePath}.bak-${timestampId()}` : undefined;
  const stripped = stripTomlSections(existing, 'mcp_servers');
  const block = [
    '[mcp_servers.mcp-graph]',
    `command = ${tomlString(graphLaunch.command)}`,
    `args = [${graphLaunch.args.map((arg) => tomlString(arg)).join(', ')}]`,
    `env = { MCP_GRAPH_CONFIG_PATH = ${tomlString(backendPath)}, MCP_GRAPH_AUDIT_LOG_PATH = ${tomlString(auditLogPath)} }`,
    '',
  ].join('\n');
  const nextText = `${stripped.trimEnd()}\n\n${block}`.trimStart();
  if (existing.trim() === nextText.trim()) {
    return { changedFiles: [], backups: [] };
  }

  if (!dryRun) {
    await ensureDir(path.dirname(filePath));
    if (backup) {
      await fs.copyFile(filePath, backup);
    }
    await fs.writeFile(filePath, `${nextText}\n`, 'utf8');
  }

  return {
    changedFiles: [filePath],
    backups: backup ? [backup] : [],
  };
}

async function writeClaudeLikeJson(
  filePath: string,
  update: (current: Record<string, unknown>) => Record<string, unknown>,
  dryRun?: boolean,
): Promise<{ changed: boolean; backup?: string }> {
  const current = await readJsonObjectOrDefault(filePath);
  const next = update(current);
  const currentJson = safeJsonStringify(current, 2);
  const nextJson = safeJsonStringify(next, 2);
  if (currentJson === nextJson) {
    return { changed: false };
  }

  const backup = await fileExists(filePath) ? `${filePath}.bak-${timestampId()}` : undefined;
  if (!dryRun) {
    await ensureDir(path.dirname(filePath));
    if (backup) {
      await fs.copyFile(filePath, backup);
    }
    await fs.writeFile(filePath, `${nextJson}\n`, 'utf8');
  }

  return { changed: true, backup };
}

async function readJsonObjectOrDefault(filePath: string): Promise<Record<string, unknown>> {
  if (!(await fileExists(filePath))) {
    return {};
  }
  const value = await readJsonFile<Record<string, unknown>>(filePath);
  return value ?? {};
}

async function readFileOrEmpty(filePath: string): Promise<string> {
  if (!(await fileExists(filePath))) {
    return '';
  }
  return fs.readFile(filePath, 'utf8');
}

function stripTomlSections(text: string, sectionRoot: string): string {
  const lines = text.split('\n');
  const output: string[] = [];
  let skip = false;
  const sectionPattern = new RegExp(`^\\[${sectionRoot}\\.[^\\]]+\\]\\s*$`);
  const anySectionPattern = /^\[[^\]]+\]\s*$/;

  for (const line of lines) {
    if (sectionPattern.test(line.trim())) {
      skip = true;
      continue;
    }
    if (skip && anySectionPattern.test(line.trim())) {
      skip = false;
      output.push(line);
      continue;
    }
    if (!skip) {
      output.push(line);
    }
  }

  return output.join('\n').replace(/\n{3,}/g, '\n\n');
}

function createClaudeGraphEntry(graphLaunch: GraphLaunchSpec, backendPath: string, auditLogPath: string): Record<string, unknown> {
  return {
    command: graphLaunch.command,
    args: graphLaunch.args,
    env: {
      MCP_GRAPH_CONFIG_PATH: backendPath,
      MCP_GRAPH_AUDIT_LOG_PATH: auditLogPath,
    },
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function sanitizeOpenCodePermission(permission: unknown): unknown {
  if (!permission || typeof permission !== 'object' || Array.isArray(permission)) {
    return permission;
  }

  return Object.fromEntries(
    Object.entries(permission as Record<string, unknown>)
      .filter(([key]) => !key.startsWith('mcp__')),
  );
}

async function resolveOpenCodeConfigPath(homeDir: string): Promise<string> {
  const envPath = process.env.OPENCODE_CONFIG?.trim();
  if (envPath) {
    return envPath;
  }

  const configPath = path.join(homeDir, '.config', 'opencode', 'opencode.json');
  if (await fileExists(configPath)) {
    return configPath;
  }

  return path.join(homeDir, '.opencode.json');
}

async function resolveGraphLaunchSpec(): Promise<GraphLaunchSpec> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const builtCliPath = path.join(moduleDir, 'cli.js');

  if (await fileExists(builtCliPath)) {
    return {
      command: process.execPath,
      args: [builtCliPath],
    };
  }

  const sourceCliPath = path.join(moduleDir, 'cli.ts');
  const repoRoot = path.resolve(moduleDir, '..');
  const tsxBinary = path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');

  if (await fileExists(sourceCliPath) && await fileExists(tsxBinary)) {
    return {
      command: tsxBinary,
      args: [sourceCliPath],
    };
  }

  throw new Error('Unable to locate a runnable mcp-graph entrypoint. Run `npm install && npm run build` before `install`.');
}
