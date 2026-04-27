import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { GRAPH_TOOL_NAMES } from '../src/constants.js';
import { createBackendConfig, createFailingServerDefinition, createMockBackendConfig, createMockServerDefinition, getRepoRoot } from './helpers/mock-backend.js';

const execFileAsync = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) {
      await cleanup();
    }
  }
});

describe('mcp-graph CLI', () => {
  it('serves the top-level progressive-disclosure MCP surface over stdio', async () => {
    const fixture = await createMockBackendConfig();
    cleanups.push(fixture.cleanup);

    const repoRoot = getRepoRoot();
    const transport = new StdioClientTransport({
      command: path.join(repoRoot, 'node_modules', '.bin', 'tsx'),
      args: [path.join(repoRoot, 'src', 'cli.ts')],
      env: {
        ...(process.env as Record<string, string | undefined>),
        MCP_GRAPH_CONFIG_PATH: fixture.backendConfigPath,
      } as Record<string, string>,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'mcp-graph-test-client', version: '0.0.0' }, { capabilities: {} });

    try {
      await client.connect(transport);

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([...GRAPH_TOOL_NAMES].sort());

      const servers = await client.callTool({
        name: 'list_servers',
        arguments: {
          includeToolCounts: true,
        },
      });
      expect(extractText(servers)).toContain('mock-backend');
      expect(extractText(servers)).toContain('(2 tools)');

      const result = await client.callTool({
        name: 'call_tool',
        arguments: {
          server: 'mock-backend',
          tool: 'catalog',
          outputMode: 'structured',
          fieldPath: 'items',
          maxArrayItems: 1,
        },
      });
      expect(extractText(result)).toContain('item-1');
      expect(extractText(result)).not.toContain('item-2');

      const refresh = await client.callTool({
        name: 'refresh_cache',
        arguments: {
          mode: 'invalidate-and-refresh',
        },
      });
      expect(extractText(refresh)).toContain('Invalidated and refreshed');
    } finally {
      await client.close();
    }
  });

  it('prints inspect output with backend tool counts', async () => {
    const fixture = await createMockBackendConfig();
    cleanups.push(fixture.cleanup);

    const repoRoot = getRepoRoot();
    const command = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
    const scriptPath = path.join(repoRoot, 'src', 'cli.ts');

    const { stdout } = await execFileAsync(command, [scriptPath, 'inspect', '--tool-counts'], {
      cwd: repoRoot,
      env: {
        ...(process.env as Record<string, string | undefined>),
        MCP_GRAPH_CONFIG_PATH: fixture.backendConfigPath,
      } as NodeJS.ProcessEnv,
    });

    const parsed = JSON.parse(stdout) as {
      serverCount: number;
      totalBackendTools: number;
      frontDoorToolCount: number;
    };
    expect(parsed.serverCount).toBe(1);
    expect(parsed.totalBackendTools).toBe(2);
    expect(parsed.frontDoorToolCount).toBe(GRAPH_TOOL_NAMES.length);
  });

  it('falls back to the saved backend snapshot when the active configs have already been rewired', async () => {
    const fixture = await createMockBackendConfig();
    cleanups.push(fixture.cleanup);

    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-graph-cli-home-'));
    cleanups.push(async () => fs.rm(tempHome, { recursive: true, force: true }));
    await fs.mkdir(path.join(tempHome, '.config', 'opencode'), { recursive: true });
    await fs.writeFile(
      path.join(tempHome, '.config', 'opencode', 'opencode.json'),
      JSON.stringify({
        mcp: {
          'mcp-graph': {
            type: 'local',
            command: [process.execPath, '/tmp/mcp-graph-cli.js'],
          },
        },
      }, null, 2),
      'utf8',
    );
    await fs.mkdir(path.join(tempHome, '.mcp-graph'), { recursive: true });
    await fs.copyFile(fixture.backendConfigPath, path.join(tempHome, '.mcp-graph', 'backends.json'));

    const repoRoot = getRepoRoot();
    const command = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
    const scriptPath = path.join(repoRoot, 'src', 'cli.ts');
    const { stdout } = await execFileAsync(command, [scriptPath, 'inspect', '--tool-counts'], {
      cwd: repoRoot,
      env: {
        ...(process.env as Record<string, string | undefined>),
        HOME: tempHome,
      } as NodeJS.ProcessEnv,
    });

    const parsed = JSON.parse(stdout) as {
      serverCount: number;
      totalBackendTools: number;
      loadedFiles: string[];
    };
    expect(parsed.serverCount).toBe(1);
    expect(parsed.totalBackendTools).toBe(2);
    expect(parsed.loadedFiles).toEqual([path.join(tempHome, '.mcp-graph', 'backends.json')]);
  });

  it('returns partial search results and backend errors instead of failing the whole request', async () => {
    const fixture = await createBackendConfig({
      'mock-backend': createMockServerDefinition(),
      broken: createFailingServerDefinition(),
    });
    cleanups.push(fixture.cleanup);

    const repoRoot = getRepoRoot();
    const transport = new StdioClientTransport({
      command: path.join(repoRoot, 'node_modules', '.bin', 'tsx'),
      args: [path.join(repoRoot, 'src', 'cli.ts')],
      env: {
        ...(process.env as Record<string, string | undefined>),
        MCP_GRAPH_CONFIG_PATH: fixture.backendConfigPath,
      } as Record<string, string>,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'mcp-graph-test-client', version: '0.0.0' }, { capabilities: {} });

    try {
      await client.connect(transport);

      const search = await client.callTool({
        name: 'search_tools',
        arguments: {
          query: 'echo',
          detail: 'summary',
        },
      });
      expect(extractText(search)).toContain('mock-backend.echo');
      expect(extractText(search)).toContain('Backend errors:');
      expect(extractText(search)).toContain('broken:');

      const servers = await client.callTool({
        name: 'list_servers',
        arguments: {
          includeToolCounts: true,
        },
      });
      expect(extractText(servers)).toContain('mock-backend');
      expect(extractText(servers)).toContain('broken');
      expect(extractText(servers)).toContain('[error:');
    } finally {
      await client.close();
    }
  });
});

function extractText(result: { content?: Array<{ type?: string; text?: string }> }): string {
  return (result.content ?? [])
    .filter((entry) => entry.type === 'text')
    .map((entry) => entry.text ?? '')
    .join('\n');
}
