import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GRAPH_TOOL_NAMES } from '../src/constants.js';
import { installMcpKingdom } from '../src/install.js';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((dirPath) => fs.rm(dirPath, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function createFixtureRoot(): Promise<{ rootDir: string; homeDir: string; projectDir: string }> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-kingdom-install-'));
  const homeDir = path.join(rootDir, 'home');
  const projectDir = path.join(rootDir, 'project');
  tempRoots.push(rootDir);
  await fs.mkdir(path.join(homeDir, '.claude'), { recursive: true });
  await fs.mkdir(path.join(homeDir, '.codex'), { recursive: true });
  await fs.mkdir(projectDir, { recursive: true });
  return { rootDir, homeDir, projectDir };
}

describe('installMcpKingdom', () => {
  it('rewrites Claude, Codex, and legacy OpenCode configs to use only mcp-kingdom', async () => {
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
        permissions: {
          allow: [
            'Read',
            'Glob',
            'mcp__mcp-graph__list_servers',
            'mcp__old-claude__run',
          ],
        },
        mcpServers: {
          'old-claude': {
            command: 'old-claude',
          },
        },
      }, null, 2),
      'utf8',
    );

    await fs.writeFile(
      path.join(homeDir, '.claude', 'settings.local.json'),
      JSON.stringify({
        outputStyle: 'Explanatory',
        permissions: {
          allow: [
            'WebSearch',
            'Bash(ls:*)',
            'mcp__old-claude__list',
            'mcp__mcp-kingdom__search_tools',
          ],
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
          'mcp-graph_*': 'allow',
          'mcp_graph_*': 'allow',
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

    const result = await installMcpKingdom({
      cwd: projectDir,
      homeDir,
      backendPath: path.join(homeDir, '.mcp-kingdom', 'backends.json'),
      policyPath: path.join(homeDir, '.mcp-kingdom', 'policy.json'),
      auditLogPath: path.join(homeDir, '.mcp-kingdom', 'audit.log'),
      targets: ['claude', 'codex', 'opencode'],
    });

    expect(result.backendServerCount).toBe(4);
    expect(result.targets).toEqual(['claude', 'codex', 'opencode']);
    expect(result.backups.length).toBeGreaterThan(0);
    expect(result.policyPath).toBe(path.join(homeDir, '.mcp-kingdom', 'policy.json'));
    expect(result.policySummary.totalServers).toBe(4);

    const snapshot = JSON.parse(await fs.readFile(path.join(homeDir, '.mcp-kingdom', 'backends.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(snapshot.mcpServers).sort()).toEqual([
      'old-claude',
      'old-codex',
      'old-opencode',
      'project-backend',
    ]);

    const policy = JSON.parse(await fs.readFile(path.join(homeDir, '.mcp-kingdom', 'policy.json'), 'utf8')) as {
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
    expect(Object.keys(settings.mcpServers)).toEqual(['mcp-kingdom']);
    for (const toolName of GRAPH_TOOL_NAMES) {
      expect(settings.permissions.allow).toContain(`mcp__mcp-kingdom__${toolName}`);
    }
    expect(settings.permissions.allow).not.toContain('mcp__mcp-graph__list_servers');
    expect(settings.permissions.allow).not.toContain('mcp__old-claude__run');
    expect(settings.permissions.allow).toContain('Read');
    expect(settings.permissions.allow).toContain('Glob');

    const localSettings = JSON.parse(await fs.readFile(path.join(homeDir, '.claude', 'settings.local.json'), 'utf8')) as {
      outputStyle: string;
      permissions: { allow: string[] };
    };
    expect(localSettings.outputStyle).toBe('Explanatory');
    expect(localSettings.permissions.allow).toEqual([
      'WebSearch',
      'Bash(ls:*)',
    ]);

    const opencode = JSON.parse(await fs.readFile(path.join(homeDir, '.opencode.json'), 'utf8')) as {
      permission: Record<string, unknown>;
      mcp: Record<string, { type: string; command: string[] }>;
    };
    expect(Object.keys(opencode.mcp)).toEqual(['mcp-kingdom']);
    expect(opencode.mcp['mcp-kingdom']?.type).toBe('local');
    expect(opencode.mcp['mcp-kingdom']?.command[0]).toContain('tsx');
    expect(opencode.mcp['mcp-kingdom']?.command[1]).toMatch(/src\/cli\.ts$/);
    expect(opencode.permission.read).toBe('allow');
    expect(Object.keys(opencode.permission)).not.toContain('mcp__old-opencode__list');
    expect(Object.keys(opencode.permission)).not.toContain('mcp-graph_*');
    expect(Object.keys(opencode.permission)).not.toContain('mcp_graph_*');
    expect(opencode.permission['mcp-kingdom_*']).toBe('allow');
    expect(opencode.permission['mcp_kingdom_*']).toBe('allow');

    const codex = await fs.readFile(path.join(homeDir, '.codex', 'config.toml'), 'utf8');
    expect(codex).toContain('[mcp_servers.mcp-kingdom]');
    expect(codex).not.toContain('[mcp_servers.old-codex]');
    expect(codex).not.toContain('command = "npx"');
    expect(codex).toContain('MCP_KINGDOM_POLICY_PATH');
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

    const result = await installMcpKingdom({
      cwd: projectDir,
      homeDir,
      backendPath: path.join(homeDir, '.mcp-kingdom', 'backends.json'),
      policyPath: path.join(homeDir, '.mcp-kingdom', 'policy.json'),
      targets: ['claude'],
      dryRun: true,
    });

    expect(result.changedFiles).toContain(path.join(homeDir, '.claude', 'settings.json'));
    expect(result.changedFiles).toContain(path.join(homeDir, '.mcp-kingdom', 'policy.json'));
    await expect(fs.access(path.join(homeDir, '.mcp-kingdom', 'backends.json'))).rejects.toThrow();
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

    await fs.mkdir(path.join(homeDir, '.mcp-kingdom'), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, '.mcp-kingdom', 'backends.json'),
      JSON.stringify({
        mcpServers: {
          'preserved-backend': {
            command: 'preserved-backend',
          },
        },
      }, null, 2),
      'utf8',
    );

    const result = await installMcpKingdom({
      cwd: projectDir,
      homeDir,
      backendPath: path.join(homeDir, '.mcp-kingdom', 'backends.json'),
      policyPath: path.join(homeDir, '.mcp-kingdom', 'policy.json'),
      targets: ['claude'],
    });

    expect(result.backendServerCount).toBe(2);
    expect(result.policySummary.totalServers).toBe(2);

    const policy = JSON.parse(await fs.readFile(path.join(homeDir, '.mcp-kingdom', 'policy.json'), 'utf8')) as {
      servers: Record<string, { mode: string }>;
    };
    expect(Object.keys(policy.servers).sort()).toEqual([
      'preserved-backend',
      'project-backend',
    ]);
  });
});
