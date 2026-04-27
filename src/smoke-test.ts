#!/usr/bin/env node
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { GraphRegistry } from './clients.js';
import { loadMergedServerConfigs } from './config.js';
import { installMcpGraph } from './install.js';
import { AuditLogger } from './logger.js';
import { safeJsonStringify } from './utils.js';

async function main(): Promise<void> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-graph-'));
  const tempHome = path.join(rootDir, 'home');
  const tempProject = path.join(rootDir, 'project');
  const backendConfigPath = path.join(rootDir, 'backends.json');
  const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  await fs.mkdir(tempHome, { recursive: true });
  await fs.mkdir(tempProject, { recursive: true });

  await runProxySmokeTest({ cwd, backendConfigPath });
  await runDiscoveryAndInstallSmokeTest({ tempHome, tempProject, cwd });

  process.stdout.write('smoke-test passed\n');
}

async function runProxySmokeTest({ cwd, backendConfigPath }: { cwd: string; backendConfigPath: string }): Promise<void> {
  await fs.writeFile(
    backendConfigPath,
    JSON.stringify(
      {
        mcpServers: {
          'mock-backend': {
            command: process.execPath,
            args: [path.join(cwd, 'dist', 'mock-backend.js')],
            cwd,
          },
        },
      },
      null,
      2,
    ),
  );

  const loaded = await loadMergedServerConfigs({ explicitConfigPaths: [backendConfigPath] });
  const registry = new GraphRegistry(loaded, new AuditLogger());

  const matches = await registry.searchTools({ query: 'echo', detail: 'summary' });
  if (matches.matches.length !== 1 || matches.matches[0]?.tool.name !== 'echo') {
    throw new Error(`Expected one echo tool, got ${safeJsonStringify(matches, 2)}`);
  }

  const result = await registry.callTool({
    server: 'mock-backend',
    tool: 'echo',
    arguments: { message: 'hello', tags: ['graph', 'test'] },
  });

  if (!result.text.includes('echo:hello [graph,test]')) {
    throw new Error(`Unexpected tool output: ${result.text}`);
  }

  const structured = await registry.callTool({
    server: 'mock-backend',
    tool: 'catalog',
    arguments: { size: 4 },
    outputMode: 'structured',
    fieldPath: 'items',
    maxArrayItems: 2,
  });

  if (!structured.text.includes('item-1') || structured.text.includes('item-4')) {
    throw new Error(`Expected shaped structured output, got ${structured.text}`);
  }

  await registry.close();
}

async function runDiscoveryAndInstallSmokeTest({
  tempHome,
  tempProject,
  cwd,
}: {
  tempHome: string;
  tempProject: string;
  cwd: string;
}): Promise<void> {
  await writeFixtureConfigs({ tempHome, tempProject, cwd });

  const discovered = await loadMergedServerConfigs({ cwd: tempProject, homeDir: tempHome, includeCodex: true });
  const discoveredNames = discovered.servers.map((entry) => entry.name);
  for (const expectedName of ['project-backend', 'claude-backend', 'settings-backend', 'codex-backend', 'opencode-backend']) {
    if (!discoveredNames.includes(expectedName)) {
      throw new Error(`Expected discovery to include ${expectedName}, got ${safeJsonStringify(discoveredNames, 2)}`);
    }
  }
  if (discoveredNames.includes('disabled-opencode-backend')) {
    throw new Error('Disabled OpenCode MCP should not be discovered by default.');
  }

  const installResult = await installMcpGraph({
    cwd: tempProject,
    homeDir: tempHome,
    backendPath: path.join(tempHome, '.mcp-graph', 'backends.json'),
    policyPath: path.join(tempHome, '.mcp-graph', 'policy.json'),
    auditLogPath: path.join(tempHome, '.mcp-graph', 'audit.log'),
    targets: ['claude', 'codex', 'opencode'],
  });

  if (installResult.targets.length !== 3) {
    throw new Error(`Expected three install targets, got ${safeJsonStringify(installResult, 2)}`);
  }
  if (installResult.policySummary.totalServers !== 5) {
    throw new Error(`Expected policy summary to include five servers, got ${safeJsonStringify(installResult.policySummary, 2)}`);
  }

  const backendSnapshot = JSON.parse(await fs.readFile(path.join(tempHome, '.mcp-graph', 'backends.json'), 'utf8')) as {
    mcpServers: Record<string, unknown>;
  };
  for (const expectedName of ['project-backend', 'claude-backend', 'settings-backend', 'codex-backend', 'opencode-backend']) {
    if (!(expectedName in backendSnapshot.mcpServers)) {
      throw new Error(`Expected backend snapshot to include ${expectedName}`);
    }
  }
  if ('mcp-graph' in backendSnapshot.mcpServers) {
    throw new Error('Backend snapshot should not contain mcp-graph itself.');
  }

  const policy = JSON.parse(await fs.readFile(path.join(tempHome, '.mcp-graph', 'policy.json'), 'utf8')) as {
    servers: Record<string, { mode: string; allowedTools: string[] }>;
  };
  if (policy.servers['project-backend']?.mode !== 'allow-listed') {
    throw new Error(`Expected project-backend to be allow-listed, got ${safeJsonStringify(policy, 2)}`);
  }

  const claudeJson = JSON.parse(await fs.readFile(path.join(tempHome, '.claude.json'), 'utf8')) as {
    mcpServers: Record<string, unknown>;
  };
  assertSingleFrontDoor(claudeJson.mcpServers, '.claude.json');

  const claudeMcp = JSON.parse(await fs.readFile(path.join(tempHome, '.claude', 'mcp.json'), 'utf8')) as {
    mcpServers: Record<string, unknown>;
  };
  assertSingleFrontDoor(claudeMcp.mcpServers, '.claude/mcp.json');

  const claudeSettings = JSON.parse(await fs.readFile(path.join(tempHome, '.claude', 'settings.json'), 'utf8')) as {
    mcpServers: Record<string, unknown>;
    permissions?: { allow?: string[] };
  };
  assertSingleFrontDoor(claudeSettings.mcpServers, '.claude/settings.json');
  for (const toolName of [
    'mcp__mcp-graph__list_servers',
    'mcp__mcp-graph__search_tools',
    'mcp__mcp-graph__call_tool',
    'mcp__project-backend__catalog',
  ]) {
    if (!claudeSettings.permissions?.allow?.includes(toolName)) {
      throw new Error(`Expected Claude settings allowlist to include ${toolName}`);
    }
  }

  const opencodeConfig = JSON.parse(await fs.readFile(path.join(tempHome, '.config', 'opencode', 'opencode.json'), 'utf8')) as {
    mcp: Record<string, unknown>;
    permission?: Record<string, unknown>;
  };
  if (!opencodeConfig.mcp || !('mcp-graph' in opencodeConfig.mcp) || Object.keys(opencodeConfig.mcp).length !== 1) {
    throw new Error(`Expected OpenCode config to contain only mcp-graph, got ${safeJsonStringify(opencodeConfig, 2)}`);
  }
  if (opencodeConfig.permission?.['mcp-graph_*'] !== 'allow') {
    throw new Error(`Expected OpenCode permission to include mcp-graph_*, got ${safeJsonStringify(opencodeConfig.permission, 2)}`);
  }

  const codexConfig = await fs.readFile(path.join(tempHome, '.codex', 'config.toml'), 'utf8');
  if (
    !codexConfig.includes('[mcp_servers.mcp-graph]')
    || codexConfig.includes('[mcp_servers.codex-backend]')
    || !codexConfig.includes('MCP_GRAPH_POLICY_PATH')
  ) {
    throw new Error(`Unexpected Codex config after install:\n${codexConfig}`);
  }
}

