import os from 'node:os';
import path from 'node:path';

export const DEFAULT_GRAPH_HOME = path.join(os.homedir(), '.mcp-graph');
export const DEFAULT_BACKEND_SNAPSHOT = path.join(DEFAULT_GRAPH_HOME, 'backends.json');
export const DEFAULT_AUDIT_LOG_PATH = path.join(DEFAULT_GRAPH_HOME, 'audit.log');
export const DEFAULT_POLICY_PATH = path.join(DEFAULT_GRAPH_HOME, 'policy.json');
export const DEFAULT_CACHE_DIR = path.join(DEFAULT_GRAPH_HOME, 'cache');
export const DEFAULT_TOOL_CACHE_TTL_MS = 1000 * 60 * 60 * 6;
export const DEFAULT_VERIFY_TIMEOUT_MS = 1000 * 8;

export const GRAPH_TOOL_NAMES = [
  'list_servers',
  'search_tools',
  'get_tool_schema',
  'call_tool',
  'batch_call_tools',
  'refresh_cache',
] as const;

export const RESERVED_SERVER_NAMES = new Set([
  'mcp-graph',
  'code-executor',
  'code-executor-mcp',
]);

export const SOURCE_PRIORITIES = {
  explicit: 100,
  'project-mcp': 90,
  'opencode-project': 85,
  'claude-mcp': 80,
  'claude-json': 70,
  'claude-settings': 65,
  'opencode-json': 60,
  'codex-toml': 50,
} as const;
