import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_AUDIT_LOG_PATH,
  DEFAULT_AUTH_DIR,
  DEFAULT_BACKEND_SNAPSHOT,
  DEFAULT_CACHE_DIR,
  DEFAULT_POLICY_PATH,
  DEFAULT_VERIFY_TIMEOUT_MS,
  FRONT_DOOR_SERVER_NAMES,
  GRAPH_TOOL_NAMES,
  LEGACY_AUTH_DIR,
  LEGACY_BACKEND_SNAPSHOT,
  LEGACY_CACHE_DIR,
} from './constants.js';
import { loadExplicitServerMap, loadMergedServerConfigs, snapshotMergedConfig } from './config.js';
import { buildGraphPolicy, loadGraphPolicy } from './policy.js';
import type { ExistingToolPermissionIndex, GraphPolicyDocument } from './types.js';
import { ensureDir, fileExists, readJsonFile, safeJsonStringify, timestampId, writeJsonFile } from './utils.js';

export type InstallTarget = 'claude' | 'codex' | 'opencode';

export interface InstallOptions {
  cwd?: string;
  homeDir?: string;
  backendPath?: string;
  auditLogPath?: string;
  policyPath?: string;
  targets?: InstallTarget[];
  excludeServers?: string[];
  strictVerify?: boolean;
  verifyTimeoutMs?: number;
  dryRun?: boolean;
}

export interface InstallSummary {
  backendPath: string;
  auditLogPath: string;
  policyPath: string;
  backendServerCount: number;
  targets: InstallTarget[];
  changedFiles: string[];
  backups: string[];
  policySummary: GraphPolicyDocument['summary'];
}

const GRAPH_TOOL_ALLOWLIST = GRAPH_TOOL_NAMES.map((toolName) => `mcp__mcp-kingdom__${toolName}`);

interface GraphLaunchSpec {
  command: string;
  args: string[];
}

export async function installMcpKingdom(options: InstallOptions = {}): Promise<InstallSummary> {
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? cwd;
  const backendPath = options.backendPath ?? DEFAULT_BACKEND_SNAPSHOT;
  const auditLogPath = options.auditLogPath ?? DEFAULT_AUDIT_LOG_PATH;
  const policyPath = options.policyPath ?? DEFAULT_POLICY_PATH;
  const graphLaunch = await resolveGraphLaunchSpec();
  const targets = options.targets ?? await detectInstallTargets(homeDir);
  const changedFiles: string[] = [];
  const backups: string[] = [];
  const excludedServers = new Set<string>([
    ...FRONT_DOOR_SERVER_NAMES,
    ...(options.excludeServers ?? getExcludedServersFromEnv()),
  ]);

  const migratedState = await migrateLegacyState({ homeDir, dryRun: options.dryRun });
  changedFiles.push(...migratedState.changedFiles);
  backups.push(...migratedState.backups);

  if (targets.length === 0) {
    throw new Error('No supported targets detected. Pass --targets claude,codex,opencode to create config files explicitly.');
  }

  const mergedSnapshot = await snapshotMergedConfig({ cwd, homeDir, excludeServers: [...excludedServers] });
  const existingBackend = await readExistingBackendSnapshot(backendPath, excludedServers);
  const finalSnapshot = {
    mcpServers: {
      ...existingBackend,
      ...mergedSnapshot.mcpServers,
    },
  };
  for (const serverName of excludedServers) {
    delete finalSnapshot.mcpServers[serverName];
  }

  const finalLoadedConfig = loadExplicitServerMap(finalSnapshot.mcpServers, backendPath);
  const existingPolicy = await loadGraphPolicy(policyPath);
  const knownAllowedTools = await readExistingToolPermissionIndex(homeDir);
  const policy = await buildGraphPolicy(finalLoadedConfig, {
    auditLogPath,
    existingPolicy,
    knownAllowedTools,
    verifyTimeoutMs: options.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
  });

  if (options.strictVerify && policy.summary.failedServers > 0) {
    throw new Error(
      `Strict verification failed for ${policy.summary.failedServers} server(s). Review ${policyPath} generation in non-strict mode first or fix the failing backends before installing.`,
    );
  }

  changedFiles.push(backendPath, policyPath);
  if (!options.dryRun) {
    await ensureDir(path.dirname(backendPath));
    await writeJsonFile(backendPath, finalSnapshot);
    await writeJsonFile(policyPath, policy);
  }

  for (const target of targets) {
    if (target === 'claude') {
      const result = await installClaude({
        homeDir,
        backendPath,
        auditLogPath,
        policyPath,
        graphLaunch,
        policy,
        dryRun: options.dryRun,
      });
      changedFiles.push(...result.changedFiles);
      backups.push(...result.backups);
      continue;
    }
    if (target === 'codex') {
      const result = await installCodex({
        homeDir,
        backendPath,
        auditLogPath,
        policyPath,
        graphLaunch,
        dryRun: options.dryRun,
      });
      changedFiles.push(...result.changedFiles);
      backups.push(...result.backups);
      continue;
    }
    if (target === 'opencode') {
      const result = await installOpenCode({
        homeDir,
        backendPath,
        auditLogPath,
        policyPath,
        graphLaunch,
        policy,
        dryRun: options.dryRun,
      });
      changedFiles.push(...result.changedFiles);
      backups.push(...result.backups);
    }
  }

  return {
    backendPath,
    auditLogPath,
    policyPath,
    backendServerCount: Object.keys(finalSnapshot.mcpServers).length,
    targets,
    changedFiles: [...new Set(changedFiles)],
    backups: [...new Set(backups)],
    policySummary: policy.summary,
  };
}

