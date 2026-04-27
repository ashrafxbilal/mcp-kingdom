import { afterEach, describe, expect, it } from 'vitest';
import { GraphRegistry } from '../src/clients.js';
import { loadMergedServerConfigs } from '../src/config.js';
import { AuditLogger } from '../src/logger.js';
import { buildGraphPolicy } from '../src/policy.js';
import { createBackendConfig, createFailingServerDefinition, createMockServerDefinition } from './helpers/mock-backend.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('graph policy', () => {
  it('builds allow-listed policy entries and safe-probe results for reachable backends', async () => {
    const backend = await createBackendConfig({
      reachable: createMockServerDefinition(),
      failing: createFailingServerDefinition(),
    });
    cleanups.push(backend.cleanup);

    const loaded = await loadMergedServerConfigs({
      explicitConfigPaths: [backend.backendConfigPath],
      includeCodex: false,
    });

    const policy = await buildGraphPolicy(loaded, {
      verifyTimeoutMs: 4_000,
    });

    expect(policy.summary.totalServers).toBe(2);
    expect(policy.servers.reachable.mode).toBe('allow-listed');
    expect(policy.servers.reachable.allowedTools).toEqual(['catalog', 'echo']);
    expect(policy.servers.reachable.probe?.tool).toBe('catalog');
    expect(policy.servers.reachable.probe?.status).toBe('ok');

    expect(policy.servers.failing.mode).toBe('passthrough');
    expect(policy.servers.failing.allowedTools).toEqual([]);
    expect(policy.servers.failing.error).toBeTruthy();
  });

  it('filters backend tools according to the generated policy at runtime', async () => {
    const backend = await createBackendConfig({
      reachable: createMockServerDefinition(),
    });
    cleanups.push(backend.cleanup);

    const loaded = await loadMergedServerConfigs({
      explicitConfigPaths: [backend.backendConfigPath],
      includeCodex: false,
    });

    const policy = await buildGraphPolicy(loaded, {
      verifyTimeoutMs: 4_000,
    });
    policy.servers.reachable.allowedTools = ['catalog'];

    const registry = new GraphRegistry(loaded, new AuditLogger(), policy);
    const tools = await registry.listServerTools('reachable');
    expect(tools.map((tool) => tool.name)).toEqual(['catalog']);

    const search = await registry.searchTools({ server: 'reachable', limit: 10 });
    expect(search.matches.map((match) => match.tool.name)).toEqual(['catalog']);

    await expect(registry.getTool('reachable', 'echo')).rejects.toThrow('not permitted');
    await registry.close();
  });
});
