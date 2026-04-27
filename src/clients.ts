import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ToolIndexCache } from './caching/tool-index-cache.js';
import { renderToolResult, type GraphToolResult } from './formatting/result-shaper.js';
import { AuditLogger } from './logger.js';
import type {
  BackendLookupError,
  BatchCallToolParams,
  CallToolParams,
  GraphPolicyDocument,
  LoadedServerConfig,
  NormalizedServerConfig,
  SearchToolsResult,
  SearchToolParams,
  ServerInventoryResult,
  ToolMatch,
} from './types.js';
import { scoreText } from './utils.js';
import { MCP_GRAPH_VERSION } from './version.js';

interface ToolCacheRecord {
  tools: Tool[];
  fetchedAt: number;
}

class BackendSession {
  private client?: Client;
  private transport?: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport;
  private connectPromise?: Promise<Client>;
  private toolCache?: ToolCacheRecord;

  constructor(
    readonly config: NormalizedServerConfig,
    private readonly logger: AuditLogger,
    private readonly cache: ToolIndexCache,
  ) {}

  async getClient(): Promise<Client> {
    if (this.client) {
      return this.client;
    }
    if (!this.connectPromise) {
      this.connectPromise = this.connectInternal();
    }
    return this.connectPromise;
  }

  async listTools(refresh = false): Promise<Tool[]> {
    if (!refresh && this.toolCache) {
      return this.toolCache.tools;
    }

    const diskCached = refresh ? undefined : await this.cache.get(this.config);
    if (diskCached && !diskCached.stale) {
      this.toolCache = { tools: diskCached.tools, fetchedAt: Date.parse(diskCached.cachedAt) || Date.now() };
      await this.logger.log('tool_cache_hit', {
        server: this.config.name,
        stale: false,
        cacheDir: this.cache.cacheDir,
      });
      return diskCached.tools;
    }

    try {
      const client = await this.getClient();
      const tools: Tool[] = [];
      let cursor: string | undefined;

      do {
        const response = await client.listTools(cursor ? { cursor } : undefined);
        tools.push(...response.tools);
        cursor = response.nextCursor;
      } while (cursor);

      this.toolCache = { tools, fetchedAt: Date.now() };
      await this.cache.set(this.config, tools);
      return tools;
    } catch (error) {
      if (diskCached) {
        this.toolCache = { tools: diskCached.tools, fetchedAt: Date.parse(diskCached.cachedAt) || Date.now() };
        await this.logger.log('tool_cache_stale_fallback', {
          server: this.config.name,
          stale: true,
          reason: error instanceof Error ? error.message : String(error),
        });
        return diskCached.tools;
      }
      throw error;
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<GraphToolResult> {
    const client = await this.getClient();
    return (await client.callTool({ name, arguments: args })) as GraphToolResult;
  }

  async close(): Promise<void> {
    await this.transport?.close();
    this.client = undefined;
    this.transport = undefined;
    this.connectPromise = undefined;
    this.toolCache = undefined;
  }

  private async connectInternal(): Promise<Client> {
    const client = new Client(
      { name: 'mcp-graph-backend-client', version: MCP_GRAPH_VERSION },
      { capabilities: {} },
    );
    const transport = this.createTransport();
    await client.connect(transport);

    this.client = client;
    this.transport = transport;

    await this.logger.log('backend_connected', {
      server: this.config.name,
      sourceKind: this.config.sourceKind,
      transport: this.config.transport,
      sourceFile: this.config.sourceFile,
    });

    return client;
  }

  private createTransport(): StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport {
    if (this.config.transport === 'stdio') {
      if (!this.config.command) {
        throw new Error(`Missing command for stdio server ${this.config.name}`);
      }
      return new StdioClientTransport({
        command: this.config.command,
        args: this.config.args,
        cwd: this.config.cwd,
        env: { ...(process.env as Record<string, string | undefined>), ...(this.config.env ?? {}) } as Record<string, string>,
        stderr: 'pipe',
      });
    }

    if (!this.config.url) {
      throw new Error(`Missing URL for remote server ${this.config.name}`);
    }

    const url = new URL(this.config.url);
    if (this.config.transport === 'sse') {
      return new SSEClientTransport(url, {
        requestInit: { headers: this.config.headers },
        eventSourceInit: { fetch: globalThis.fetch as typeof fetch, headers: this.config.headers } as never,
      });
    }

    return new StreamableHTTPClientTransport(url, {
      requestInit: { headers: this.config.headers },
    });
  }
}

export class GraphRegistry {
  private readonly sessions = new Map<string, BackendSession>();
  private readonly configByName = new Map<string, NormalizedServerConfig>();
  private readonly toolIndexCache: ToolIndexCache;

  constructor(
    config: LoadedServerConfig,
    private readonly logger: AuditLogger,
    private readonly policy?: GraphPolicyDocument,
  ) {
    this.toolIndexCache = new ToolIndexCache({ logger });
    for (const server of config.servers) {
      this.configByName.set(server.name, server);
    }
  }

  listServers(): NormalizedServerConfig[] {
    return [...this.configByName.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  async getServerInventory(params: { server?: string; includeToolCounts?: boolean; refresh?: boolean } = {}): Promise<ServerInventoryResult> {
    const configs = this.filterServers(params.server);
    if (!params.includeToolCounts) {
      return {
        entries: configs.map((config) => ({ server: config })),
        errors: [],
      };
    }

    const entries = [];
    const errors: BackendLookupError[] = [];

    for (const config of configs) {
      try {
        const tools = await this.listServerTools(config.name, params.refresh ?? false);
        entries.push({
          server: config,
          toolCount: tools.length,
        });
      } catch (error) {
        const backendError = this.createBackendError(config, error);
        errors.push(backendError);
        entries.push({
          server: config,
          error: backendError.message,
        });
        await this.logger.log('backend_inventory_error', { ...backendError });
      }
    }

    return { entries, errors };
  }

  async searchTools(params: SearchToolParams = {}): Promise<SearchToolsResult> {
    const detail = params.detail ?? 'summary';
    const limit = params.limit ?? 20;
    const serverConfigs = this.filterServers(params.server);
    const matches: ToolMatch[] = [];
    const errors: BackendLookupError[] = [];

    for (const config of serverConfigs) {
      let tools: Tool[];
      try {
        tools = await this.listServerTools(config.name, params.refresh ?? false);
      } catch (error) {
        const backendError = this.createBackendError(config, error);
        errors.push(backendError);
        await this.logger.log('backend_search_error', {
          ...backendError,
          query: params.query ?? '',
        });
        continue;
      }

      for (const tool of tools) {
        const score = scoreTool(config.name, tool, params.query ?? '');
        if (params.query && score <= 0) {
          continue;
        }
        matches.push({
          server: config.name,
          tool: detail === 'name'
            ? ({ name: tool.name } as Tool)
            : detail === 'summary'
              ? ({ name: tool.name, description: tool.description, annotations: tool.annotations } as Tool)
              : tool,
          score,
          sourceKind: config.sourceKind,
          sourceFile: config.sourceFile,
          transport: config.transport,
        });
      }
    }

    return {
      matches: matches
        .sort((left, right) => {
          if (right.score !== left.score) {
            return right.score - left.score;
          }
          if (left.server !== right.server) {
            return left.server.localeCompare(right.server);
          }
          return left.tool.name.localeCompare(right.tool.name);
        })
        .slice(0, limit),
      errors,
    };
  }

  async getTool(server: string, toolName: string, refresh = false): Promise<{ server: NormalizedServerConfig; tool: Tool }> {
    const config = this.requireServer(server);
    const tools = await this.listServerTools(config.name, refresh);
    const tool = tools.find((entry) => entry.name === toolName);
    if (!tool) {
      this.assertToolAllowed(config.name, toolName);
      throw new Error(this.buildToolNotFoundMessage(config.name, toolName, tools));
    }
    return { server: config, tool };
  }

  async callTool(params: CallToolParams): Promise<{
    server: string;
    text: string;
    truncated: boolean;
    result: GraphToolResult;
    selectedValue: unknown;
    outputMode: 'content' | 'structured' | 'full';
  }> {
    const { server: config } = await this.getTool(params.server, params.tool);
    const args = params.arguments ?? {};
    const maxCharacters = params.maxCharacters ?? 12_000;

    await this.logger.log('tool_call', {
      server: config.name,
      tool: params.tool,
      argumentKeys: Object.keys(args),
      outputMode: params.outputMode ?? 'content',
      fieldPath: params.fieldPath,
    });

    const result = await this.getSession(config.name).callTool(params.tool, args);
    const rendered = renderToolResult(result, {
      maxCharacters,
      outputMode: params.outputMode,
      fieldPath: params.fieldPath,
      maxArrayItems: params.maxArrayItems,
    });

    return {
      server: config.name,
      text: rendered.text,
      truncated: rendered.truncated,
      result,
      selectedValue: rendered.selectedValue,
      outputMode: rendered.outputMode,
    };
  }

  async batchCallTools(params: BatchCallToolParams): Promise<Array<{ step: number; server: string; tool: string; ok: boolean; preview: string }>> {
    const steps = params.steps;
    const maxCharacters = params.maxCharactersPerResult ?? 4_000;
    const mode = params.mode ?? 'sequential';

    if (mode === 'parallel') {
      const settled = await Promise.allSettled(
        steps.map((step) => this.callTool({
          server: step.server,
          tool: step.tool,
          arguments: step.arguments,
          maxCharacters,
          outputMode: params.outputMode,
        })),
      );

      return settled.map((entry, index) => {
        const step = steps[index];
        if (entry.status === 'fulfilled') {
          return { step: index + 1, server: step.server, tool: step.tool, ok: !(entry.value.result.isError ?? false), preview: entry.value.text };
        }
        return { step: index + 1, server: step.server, tool: step.tool, ok: false, preview: entry.reason instanceof Error ? entry.reason.message : String(entry.reason) };
      });
    }

    const results: Array<{ step: number; server: string; tool: string; ok: boolean; preview: string }> = [];
    for (const [index, step] of steps.entries()) {
      try {
        const result = await this.callTool({
          server: step.server,
          tool: step.tool,
          arguments: step.arguments,
          maxCharacters,
          outputMode: params.outputMode,
        });
        results.push({ step: index + 1, server: step.server, tool: step.tool, ok: !(result.result.isError ?? false), preview: result.text });
      } catch (error) {
        results.push({
          step: index + 1,
          server: step.server,
          tool: step.tool,
          ok: false,
          preview: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }

  async refresh(server?: string): Promise<{ refreshedServers: string[] }> {
    const configs = this.filterServers(server);
    for (const config of configs) {
      await this.listServerTools(config.name, true);
    }
    return { refreshedServers: configs.map((config) => config.name) };
  }

  async invalidateToolCache(server?: string): Promise<{ invalidatedServers: string[] }> {
    if (server) {
      await this.toolIndexCache.invalidate(server);
      const session = this.sessions.get(server);
      if (session) {
        await session.close();
      }
      this.sessions.delete(server);
      return { invalidatedServers: [server] };
    }

    await this.toolIndexCache.invalidate();
    await Promise.all([...this.sessions.values()].map((session) => session.close()));
    this.sessions.clear();
    return { invalidatedServers: this.listServers().map((entry) => entry.name) };
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.close()));
  }

  private getSession(serverName: string): BackendSession {
    const existing = this.sessions.get(serverName);
    if (existing) {
      return existing;
    }
    const config = this.requireServer(serverName);
    const session = new BackendSession(config, this.logger, this.toolIndexCache);
    this.sessions.set(serverName, session);
    return session;
  }

  async listServerTools(server: string, refresh = false): Promise<Tool[]> {
    const config = this.requireServer(server);
    const tools = await this.getSession(config.name).listTools(refresh);
    return this.applyPolicy(config.name, tools);
  }

  private filterServers(server?: string): NormalizedServerConfig[] {
    if (!server) {
      return this.listServers();
    }
    return [this.requireServer(server)];
  }

  private requireServer(name: string): NormalizedServerConfig {
    const config = this.configByName.get(name);
    if (!config) {
      const resolved = this.resolveServerCandidates(name);
      if (resolved.length === 1) {
        return resolved[0];
      }
      if (resolved.length > 1) {
        throw new Error(`Ambiguous server ${name}. Matches: ${resolved.map((entry) => entry.name).join(', ')}`);
      }

      const suggestions = this.listServers()
        .map((entry) => ({
          server: entry,
          score: this.scoreServerCandidate(entry, name),
        }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score || left.server.name.localeCompare(right.server.name))
        .slice(0, 5)
        .map((entry) => entry.server.name);

      throw new Error(
        suggestions.length > 0
          ? `Unknown server ${name}. Did you mean: ${suggestions.join(', ')}?`
          : `Unknown server ${name}`,
      );
    }
    return config;
  }

  private createBackendError(config: NormalizedServerConfig, error: unknown): BackendLookupError {
    return {
      server: config.name,
      message: error instanceof Error ? error.message : String(error),
      sourceKind: config.sourceKind,
      sourceFile: config.sourceFile,
      transport: config.transport,
    };
  }

  private resolveServerCandidates(name: string): NormalizedServerConfig[] {
    const normalizedName = normalizeToken(name);
    if (!normalizedName) {
      return [];
    }

    const configs = this.listServers();
    const caseInsensitive = dedupeServers(
      configs.filter((config) => this.getServerAliases(config).some((alias) => alias.toLowerCase() === name.toLowerCase())),
    );
    if (caseInsensitive.length > 0) {
      return caseInsensitive;
    }

    const normalizedExact = dedupeServers(
      configs.filter((config) => this.getServerAliases(config).some((alias) => normalizeToken(alias) === normalizedName)),
    );
    if (normalizedExact.length > 0) {
      return normalizedExact;
    }

    return dedupeServers(
      configs.filter((config) => this.getServerAliases(config).some((alias) => {
        const normalizedAlias = normalizeToken(alias);
        return normalizedAlias.includes(normalizedName) || normalizedName.includes(normalizedAlias);
      })),
    );
  }

  private getServerAliases(config: NormalizedServerConfig): string[] {
    const aliases = new Set<string>([config.name]);
    const metadataName = typeof config.metadata?.name === 'string' ? config.metadata.name : undefined;
    if (metadataName) {
      aliases.add(metadataName);
    }
    return [...aliases];
  }

  private scoreServerCandidate(config: NormalizedServerConfig, query: string): number {
    return Math.max(...this.getServerAliases(config).map((alias) => scoreText(alias, query)));
  }

  private buildToolNotFoundMessage(serverName: string, toolName: string, tools: Tool[]): string {
    const toolNames = tools.map((tool) => tool.name).sort((left, right) => left.localeCompare(right));
    const suggestions = toolNames
      .map((name) => ({ name, score: scoreText(name, toolName) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
      .slice(0, 5)
      .map((entry) => entry.name);

    if (toolNames.length <= 10) {
      return `Tool ${toolName} not found on server ${serverName}. Available tools: ${toolNames.join(', ')}`;
    }

    if (suggestions.length > 0) {
      return `Tool ${toolName} not found on server ${serverName}. Closest matches: ${suggestions.join(', ')}`;
    }

    return `Tool ${toolName} not found on server ${serverName}`;
  }

  private applyPolicy(serverName: string, tools: Tool[]): Tool[] {
    const serverPolicy = this.policy?.servers?.[serverName];
    if (!serverPolicy || serverPolicy.mode === 'passthrough') {
      return tools;
    }

    const allowed = new Set(serverPolicy.allowedTools);
    return tools.filter((tool) => allowed.has(tool.name));
  }

  private assertToolAllowed(serverName: string, toolName: string): void {
    const serverPolicy = this.policy?.servers?.[serverName];
    if (!serverPolicy || serverPolicy.mode === 'passthrough') {
      return;
    }
    if (serverPolicy.allowedTools.includes(toolName)) {
      return;
    }

    throw new Error(
      `Tool ${toolName} is not permitted on server ${serverName} by the current mcp-graph policy. Re-run install or refresh the policy to approve newly discovered tools.`,
    );
  }
}

export function scoreTool(serverName: string, tool: Tool, query: string): number {
  if (!query.trim()) {
    return 1;
  }
  return scoreText(serverName, query) + scoreText(tool.name, query) * 2 + scoreText(tool.description ?? '', query);
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function dedupeServers(configs: NormalizedServerConfig[]): NormalizedServerConfig[] {
  return [...new Map(configs.map((config) => [config.name, config])).values()];
}