export const installMcpGraph = installMcpKingdom;

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

async function readExistingBackendSnapshot(backendPath: string, excludedServers?: Set<string>): Promise<Record<string, unknown>> {
  const candidates = backendPath === DEFAULT_BACKEND_SNAPSHOT
    ? [DEFAULT_BACKEND_SNAPSHOT, LEGACY_BACKEND_SNAPSHOT]
    : [backendPath];

  for (const candidate of candidates) {
    if (!(await fileExists(candidate))) {
      continue;
    }
    const existing = await readJsonFile<{ mcpServers?: Record<string, unknown> }>(candidate);
    if (!existing.mcpServers) {
      return {};
    }
    if (!excludedServers || excludedServers.size === 0) {
      return existing.mcpServers;
    }
    return Object.fromEntries(
      Object.entries(existing.mcpServers)
        .filter(([serverName]) => !excludedServers.has(serverName)),
    );
  }
  return {};
}

async function installClaude({
  homeDir,
  backendPath,
  auditLogPath,
  policyPath,
  graphLaunch,
  policy,
  dryRun,
}: {
  homeDir: string;
  backendPath: string;
  auditLogPath: string;
  policyPath: string;
  graphLaunch: GraphLaunchSpec;
  policy: GraphPolicyDocument;
  dryRun?: boolean;
}): Promise<{ changedFiles: string[]; backups: string[] }> {
  const changedFiles: string[] = [];
  const backups: string[] = [];
  const entry = createClaudeGraphEntry(graphLaunch, backendPath, auditLogPath, policyPath);

  for (const filePath of [
    path.join(homeDir, '.claude.json'),
    path.join(homeDir, '.claude', 'mcp.json'),
  ]) {
    const fileChanged = await writeClaudeLikeJson(filePath, (current) => ({
      ...current,
      mcpServers: {
        'mcp-kingdom': entry,
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
    const managedAllowlist = new Set(getClaudeAllowlist(policy));
    const allow = Array.isArray(permissions.allow)
      ? [...permissions.allow as unknown[]].filter((entry) => !isManagedClaudeMcpPermission(entry, managedAllowlist))
      : [];
    for (const toolName of managedAllowlist) {
      if (!allow.includes(toolName)) {
        allow.push(toolName);
      }
    }

    return {
      ...current,
      mcpServers: {
        'mcp-kingdom': entry,
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
  policyPath,
  graphLaunch,
  policy,
  dryRun,
}: {
  homeDir: string;
  backendPath: string;
  auditLogPath: string;
  policyPath: string;
  graphLaunch: GraphLaunchSpec;
  policy: GraphPolicyDocument;
  dryRun?: boolean;
}): Promise<{ changedFiles: string[]; backups: string[] }> {
  const filePath = await resolveOpenCodeConfigPath(homeDir);
  const changed = await writeClaudeLikeJson(filePath, (current) => {
    const next: Record<string, unknown> = {
      ...current,
      $schema: current.$schema ?? 'https://opencode.ai/config.json',
      mcp: {
        'mcp-kingdom': {
          type: 'local',
        command: [graphLaunch.command, ...graphLaunch.args],
        enabled: true,
        environment: {
          MCP_KINGDOM_CONFIG_PATH: backendPath,
          MCP_KINGDOM_AUDIT_LOG_PATH: auditLogPath,
          MCP_KINGDOM_POLICY_PATH: policyPath,
        },
      },
    },
    };
    const permission = mergeOpenCodePermission(current.permission, policy);
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
  policyPath,
  graphLaunch,
  dryRun,
}: {
  homeDir: string;
  backendPath: string;
  auditLogPath: string;
  policyPath: string;
  graphLaunch: GraphLaunchSpec;
  dryRun?: boolean;
}): Promise<{ changedFiles: string[]; backups: string[] }> {
  const filePath = path.join(homeDir, '.codex', 'config.toml');
  const existing = await readFileOrEmpty(filePath);
  const backup = existing ? `${filePath}.bak-${timestampId()}` : undefined;
  const stripped = stripTomlSections(existing, 'mcp_servers');
  const block = [
    '[mcp_servers.mcp-kingdom]',
    `command = ${tomlString(graphLaunch.command)}`,
    `args = [${graphLaunch.args.map((arg) => tomlString(arg)).join(', ')}]`,
    `env = { MCP_KINGDOM_CONFIG_PATH = ${tomlString(backendPath)}, MCP_KINGDOM_AUDIT_LOG_PATH = ${tomlString(auditLogPath)}, MCP_KINGDOM_POLICY_PATH = ${tomlString(policyPath)} }`,
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

function createClaudeGraphEntry(
  graphLaunch: GraphLaunchSpec,
  backendPath: string,
  auditLogPath: string,
  policyPath: string,
): Record<string, unknown> {
  return {
    command: graphLaunch.command,
    args: graphLaunch.args,
    env: {
      MCP_KINGDOM_CONFIG_PATH: backendPath,
      MCP_KINGDOM_AUDIT_LOG_PATH: auditLogPath,
      MCP_KINGDOM_POLICY_PATH: policyPath,
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
      .filter(([key]) => !key.startsWith('mcp__'))
      .filter(([key]) => !looksLikeManagedOpenCodeMcpPattern(key)),
  );
}

function getClaudeAllowlist(policy: GraphPolicyDocument): string[] {
  const dynamicBackendAllowlist = Object.entries(policy.servers)
    .flatMap(([server, entry]) => entry.allowedTools.map((toolName) => `mcp__${server}__${toolName}`))
    .sort((left, right) => left.localeCompare(right));

  return [
    ...GRAPH_TOOL_ALLOWLIST,
    ...dynamicBackendAllowlist,
  ];
}

function mergeOpenCodePermission(permission: unknown, policy: GraphPolicyDocument): unknown {
  const sanitized = sanitizeOpenCodePermission(permission);
  if (sanitized === undefined || sanitized === null) {
    const next: Record<string, unknown> = {};
    for (const pattern of getOpenCodeAllowPatterns(policy)) {
      next[pattern] = 'allow';
    }
    return next;
  }
  if (typeof sanitized !== 'object' || Array.isArray(sanitized)) {
    return sanitized;
  }

  const next = { ...(sanitized as Record<string, unknown>) };
  for (const pattern of getOpenCodeAllowPatterns(policy)) {
    if (!(pattern in next)) {
      next[pattern] = 'allow';
    }
  }
  return next;
}

function getOpenCodeAllowPatterns(policy: GraphPolicyDocument): string[] {
  const patterns = new Set<string>();

  for (const pattern of getOpenCodeServerPatterns('mcp-kingdom')) {
    patterns.add(pattern);
  }

  for (const serverName of Object.keys(policy.servers)) {
    for (const pattern of getOpenCodeServerPatterns(serverName)) {
      patterns.add(pattern);
    }
  }

  return [...patterns].sort((left, right) => left.localeCompare(right));
}

function getOpenCodeServerPatterns(serverName: string): string[] {
  const patterns = new Set<string>();
  const raw = `${serverName}_*`;
  patterns.add(raw);

  const normalized = normalizeOpenCodeToolPrefix(serverName);
  if (normalized) {
    patterns.add(`${normalized}_*`);
  }

  return [...patterns];
}

function normalizeOpenCodeToolPrefix(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

async function readExistingToolPermissionIndex(homeDir: string): Promise<ExistingToolPermissionIndex> {
  const settingsPath = path.join(homeDir, '.claude', 'settings.json');
  if (!(await fileExists(settingsPath))) {
    return {};
  }

  const settings = await readJsonObjectOrDefault(settingsPath);
  const permissions = settings.permissions;
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
    return {};
  }

  const allow = Array.isArray((permissions as Record<string, unknown>).allow)
    ? ((permissions as Record<string, unknown>).allow as unknown[]).filter((entry): entry is string => typeof entry === 'string')
    : [];

  const index: ExistingToolPermissionIndex = {};
  for (const entry of allow) {
    const match = /^mcp__(.+?)__(.+)$/.exec(entry);
    if (!match) {
      continue;
    }
    const [, server, tool] = match;
    if (FRONT_DOOR_SERVER_NAMES.includes(server as typeof FRONT_DOOR_SERVER_NAMES[number])) {
      continue;
    }
    index[server] ??= [];
    if (!index[server].includes(tool)) {
      index[server].push(tool);
    }
  }

  for (const toolNames of Object.values(index)) {
    toolNames.sort((left, right) => left.localeCompare(right));
  }

  return index;
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

  throw new Error('Unable to locate a runnable mcp-kingdom entrypoint. Run `npm install && npm run build` before `install`.');
}

async function migrateLegacyState({
  homeDir,
  dryRun,
}: {
  homeDir: string;
  dryRun?: boolean;
}): Promise<{ changedFiles: string[]; backups: string[] }> {
  const actualHomeDir = process.env.HOME ?? process.env.USERPROFILE ?? homeDir;
  if (homeDir !== actualHomeDir) {
    return { changedFiles: [], backups: [] };
  }

  const changedFiles: string[] = [];
  const backups: string[] = [];
  const migrations = [
    { from: LEGACY_AUTH_DIR, to: DEFAULT_AUTH_DIR },
    { from: LEGACY_CACHE_DIR, to: DEFAULT_CACHE_DIR },
  ];

  for (const migration of migrations) {
    if (await fileExists(migration.to) || !(await fileExists(migration.from))) {
      continue;
    }
    changedFiles.push(migration.to);
    backups.push(migration.from);
    if (dryRun) {
      continue;
    }
    await copyPath(migration.from, migration.to);
  }

  return { changedFiles, backups };
}

function isFrontDoorAllowlistEntry(entry: unknown): boolean {
  if (typeof entry !== 'string') {
    return false;
  }
  return FRONT_DOOR_SERVER_NAMES.some((serverName) => entry.startsWith(`mcp__${serverName}__`));
}

function isFrontDoorOpenCodePattern(entry: string): boolean {
  return [
    'mcp-kingdom_*',
    'mcp_kingdom_*',
    'mcp-graph_*',
    'mcp_graph_*',
  ].includes(entry);
}

function isManagedClaudeMcpPermission(entry: unknown, allowlist: Set<string>): boolean {
  if (typeof entry !== 'string') {
    return false;
  }
  return entry.startsWith('mcp__') && !allowlist.has(entry);
}

function looksLikeManagedOpenCodeMcpPattern(entry: string): boolean {
  if (isFrontDoorOpenCodePattern(entry)) {
    return true;
  }
  return /^[A-Za-z0-9 _-]+_\*$/.test(entry);
}

async function copyPath(from: string, to: string): Promise<void> {
  const stats = await fs.stat(from);
  if (stats.isDirectory()) {
    await ensureDir(to);
    for (const entry of await fs.readdir(from, { withFileTypes: true })) {
      await copyPath(path.join(from, entry.name), path.join(to, entry.name));
    }
    return;
  }

  await ensureDir(path.dirname(to));
  await fs.copyFile(from, to);
}

function getExcludedServersFromEnv(): string[] {
  const value = process.env.MCP_KINGDOM_EXCLUDE_SERVERS ?? process.env.MCP_GRAPH_EXCLUDE_SERVERS;
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
