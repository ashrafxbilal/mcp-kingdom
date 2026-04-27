import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ToolIndexCache } from '../src/caching/tool-index-cache.js';
import type { NormalizedServerConfig } from '../src/types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dirPath) => fs.rm(dirPath, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function createCacheDir(): Promise<string> {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-graph-cache-'));
  tempDirs.push(dirPath);
  return dirPath;
}

function makeServer(overrides: Partial<NormalizedServerConfig> = {}): NormalizedServerConfig {
  return {
    name: 'cache-backend',
    sourceFile: '/tmp/backends.json',
    sourceKind: 'explicit',
    priority: 100,
    transport: 'stdio',
    command: 'node',
    args: ['backend.js'],
    ...overrides,
  };
}

function makeTools(): Tool[] {
  return [
    {
      name: 'echo',
      description: 'Echo a value',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string' },
        },
      },
    } as Tool,
  ];
}

describe('ToolIndexCache', () => {
  it('stores and reads tool indexes', async () => {
    const cacheDir = await createCacheDir();
    const cache = new ToolIndexCache({ cacheDir, ttlMs: 60_000 });
    const server = makeServer();

    await cache.set(server, makeTools());
    const result = await cache.get(server);

    expect(result?.stale).toBe(false);
    expect(result?.tools[0]?.name).toBe('echo');
  });

  it('treats old cache entries as stale', async () => {
    const cacheDir = await createCacheDir();
    const cache = new ToolIndexCache({ cacheDir, ttlMs: 1 });
    const server = makeServer();

    await cache.set(server, makeTools());

    const filePath = path.join(cacheDir, 'cache-backend.json');
    const current = JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<string, unknown>;
    current.cachedAt = '2000-01-01T00:00:00.000Z';
    await fs.writeFile(filePath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');

    const result = await cache.get(server);
    expect(result?.stale).toBe(true);
  });

  it('invalidates cache when the backend fingerprint changes', async () => {
    const cacheDir = await createCacheDir();
    const cache = new ToolIndexCache({ cacheDir, ttlMs: 60_000 });
    const server = makeServer();

    await cache.set(server, makeTools());
    const changed = await cache.get(makeServer({ env: { FEATURE_FLAG: '1' } }));

    expect(changed).toBeUndefined();
  });

  it('drops corrupt cache files instead of crashing', async () => {
    const cacheDir = await createCacheDir();
    const cache = new ToolIndexCache({ cacheDir, ttlMs: 60_000 });
    const server = makeServer();
    const filePath = path.join(cacheDir, 'cache-backend.json');

    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(filePath, '{this-is-not-json', 'utf8');

    const result = await cache.get(server);

    expect(result).toBeUndefined();
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it('invalidates cached files without removing unrelated directory entries', async () => {
    const cacheDir = await createCacheDir();
    const cache = new ToolIndexCache({ cacheDir, ttlMs: 60_000 });
    const server = makeServer();

    await cache.set(server, makeTools());
    await fs.mkdir(path.join(cacheDir, 'nested-dir'), { recursive: true });

    await cache.invalidate();

    await expect(fs.access(path.join(cacheDir, 'cache-backend.json'))).rejects.toThrow();
    await expect(fs.access(path.join(cacheDir, 'nested-dir'))).resolves.toBeUndefined();
  });
});
