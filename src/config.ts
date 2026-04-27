import fs from 'node:fs/promises';
import path from 'node:path';
import toml from 'toml';
import { RESERVED_SERVER_NAMES, SOURCE_PRIORITIES } from './constants.js';
import type {
  DuplicateServerRecord,
  LoadedServerConfig,
  NormalizedServerConfig,
  SourceKind,
} from './types.js';
import { expandDeep, expandEnvString, fileExists, splitPathList } from './utils.js';

interface SourceCandidate {
  kind: SourceKind;
  filePath: string;
}

interface JsonConfigFile {
  mcpServers?: Record<string, unknown>;
}

interface CodexTomlFile {
  mcp_servers?: Record<string, unknown>;
}

interface OpenCodeConfigFile {
  mcp?: Record<string, unknown>;
}

export interface LoadConfigOptions {
  cwd?: string;
  homeDir?: string;
  explicitConfigPaths?: string[];
  includeCodex?: boolean;
  excludeServers?: string[];
}

export async function loadMergedServerConfigs(options: LoadConfigOptions = {}): Promise<LoadedServerConfig> {
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? cwd;
  const explicitConfigPaths = options.explicitConfigPaths ?? getExplicitConfigPathsFromEnv();
  const includeCodex = options.includeCodex ?? getBooleanEnv('MCP_GRAPH_INCLUDE_CODEX', true);
  const excludeServers = new Set<string>([
    ...RESERVED_SERVER_NAMES,
    ...(options.excludeServers ?? getExcludeServersFromEnv()),
  ]);

  const candidates = explicitConfigPaths.length > 0
    ? explicitConfigPaths.map((filePath) => ({ kind: 'explicit' as const, filePath: expandEnvString(filePath) }))
    : getDefaultSourceCandidates({ cwd, homeDir, includeCodex });

  const merged = new Map<string, NormalizedServerConfig>();
  const duplicates: DuplicateServerRecord[] = [];
  const loadedFiles: string[] = [];

  for (const candidate of candidates) {
    if (!(await fileExists(candidate.filePath))) {
      continue;
    }

    loadedFiles.push(candidate.filePath);
    const entries = await loadSourceCandidate(candidate);
    for (const entry of entries) {
      if (excludeServers.has(entry.name)) {
        continue;
      }

      const existing = merged.get(entry.name);
      if (!existing || entry.priority > existing.priority) {
        if (existing) {
          duplicates.push({ name: entry.name, kept: entry, discarded: existing });
        }
        merged.set(entry.name, entry);
      } else {
        duplicates.push({ name: entry.name, kept: existing, discarded: entry });
      }
    }
  }

  return {
    servers: [...merged.values()].sort((left, right) => left.name.localeCompare(right.name)),
    duplicates,
    loadedFiles,
  };
}

export async function snapshotMergedConfig(options: LoadConfigOptions = {}): Promise<JsonConfigFile> {
  const loaded = await loadMergedServerConfigs(options);
  return snapshotLoadedConfig(loaded);
}

export function snapshotLoadedConfig(loaded: LoadedServerConfig): JsonConfigFile {
  const mcpServers: Record<string, unknown> = {};

  for (const server of loaded.servers) {
    mcpServers[server.name] = denormalizeServerConfig(server);
  }

  return { mcpServers };
}

export function loadExplicitServerMap(
  serverMap: Record<string, unknown>,
  filePath: string,
): LoadedServerConfig {
  return {
    servers: normalizeServerMap(serverMap, { kind: 'explicit', filePath })
      .sort((left, right) => left.name.localeCompare(right.name)),
    duplicates: [],
    loadedFiles: [filePath],
  };
}

