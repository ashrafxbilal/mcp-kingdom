import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { GraphRegistry } from './clients.js';
import { DEFAULT_POLICY_PATH, DEFAULT_VERIFY_TIMEOUT_MS } from './constants.js';
import { AuditLogger } from './logger.js';
import type {
  ExistingToolPermissionIndex,
  GraphPolicyDocument,
  GraphPolicyProbeResult,
  GraphPolicyServerEntry,
  LoadedServerConfig,
} from './types.js';
import { fileExists, readJsonFile, withTimeout } from './utils.js';

export interface BuildGraphPolicyOptions {
  auditLogPath?: string;
  existingPolicy?: GraphPolicyDocument;
  knownAllowedTools?: ExistingToolPermissionIndex;
  probeReadOnlyTools?: boolean;
  verifyTimeoutMs?: number;
}

export async function buildGraphPolicy(
  loadedConfig: LoadedServerConfig,
  options: BuildGraphPolicyOptions = {},
): Promise<GraphPolicyDocument> {
  const logger = new AuditLogger(options.auditLogPath);
  const registry = new GraphRegistry(loadedConfig, logger);
  const verifyTimeoutMs = options.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  const probeReadOnlyTools = options.probeReadOnlyTools ?? true;
  const servers: Record<string, GraphPolicyServerEntry> = {};

  try {
    for (const config of loadedConfig.servers) {
      try {
        const tools = await withTimeout(
          registry.listServerTools(config.name),
          verifyTimeoutMs,
          `Tool discovery for ${config.name}`,
        );
        const allowedTools = tools
          .map((tool) => tool.name)
          .filter(Boolean)
          .sort((left, right) => left.localeCompare(right));
        const probe = probeReadOnlyTools
          ? await probeSafeTool({ registry, server: config.name, tools, timeoutMs: verifyTimeoutMs })
          : { status: 'skipped', reason: 'Safe probes disabled' } satisfies GraphPolicyProbeResult;

        servers[config.name] = {
          mode: 'allow-listed',
          allowedTools,
          sourceKind: config.sourceKind,
          sourceFile: config.sourceFile,
          transport: config.transport,
          toolCount: allowedTools.length,
          probe,
        };
      } catch (error) {
        const fallback = getFallbackTools(config.name, options.existingPolicy, options.knownAllowedTools);
        servers[config.name] = {
          mode: fallback.tools.length > 0 ? 'allow-listed' : 'passthrough',
          allowedTools: fallback.tools,
          sourceKind: config.sourceKind,
          sourceFile: config.sourceFile,
          transport: config.transport,
          error: error instanceof Error ? error.message : String(error),
          ...(fallback.source ? { fallbackSource: fallback.source } : {}),
          probe: {
            status: 'skipped',
            reason: 'Tool discovery failed before safe probe',
          },
        };
      }
    }
  } finally {
    await registry.close();
  }

  const entries = Object.values(servers);
  const summary = {
    totalServers: entries.length,
    allowListedServers: entries.filter((entry) => entry.mode === 'allow-listed').length,
    passthroughServers: entries.filter((entry) => entry.mode === 'passthrough').length,
    failedServers: entries.filter((entry) => entry.error).length,
    discoveredTools: entries.reduce((sum, entry) => sum + entry.allowedTools.length, 0),
    probeOkCount: entries.filter((entry) => entry.probe?.status === 'ok').length,
    probeFailedCount: entries.filter((entry) => entry.probe?.status === 'failed').length,
    probeSkippedCount: entries.filter((entry) => entry.probe?.status === 'skipped').length,
  };

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    verificationMode: probeReadOnlyTools ? 'inventory-and-safe-probe' : 'inventory-only',
    servers,
    summary,
  };
}

export async function loadGraphPolicy(
  policyPath = process.env.MCP_GRAPH_POLICY_PATH ?? DEFAULT_POLICY_PATH,
): Promise<GraphPolicyDocument | undefined> {
  if (!(await fileExists(policyPath))) {
    return undefined;
  }

  const value = await readJsonFile<GraphPolicyDocument>(policyPath);
  if (!value || value.version !== 1 || !value.servers || typeof value.servers !== 'object') {
    return undefined;
  }
  return value;
}

async function probeSafeTool({
  registry,
  server,
  tools,
  timeoutMs,
}: {
  registry: GraphRegistry;
  server: string;
  tools: Tool[];
  timeoutMs: number;
}): Promise<GraphPolicyProbeResult> {
  const candidate = pickSafeProbeTool(tools);
  if (!candidate) {
    return {
      status: 'skipped',
      reason: 'No read-only tool with zero required arguments was available',
    };
  }

  try {
    const result = await withTimeout(
      registry.callTool({
        server,
        tool: candidate.name,
        arguments: {},
        maxCharacters: 512,
        outputMode: 'content',
      }),
      timeoutMs,
      `Safe probe for ${server}.${candidate.name}`,
    );

    if (result.result.isError) {
      return {
        tool: candidate.name,
        status: 'failed',
        reason: result.text,
      };
    }

    return {
      tool: candidate.name,
      status: 'ok',
    };
  } catch (error) {
    return {
      tool: candidate.name,
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function pickSafeProbeTool(tools: Tool[]): Tool | undefined {
  const safeTools = tools
    .filter((tool) => tool.annotations?.readOnlyHint === true)
    .filter((tool) => tool.annotations?.destructiveHint !== true)
    .filter((tool) => hasZeroRequiredArguments(tool.inputSchema))
    .sort((left, right) => scoreProbeTool(right) - scoreProbeTool(left) || left.name.localeCompare(right.name));

  return safeTools[0];
}

function scoreProbeTool(tool: Tool): number {
  let score = 0;

  if (tool.annotations?.idempotentHint === true) {
    score += 5;
  }
  if (/^(get|list|search|show|describe|status|catalog|ping|hi|hello|version|read)/i.test(tool.name)) {
    score += 10;
  }
  if (tool.description && /read|list|inspect|status|metadata/i.test(tool.description)) {
    score += 3;
  }

  return score;
}

function hasZeroRequiredArguments(inputSchema: unknown): boolean {
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
    return true;
  }

  const schema = inputSchema as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? schema.required.filter((entry) => typeof entry === 'string') : [];
  if (required.length > 0) {
    return false;
  }

  return true;
}

function getFallbackTools(
  server: string,
  existingPolicy?: GraphPolicyDocument,
  knownAllowedTools?: ExistingToolPermissionIndex,
): {
  tools: string[];
  source?: 'existing-policy' | 'legacy-client-allowlist';
} {
  const policyTools = existingPolicy?.servers?.[server]?.allowedTools ?? [];
  if (policyTools.length > 0) {
    return {
      tools: [...new Set(policyTools)].sort((left, right) => left.localeCompare(right)),
      source: 'existing-policy',
    };
  }

  const legacyTools = knownAllowedTools?.[server] ?? [];
  if (legacyTools.length > 0) {
    return {
      tools: [...new Set(legacyTools)].sort((left, right) => left.localeCompare(right)),
      source: 'legacy-client-allowlist',
    };
  }

  return { tools: [] };
}
