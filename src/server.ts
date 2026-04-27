import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DEFAULT_BACKEND_SNAPSHOT, DEFAULT_GRAPH_HOME } from './constants.js';
import { loadMergedServerConfigs } from './config.js';
import { GraphRegistry } from './clients.js';
import { AuditLogger } from './logger.js';
import { loadGraphPolicy } from './policy.js';
import type { BatchCallToolStep, LoadedServerConfig } from './types.js';
import { parseObjectArgument, safeJsonStringify } from './utils.js';
import { MCP_GRAPH_VERSION } from './version.js';

export interface CreateGraphServerOptions {
  cwd?: string;
  homeDir?: string;
}

export async function createGraphServer(options: CreateGraphServerOptions = {}): Promise<{
  server: McpServer;
  registry: GraphRegistry;
  loadedConfig: LoadedServerConfig;
}> {
  const loadedConfig = await loadMergedServerConfigs({ cwd: options.cwd, homeDir: options.homeDir });
  const logger = new AuditLogger(process.env.MCP_GRAPH_AUDIT_LOG_PATH);
  const policy = await loadGraphPolicy();
  const registry = new GraphRegistry(loadedConfig, logger, policy);

  const server = new McpServer({
    name: 'mcp-graph',
    version: MCP_GRAPH_VERSION,
  });

  server.registerTool(
    'list_servers',
    {
      description: 'List backend MCP servers known to mcp-graph and show which config file each came from.',
      inputSchema: z.object({
        includeMetadata: z.boolean().optional().default(false),
        includeDuplicates: z.boolean().optional().default(false),
        includeToolCounts: z.boolean().optional().default(false),
        refresh: z.boolean().optional().default(false),
      }),
    },
    async ({ includeMetadata, includeDuplicates, includeToolCounts, refresh }) => {
      const inventory = await registry.getServerInventory({ includeToolCounts, refresh });
      const servers = inventory.entries.map(({ server: entry, toolCount, error, connection }) => ({
        name: entry.name,
        transport: entry.transport,
        sourceKind: entry.sourceKind,
        sourceFile: entry.sourceFile,
        ...(includeMetadata ? { metadata: entry.metadata ?? {} } : {}),
        ...(includeToolCounts ? { toolCount } : {}),
        ...(connection ? { connection } : {}),
        ...(policy?.servers?.[entry.name]
          ? {
            policyMode: policy.servers[entry.name].mode,
            allowedToolCount: policy.servers[entry.name].allowedTools.length,
          }
          : {}),
        ...(error ? { error } : {}),
      }));

      const textLines = [
        `Loaded ${servers.length} backend MCP server(s).`,
        ...servers.map((entry) => {
          const toolCountText = includeToolCounts && entry.toolCount !== undefined ? ` (${entry.toolCount} tools)` : '';
          const errorText = entry.error ? ` [error: ${entry.error}]` : '';
          const strategyText = entry.connection?.selectedStrategy ? ` via ${entry.connection.selectedStrategy}` : '';
          return `- ${entry.name} [${entry.transport}] from ${entry.sourceFile}${toolCountText}${strategyText}${errorText}`;
        }),
      ];
      if (inventory.errors.length > 0) {
        textLines.push('', 'Backend errors:');
        for (const error of inventory.errors) {
          textLines.push(`- ${error.server}: ${error.message}`);
        }
      }

      return textResult(
        textLines.join('\n'),
        {
          servers,
          errors: inventory.errors,
          loadedFiles: loadedConfig.loadedFiles,
          ...(includeDuplicates ? {
            duplicates: loadedConfig.duplicates.map((entry) => ({
              name: entry.name,
              keptFrom: entry.kept.sourceFile,
              discardedFrom: entry.discarded.sourceFile,
            })),
          } : {}),
        },
      );
    },
  );

  server.registerTool(
    'search_tools',
    {
      description: 'Search lazily across backend MCP tool names and descriptions without loading every tool into the top-level client context.',
      inputSchema: z.object({
        query: z.string().optional().default(''),
        server: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional().default(20),
        detail: z.enum(['name', 'summary', 'schema']).optional().default('summary'),
        refresh: z.boolean().optional().default(false),
      }),
    },
    async (params) => {
      const result = await registry.searchTools(params);
      const lines = result.matches.map((match, index) => {
        const base = `${index + 1}. ${match.server}.${match.tool.name}`;
        if (params.detail === 'name') {
          return base;
        }
        if (params.detail === 'summary') {
          return `${base} - ${match.tool.description ?? 'No description'}`;
        }
        return `${base}\n${safeJsonStringify({ description: match.tool.description, inputSchema: match.tool.inputSchema, annotations: match.tool.annotations }, 2)}`;
      });
      if (result.errors.length > 0) {
        lines.push(
          `Backend errors:\n${result.errors.map((error) => `- ${error.server}: ${error.message}`).join('\n')}`,
        );
      }

      return textResult(
        lines.length > 0 ? lines.join('\n\n') : 'No tools matched the current filter.',
        { matches: result.matches, errors: result.errors },
      );
    },
  );

  server.registerTool(
    'get_tool_schema',
    {
      description: 'Fetch the full schema and metadata for one backend MCP tool.',
      inputSchema: z.object({
        server: z.string(),
        tool: z.string(),
        refresh: z.boolean().optional().default(false),
      }),
    },
    async ({ server: serverName, tool, refresh }) => {
      const result = await registry.getTool(serverName, tool, refresh);
      return textResult(
        safeJsonStringify({ server: result.server.name, tool: result.tool }, 2),
        { server: result.server.name, tool: result.tool },
      );
    },
  );

  server.registerTool(
    'call_tool',
    {
      description: 'Call a backend MCP tool by server name and tool name. mcp-graph connects lazily and returns a truncated preview by default to keep context smaller.',
      inputSchema: z.object({
        server: z.string(),
        tool: z.string(),
        arguments: z.union([z.record(z.any()), z.string()]).optional(),
        maxCharacters: z.number().int().min(256).max(100_000).optional().default(12_000),
        includeStructuredResult: z.boolean().optional().default(false),
        outputMode: z.enum(['content', 'structured', 'full']).optional(),
        fieldPath: z.string().optional(),
        maxArrayItems: z.number().int().min(1).max(10_000).optional(),
      }),
    },
    async ({ server: serverName, tool, arguments: rawArguments, maxCharacters, includeStructuredResult, outputMode, fieldPath, maxArrayItems }) => {
      const args = parseObjectArgument(rawArguments);
      const effectiveOutputMode = outputMode ?? (includeStructuredResult ? 'full' : 'content');
      const result = await registry.callTool({
        server: serverName,
        tool,
        arguments: args,
        maxCharacters,
        includeStructuredResult,
        outputMode: effectiveOutputMode,
        fieldPath,
        maxArrayItems,
      });

      return {
        content: [{ type: 'text' as const, text: result.text }],
        structuredContent: includeStructuredResult || effectiveOutputMode !== 'content'
          ? {
            server: result.server,
            tool,
            truncated: result.truncated,
            outputMode: result.outputMode,
            selectedValue: result.selectedValue,
            result: includeStructuredResult || effectiveOutputMode === 'full' ? result.result : undefined,
          }
          : {
            server: result.server,
            tool,
            truncated: result.truncated,
            outputMode: result.outputMode,
          },
        isError: result.result.isError,
      };
    },
  );

  server.registerTool(
    'batch_call_tools',
    {
      description: 'Call multiple backend MCP tools in one top-level tool invocation to reduce agent round-trips.',
      inputSchema: z.object({
        mode: z.enum(['parallel', 'sequential']).optional().default('sequential'),
        maxCharactersPerResult: z.number().int().min(128).max(100_000).optional().default(4_000),
        outputMode: z.enum(['content', 'structured', 'full']).optional().default('content'),
        steps: z.array(z.object({
          server: z.string(),
          tool: z.string(),
          arguments: z.union([z.record(z.any()), z.string()]).optional(),
        })).min(1).max(25),
      }),
    },
    async ({ mode, maxCharactersPerResult, outputMode, steps }) => {
      const normalizedSteps: BatchCallToolStep[] = steps.map((step) => ({
        server: step.server,
        tool: step.tool,
        arguments: parseObjectArgument(step.arguments),
      }));
      const results = await registry.batchCallTools({
        steps: normalizedSteps,
        mode,
        maxCharactersPerResult,
        outputMode,
      });

      const text = results
        .map((result) => `${result.step}. ${result.server}.${result.tool} -> ${result.ok ? 'ok' : 'error'}\n${result.preview}`)
        .join('\n\n');

      return textResult(text, { results });
    },
  );

  server.registerTool(
    'refresh_cache',
    {
      description: 'Refresh cached tool schemas from one backend server or every backend server.',
      inputSchema: z.object({
        server: z.string().optional(),
        mode: z.enum(['refresh', 'invalidate', 'invalidate-and-refresh']).optional().default('refresh'),
      }),
    },
    async ({ server: serverName, mode }) => {
      if (mode === 'invalidate') {
        const invalidated = await registry.invalidateToolCache(serverName);
        return textResult(
          `Invalidated ${invalidated.invalidatedServers.length} server cache entr${invalidated.invalidatedServers.length === 1 ? 'y' : 'ies'}: ${invalidated.invalidatedServers.join(', ')}`,
          invalidated,
        );
      }

      if (mode === 'invalidate-and-refresh') {
        const invalidated = await registry.invalidateToolCache(serverName);
        const refreshed = await registry.refresh(serverName);
        return textResult(
          `Invalidated and refreshed ${refreshed.refreshedServers.length} server(s): ${refreshed.refreshedServers.join(', ')}`,
          { ...invalidated, ...refreshed },
        );
      }

      const refreshed = await registry.refresh(serverName);
      return textResult(
        `Refreshed ${refreshed.refreshedServers.length} server(s): ${refreshed.refreshedServers.join(', ')}`,
        refreshed,
      );
    },
  );

  await logger.log('server_started', {
    serverCount: loadedConfig.servers.length,
    loadedFiles: loadedConfig.loadedFiles,
    defaultSnapshotPath: DEFAULT_BACKEND_SNAPSHOT,
    graphHome: DEFAULT_GRAPH_HOME,
  });

  return { server, registry, loadedConfig };
}

export async function runGraphServer(options: CreateGraphServerOptions = {}): Promise<void> {
  const { server, registry } = await createGraphServer(options);
  const transport = new StdioServerTransport();

  const shutdown = async () => {
    await registry.close();
    await server.close();
  };

  process.once('SIGINT', () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0));
  });

  await server.connect(transport);
}

function textResult(text: string, structuredContent?: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}