export function getDefaultSourceCandidates({ cwd, homeDir, includeCodex }: { cwd: string; homeDir: string; includeCodex: boolean }): SourceCandidate[] {
  const candidates: SourceCandidate[] = [
    { kind: 'project-mcp', filePath: path.join(cwd, '.mcp.json') },
    { kind: 'opencode-project', filePath: path.join(cwd, 'opencode.json') },
    { kind: 'claude-settings', filePath: path.join(homeDir, '.claude', 'settings.json') },
    { kind: 'claude-mcp', filePath: path.join(homeDir, '.claude', 'mcp.json') },
    { kind: 'claude-json', filePath: path.join(homeDir, '.claude.json') },
    { kind: 'opencode-json', filePath: process.env.OPENCODE_CONFIG ? expandEnvString(process.env.OPENCODE_CONFIG) : path.join(homeDir, '.config', 'opencode', 'opencode.json') },
    { kind: 'opencode-json', filePath: path.join(homeDir, '.opencode.json') },
  ];

  if (includeCodex) {
    candidates.push({ kind: 'codex-toml', filePath: path.join(homeDir, '.codex', 'config.toml') });
  }

  return candidates;
}

async function loadSourceCandidate(candidate: SourceCandidate): Promise<NormalizedServerConfig[]> {
  const rawText = await fs.readFile(candidate.filePath, 'utf8');

  if (candidate.kind === 'opencode-json' || candidate.kind === 'opencode-project') {
    const parsed = JSON.parse(rawText) as OpenCodeConfigFile;
    return normalizeOpenCodeServerMap(parsed.mcp ?? {}, candidate);
  }

  if (candidate.filePath.endsWith('.toml')) {
    const parsed = toml.parse(rawText) as CodexTomlFile;
    return normalizeServerMap(parsed.mcp_servers ?? {}, candidate);
  }

  const parsed = JSON.parse(rawText) as JsonConfigFile;
  return normalizeServerMap(parsed.mcpServers ?? {}, candidate);
}

function normalizeServerMap(serverMap: Record<string, unknown>, candidate: SourceCandidate): NormalizedServerConfig[] {
  return Object.entries(serverMap)
    .flatMap(([name, rawConfig]) => {
      const normalized = normalizeServerConfig(name, rawConfig, candidate);
      return normalized ? [normalized] : [];
    });
}

function normalizeServerConfig(name: string, rawConfig: unknown, candidate: SourceCandidate): NormalizedServerConfig | null {
  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    return null;
  }

  const expanded = expandDeep(rawConfig as Record<string, unknown>);
  const config = expanded as Record<string, unknown>;

  const command = typeof config.command === 'string' ? config.command : undefined;
  const args = Array.isArray(config.args) ? config.args.filter((arg): arg is string => typeof arg === 'string') : undefined;
  const env = isStringRecord(config.env) ? config.env : undefined;
  const cwd = typeof config.cwd === 'string' ? config.cwd : undefined;
  const url = typeof config.url === 'string' ? config.url : undefined;
  const headers = isStringRecord(config.headers) ? config.headers : undefined;
  const rawType = firstString(config.transport, config.type);

  const transport = determineTransport({ command, url, rawType });
  if (!transport) {
    return null;
  }

  const priority = SOURCE_PRIORITIES[candidate.kind] + (transport === 'stdio' ? 20 : transport === 'sse' ? 10 : 5);

  return {
    name,
    sourceFile: candidate.filePath,
    sourceKind: candidate.kind,
    priority,
    transport,
    command,
    args,
    env,
    cwd,
    url,
    headers,
    rawType,
    metadata: stripKnownFields(config),
  };
}

function normalizeOpenCodeServerMap(serverMap: Record<string, unknown>, candidate: SourceCandidate): NormalizedServerConfig[] {
  return Object.entries(serverMap)
    .flatMap(([name, rawConfig]) => {
      const normalized = normalizeOpenCodeServerConfig(name, rawConfig, candidate);
      return normalized ? [normalized] : [];
    });
}

