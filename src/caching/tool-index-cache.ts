import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { DEFAULT_CACHE_DIR, DEFAULT_TOOL_CACHE_TTL_MS } from '../constants.js';
import { AuditLogger } from '../logger.js';
import type { NormalizedServerConfig } from '../types.js';
import { ensureDir, fileExists, safeJsonStringify } from '../utils.js';

interface ToolIndexCacheFile {
  server: string;
  fingerprint: string;
  cachedAt: string;
  tools: Tool[];
}

export interface ToolIndexCacheGetResult {
  tools: Tool[];
  stale: boolean;
  cachedAt: string;
}

export interface ToolIndexCacheOptions {
  cacheDir?: string;
  ttlMs?: number;
  logger?: AuditLogger;
}

export class ToolIndexCache {
  readonly cacheDir: string;
  readonly ttlMs: number;
  private readonly logger?: AuditLogger;

  constructor(options: ToolIndexCacheOptions = {}) {
    this.cacheDir = options.cacheDir ?? process.env.MCP_GRAPH_CACHE_DIR ?? DEFAULT_CACHE_DIR;
    const ttlValue = Number.parseInt(process.env.MCP_GRAPH_TOOL_CACHE_TTL_MS ?? '', 10);
    this.ttlMs = Number.isFinite(ttlValue) ? ttlValue : (options.ttlMs ?? DEFAULT_TOOL_CACHE_TTL_MS);
    this.logger = options.logger;
  }

  async get(server: NormalizedServerConfig): Promise<ToolIndexCacheGetResult | undefined> {
    const filePath = this.getFilePath(server.name);
    if (!(await fileExists(filePath))) {
      return undefined;
    }

    let parsed: ToolIndexCacheFile;
    try {
      parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as ToolIndexCacheFile;
    } catch (error) {
      await fs.rm(filePath, { force: true });
      await this.logger?.log('tool_cache_corrupt', {
        server: server.name,
        filePath,
        reason: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }

    if (parsed.fingerprint !== fingerprintServerConfig(server)) {
      await this.logger?.log('tool_cache_miss', {
        server: server.name,
        reason: 'fingerprint_mismatch',
      });
      return undefined;
    }

    const cachedAtMs = Date.parse(parsed.cachedAt);
    const stale = !Number.isFinite(cachedAtMs) || Date.now() - cachedAtMs > this.ttlMs;
    return {
      tools: parsed.tools,
      stale,
      cachedAt: parsed.cachedAt,
    };
  }

  async set(server: NormalizedServerConfig, tools: Tool[]): Promise<void> {
    await ensureDir(this.cacheDir);
    const payload: ToolIndexCacheFile = {
      server: server.name,
      fingerprint: fingerprintServerConfig(server),
      cachedAt: new Date().toISOString(),
      tools,
    };
    await fs.writeFile(this.getFilePath(server.name), `${safeJsonStringify(payload, 2)}\n`, 'utf8');
    await this.logger?.log('tool_cache_write', {
      server: server.name,
      cacheDir: this.cacheDir,
      toolCount: tools.length,
    });
  }

  async invalidate(server?: string): Promise<void> {
    if (server) {
      const filePath = this.getFilePath(server);
      if (await fileExists(filePath)) {
        await fs.rm(filePath, { force: true });
      }
      await this.logger?.log('tool_cache_invalidate', {
        server,
        scope: 'single',
      });
      return;
    }

    if (await fileExists(this.cacheDir)) {
      for (const entry of await fs.readdir(this.cacheDir, { withFileTypes: true })) {
        if (!entry.isFile()) {
          continue;
        }
        await fs.rm(path.join(this.cacheDir, entry.name), { force: true });
      }
    }
    await this.logger?.log('tool_cache_invalidate', {
      scope: 'all',
    });
  }

  private getFilePath(serverName: string): string {
    return path.join(this.cacheDir, `${sanitizeServerName(serverName)}.json`);
  }
}

export function fingerprintServerConfig(server: NormalizedServerConfig): string {
  const payload = {
    name: server.name,
    transport: server.transport,
    command: server.command,
    args: server.args,
    env: server.env,
    cwd: server.cwd,
    url: server.url,
    headers: server.headers,
    rawType: server.rawType,
    metadata: server.metadata,
  };

  return crypto.createHash('sha256').update(safeJsonStringify(payload, 0)).digest('hex');
}

function sanitizeServerName(serverName: string): string {
  return serverName.replace(/[^a-z0-9._-]+/gi, '_');
}