async function writeFixtureConfigs({
  tempHome,
  tempProject,
  cwd,
}: {
  tempHome: string;
  tempProject: string;
  cwd: string;
}): Promise<void> {
  await fs.mkdir(path.join(tempHome, '.claude'), { recursive: true });
  await fs.mkdir(path.join(tempHome, '.codex'), { recursive: true });
  await fs.mkdir(path.join(tempHome, '.config', 'opencode'), { recursive: true });

  await fs.writeFile(
    path.join(tempProject, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        'project-backend': {
          command: process.execPath,
          args: [path.join(cwd, 'dist', 'mock-backend.js')],
          cwd,
        },
      },
    }, null, 2),
  );

  await fs.writeFile(
    path.join(tempHome, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        'claude-backend': {
          command: process.execPath,
          args: [path.join(cwd, 'dist', 'mock-backend.js')],
          cwd,
        },
      },
    }, null, 2),
  );

  await fs.writeFile(
    path.join(tempHome, '.claude', 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        'claude-backend': {
          command: process.execPath,
          args: [path.join(cwd, 'dist', 'mock-backend.js')],
          cwd,
        },
      },
    }, null, 2),
  );

  await fs.writeFile(
    path.join(tempHome, '.claude', 'settings.json'),
    JSON.stringify({
      permissions: {
        allow: ['Read'],
      },
      mcpServers: {
        'settings-backend': {
          command: process.execPath,
          args: [path.join(cwd, 'dist', 'mock-backend.js')],
          cwd,
        },
      },
    }, null, 2),
  );

  await fs.writeFile(
    path.join(tempHome, '.codex', 'config.toml'),
    [
      'model = "gpt-5.4"',
      '',
      '[mcp_servers.codex-backend]',
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(path.join(cwd, 'dist', 'mock-backend.js'))}]`,
      `cwd = ${JSON.stringify(cwd)}`,
      '',
    ].join('\n'),
  );

  await fs.writeFile(
    path.join(tempHome, '.config', 'opencode', 'opencode.json'),
    JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        'opencode-backend': {
          type: 'local',
          command: [process.execPath, path.join(cwd, 'dist', 'mock-backend.js')],
          enabled: true,
        },
        'disabled-opencode-backend': {
          type: 'remote',
          url: 'https://example.com/sse',
          enabled: false,
        },
      },
    }, null, 2),
  );
}

function assertSingleFrontDoor(mcpServers: Record<string, unknown>, label: string): void {
  const names = Object.keys(mcpServers ?? {});
  if (names.length !== 1 || names[0] !== 'mcp-graph') {
    throw new Error(`Expected ${label} to contain only mcp-graph, got ${safeJsonStringify(mcpServers, 2)}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