function normalizeOpenCodeServerConfig(name: string, rawConfig: unknown, candidate: SourceCandidate): NormalizedServerConfig | null {
  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    return null;
  }

  const expanded = expandDeep(rawConfig as Record<string, unknown>);
  const config = expanded as Record<string, unknown>;

  if (config.enabled === false && !getBooleanEnv('MCP_GRAPH_INCLUDE_DISABLED_OPENCODE', false)) {
    return null;
  }

  const type = typeof config.type === 'string' ? config.type.toLowerCase() : undefined;
  const commandList = Array.isArray(config.command)
    ? config.command.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const environment = isStringRecord(config.environment) ? config.environment : undefined;
  const headers = isStringRecord(config.headers) ? config.headers : undefined;
  const url = typeof config.url === 'string' ? config.url : undefined;
  const timeout = typeof config.timeout === 'number' ? config.timeout : undefined;

  if (type === 'local' && commandList.length > 0) {
    return {
      name,
      sourceFile: candidate.filePath,
      sourceKind: candidate.kind,
      priority: SOURCE_PRIORITIES[candidate.kind] + 20,
      transport: 'stdio',
      command: commandList[0],
      args: commandList.slice(1),
      env: environment,
      rawType: 'local',
      metadata: stripKnownFields(config),
    };
  }

  if (type === 'remote' && url) {
    const transport = inferRemoteTransport(url);
    return {
      name,
      sourceFile: candidate.filePath,
      sourceKind: candidate.kind,
      priority: SOURCE_PRIORITIES[candidate.kind] + (transport === 'sse' ? 10 : 5),
      transport,
      url,
      headers,
      rawType: type,
      metadata: {
        ...stripKnownFields(config),
        ...(timeout !== undefined ? { timeout } : {}),
      },
    };
  }

  return null;
}

function determineTransport({ command, url, rawType }: { command?: string; url?: string; rawType?: string }): NormalizedServerConfig['transport'] | null {
  if (command) {
    return 'stdio';
  }
  if (!url) {
    return null;
  }

  const normalizedType = rawType?.toLowerCase();
  if (normalizedType === 'sse') {
    return 'sse';
  }
  if (
    normalizedType === 'streamable-http' ||
    normalizedType === 'http' ||
    normalizedType === 'https' ||
    normalizedType === undefined
  ) {
    return 'streamable-http';
  }

  return 'streamable-http';
}

function denormalizeServerConfig(server: NormalizedServerConfig): Record<string, unknown> {
  if (server.transport === 'stdio') {
    return {
      command: server.command,
      ...(server.args ? { args: server.args } : {}),
      ...(server.env ? { env: server.env } : {}),
      ...(server.cwd ? { cwd: server.cwd } : {}),
      ...(server.metadata ?? {}),
    };
  }

  return {
    url: server.url,
    ...(server.rawType ? { type: server.rawType } : {}),
    ...(server.headers ? { headers: server.headers } : {}),
    ...(server.metadata ?? {}),
  };
}

function stripKnownFields(config: Record<string, unknown>): Record<string, unknown> {
  const metadata = { ...config };
  for (const key of ['command', 'args', 'env', 'cwd', 'url', 'headers', 'transport', 'type', 'environment']) {
    delete metadata[key];
  }
  return metadata;
}

function inferRemoteTransport(url: string): NormalizedServerConfig['transport'] {
  return url.toLowerCase().includes('/sse') ? 'sse' : 'streamable-http';
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return Object.values(value as Record<string, unknown>).every((entry) => typeof entry === 'string');
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

function getExplicitConfigPathsFromEnv(): string[] {
  const fromEnv = process.env.MCP_GRAPH_CONFIG_PATH?.trim();
  if (!fromEnv) {
    return [];
  }
  return splitPathList(fromEnv);
}

function getExcludeServersFromEnv(): string[] {
  const value = process.env.MCP_GRAPH_EXCLUDE_SERVERS?.trim();
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getBooleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  return !['0', 'false', 'no', 'off'].includes(value.toLowerCase());
}
