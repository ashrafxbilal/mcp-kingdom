import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GRAPH_TOOL_NAMES } from '../src/constants.js';
import { installMcpGraph } from '../src/install.js';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((dirPath) => fs.rm(dirPath, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function createFixtureRoot(): Promise<{ rootDir: string; homeDir: string; projectDir: string }> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-graph-install-'));
  const homeDir = path.join(rootDir, 'home');
  const projectDir = path.join(rootDir, 'project');
  tempRoots.push(rootDir);
  await fs.mkdir(path.join(homeDir, '.claude'), { recursive: true });
  await fs.mkdir(path.join(homeDir, '.codex'), { recursive: true });
  await fs.mkdir(projectDir, { recursive: true });
  return { rootDir, homeDir, projectDir };
}

describe('installMcpGraph', () => {
  it('rewrites Claude, Codex, and legacy OpenCode configs to use only mcp-graph', async () => {
    const { homeDir, projectDir } = await createFixtureRoot();

    await fs.writeFile(
      path.join(projectDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'project-backend': {
            command: 'project-backend',
            args: ['serve'],
          },
        },
      }, null, 2),
      'utf8',
    );

    await fs.writeFile(
      path.join(homeDir, '.claude', 'settings.json'),
      JSON.stringify({
        permissions: { allow: ['Read'] },
        mcpServers: {
          'old-claude': {
            command: 'old-claude',
          },
        },
      }, null, 2),
      'utf8',
    );

    await fs.writeFile(
      path.join(homeDir, '.codex', 'config.toml'),
      [
        '[mcp_servers.old-codex]',
        'command = "old-codex"',
        '',
      ].join('\n'),
      'utf8',
    );

    await fs.writeFile(
      path.join(homeDir, '.opencode.json'),
      JSON.stringify({
        permission: {
          read: 'allow',
          'mcp__old-opencode__list': 'allow',
        },
        mcp: {
          'old-opencode': {
            type: 'local',
            command: ['old-opencode', 'serve'],
            enabled: true,
          },
        },
      }, null, 2),
      'utf8',
    );

    const result = await installMcpGraph({
      cwd: projectDir,
      homeDir,
      backendPath: path.join(homeDir, '.mcp-graph', 'backends.json'),
      policyPath: path.join(homeDir, '.mcp-graph', 'policy.json'),
      auditLogPath: path.join(homeDir, '.mcp-graph', 'audit.log'),
      targets: ['claude', 'codex', 'opencode'],
    });

    expect(result.backendServerCount).toBe(4);
    expect(result.targets).toEqual(['claude', 'codex', 'opencode']);
    expect(result.backups.length).toBeGreaterThan(0);
    expect(result.policyPath).toBe(path.join(homeDir, '.mcp-graph', 'policy.json'));
    expect(result.policySummary.totalServers).toBe(4);

    const snapshot = JSON.parse(await fs.readFile(path.join(homeDir, '.mcp-graph', 'backends.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(snapshot.mcpServers).sort()).toEqual([
      'old-claude',
      'old-codex',
      'old-opencode',
      'project-backend',
    ]);

    const policy = JSON.parse(await fs.readFile(path.join(homeDir, '.mcp-graph', 'policy.json'), 'utf8')) as {
      summary: { totalServers: number };
      servers: Record<string, { mode: string }>;
    };
    expect(policy.summary.totalServers).toBe(4);
    expect(Object.keys(policy.servers).sort()).toEqual([
      'old-claude',
      'old-codex',
      'old-opencode',
      'project-backend',
    ]);

    const settings = JSON.parse(await fs.readFile(path.join(homeDir, '.claude', 'settings.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
      permissions: { allow: string[] };
    };
    expect(Object.keys(settings.mcpServers)).toEqual(['mcp-graph']);
    for (const toolName of GRAPH_TOOL_NAMES) {
      expect(settings.permissions.allow).toContain(`mcp__mcp-graph__${toolName}`);
    }

    const opencode = JSON.parse(await fs.readFile(path.join(homeDir, '.opencode.json'), 'utf8')) as {
      permission: Record<string, unknown>;
      mcp: Record<string, { type: string; command: string[] }>;
    };
    expect(Object.keys(opencode.mcp)).toEqual(['mcp-graph']);
    expect(opencode.mcp['mcp-graph']?.type).toBe('local');
    expect(opencode.mcp['mcp-graph']?.command[0]).toContain('tsx');
    expect(opencode.mcp['mcp-graph']?.command[1]).toMatch(/src\/cli\.ts$/);
    expect(opencode.permission.read).toBe('allow');
    expect(Object.keys(opencode.permission)).not.toContain('mcp__old-opencode__list');
    expect(opencode.permission['mcp-graph_*']).toBe('allow');
    expect(opencode.permission['mcp_graph_*']).toBe('allow');

    const codex = await fs.readFile(path.join(homeDir, '.codex', 'config.toml'), 'utf8');
    expect(codex).toContain('[mcp_servers.mcp-graph]');
    expect(codex).not.toContain('[mcp_servers.old-codex]');
    expect(codex).not.toContain('command = "npx"');
    expect(codex).toContain('MCP_GRAPH_POLICY_PATH');
  });

  it('supports dry-run without mutating files', async () => {
    const { homeDir, projectDir } = await createFixtureRoot();

    await fs.writeFile(
      path.join(projectDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'project-backend': {
            command: 'project-backend',
          },
        },
      }, null, 2),
      'utf8',
    );

    const result = await installMcpGraph({
      cwd: projectDir,
      homeDir,
      backendPath: path.join(homeDir, '.mcp-graph', 'backends.json'),
      policyPath: path.join(homeDir, '.mcp-graph', 'policy.json'),
      targets: ['claude'],
      dryRun: true,
    });

    expect(result.changedFiles).toContain(path.join(homeDir, '.claude', 'settings.json'));
    expect(result.changedFiles).toContain(path.join(homeDir, '.mcp-graph', 'policy.json'));
    await expect(fs.access(path.join(homeDir, '.mcp-graph', 'backends.json'))).rejects.toThrow();
  });

  it('builds policy entries for preserved backends that already exist in the snapshot', async () => {
    const { homeDir, projectDir } = await createFixtureRoot();

    await fs.writeFile(
      path.join(projectDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'project-backend': {
            command: 'project-backend',
          },
        },
      }, null, 2),
      'utf8',
    );

    await fs.mkdir(path.join(homeDir, '.mcp-graph'), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, '.mcp-graph', 'backends.json'),
      JSON.stringify({
        mcpServers: {
          'preserved-backend': {
            command: 'preserved-backend',
          },
        },
      }, null, 2),
      'utf8',
    );

    const result = await installMcpGraph({
      cwd: projectDir,
      homeDir,
      backendPath: path.join(homeDir, '.mcp-graph', 'backends.json'),
      policyPath: path.join(homeDir, '.mcp-graph', 'policy.json'),
      targets: ['claude'],
    });

    expect(result.backendServerCount).toBe(2);
    expect(result.policySummary.totalServers).toBe(2);

    const policy = JSON.parse(await fs.readFile(path.join(homeDir, '.mcp-graph', 'policy.json'), 'utf8')) as {
      servers: Record<string, { mode: string }>;
    };
    expect(Object.keys(policy.servers).sort()).toEqual([
      'preserved-backend',
      'project-backend',
    ]);
  });
});
