import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export type SourceKind =
  | 'explicit'
  | 'project-mcp'
  | 'opencode-project'
  | 'opencode-json'
  | 'claude-settings'
  | 'claude-mcp'
  | 'claude-json'
  | 'codex-toml';

export type GraphTransport = 'stdio' | 'streamable-http' | 'sse';

export interface NormalizedServerConfig {
  name: string;
  sourceFile: string;
  sourceKind: SourceKind;
  priority: number;
  transport: GraphTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  rawType?: string;
  metadata?: Record<string, unknown>;
}

export interface DuplicateServerRecord {
  name: string;
  kept: NormalizedServerConfig;
  discarded: NormalizedServerConfig;
}

export interface LoadedServerConfig {
  servers: NormalizedServerConfig[];
  duplicates: DuplicateServerRecord[];
  loadedFiles: string[];
}

export interface ExistingToolPermissionIndex {
  [serverName: string]: string[];
}

export interface ToolMatch {
  server: string;
  tool: Tool;
  score: number;
  sourceKind: SourceKind;
  sourceFile: string;
  transport: GraphTransport;
}

export interface BackendLookupError {
  server: string;
  message: string;
  sourceKind: SourceKind;
  sourceFile: string;
  transport: GraphTransport;
}

export interface ServerInventoryEntry {
  server: NormalizedServerConfig;
  toolCount?: number;
  error?: string;
}

export interface ServerInventoryResult {
  entries: ServerInventoryEntry[];
  errors: BackendLookupError[];
}

export interface SearchToolsResult {
  matches: ToolMatch[];
  errors: BackendLookupError[];
}

export interface SearchToolParams {
  query?: string;
  server?: string;
  limit?: number;
  detail?: 'name' | 'summary' | 'schema';
  refresh?: boolean;
}

export interface CallToolParams {
  server: string;
  tool: string;
  arguments?: Record<string, unknown>;
  maxCharacters?: number;
  includeStructuredResult?: boolean;
  outputMode?: 'content' | 'structured' | 'full';
  fieldPath?: string;
  maxArrayItems?: number;
}

export interface BatchCallToolStep {
  server: string;
  tool: string;
  arguments?: Record<string, unknown>;
}

export interface BatchCallToolParams {
  steps: BatchCallToolStep[];
  mode?: 'parallel' | 'sequential';
  maxCharactersPerResult?: number;
  outputMode?: 'content' | 'structured' | 'full';
}

export interface GraphPolicyProbeResult {
  tool?: string;
  status: 'ok' | 'failed' | 'skipped';
  reason?: string;
}

export interface GraphPolicyServerEntry {
  mode: 'allow-listed' | 'passthrough';
  allowedTools: string[];
  sourceKind: SourceKind;
  sourceFile: string;
  transport: GraphTransport;
  toolCount?: number;
  error?: string;
  fallbackSource?: 'existing-policy' | 'legacy-client-allowlist';
  probe?: GraphPolicyProbeResult;
}

export interface GraphPolicySummary {
  totalServers: number;
  allowListedServers: number;
  passthroughServers: number;
  failedServers: number;
  discoveredTools: number;
  probeOkCount: number;
  probeFailedCount: number;
  probeSkippedCount: number;
}

export interface GraphPolicyDocument {
  version: 1;
  generatedAt: string;
  verificationMode: 'inventory-only' | 'inventory-and-safe-probe';
  servers: Record<string, GraphPolicyServerEntry>;
  summary: GraphPolicySummary;
}
