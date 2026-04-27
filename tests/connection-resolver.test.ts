import { describe, expect, it } from 'vitest';
import { buildConnectionPlans, createResolution, inferAuthMode } from '../src/connection-resolver.js';
import type { NormalizedServerConfig } from '../src/types.js';

function makeRemote(overrides: Partial<NormalizedServerConfig> = {}): NormalizedServerConfig {
  return {
    name: 'remote-backend',
    sourceFile: '/tmp/backends.json',
    sourceKind: 'explicit',
    priority: 100,
    transport: 'streamable-http',
    url: 'https://example.com/mcp',
    ...overrides,
  };
}

describe('connection resolver', () => {
  it('adds a streamable-http candidate ahead of misconfigured Coralogix SSE entries', () => {
    const plans = buildConnectionPlans(makeRemote({
      name: 'coralogix-server',
      transport: 'sse',
      url: 'https://api.coralogix.in/mgmt/api/v1/mcp',
      headers: { Authorization: 'token' },
    }));

    expect(plans[0]).toMatchObject({
      strategy: 'coralogix-streamable-http',
      transport: 'streamable-http',
      url: 'https://api.coralogix.in/mgmt/api/v1/mcp',
    });
    expect(plans.some((plan) => plan.strategy === 'configured' && plan.transport === 'sse')).toBe(true);
  });

  it('adds a sibling /mcp fallback for /sse endpoints', () => {
    const plans = buildConnectionPlans(makeRemote({
      name: 'gandalf-redash-mcp-server',
      transport: 'sse',
      url: 'https://prod-gandalf-mcp.razorpay.com/sse',
    }));

    expect(plans.some((plan) => plan.strategy === 'sse-sibling-mcp' && plan.url === 'https://prod-gandalf-mcp.razorpay.com/mcp')).toBe(true);
    expect(plans.some((plan) => plan.strategy === 'gandalf-streamable-http' && plan.url === 'https://prod-gandalf-mcp.razorpay.com/mcp')).toBe(true);
  });

  it('classifies auth mode and remediation for OAuth/token failures', () => {
    expect(inferAuthMode(makeRemote({
      name: 'slack',
      url: 'https://mcp.slack.com/mcp',
      metadata: { oauth: { callbackPort: 3118, clientId: 'abc' } },
    }))).toBe('oauth-browser');

    const resolution = createResolution({
      plans: [{
        strategy: 'configured',
        transport: 'streamable-http',
        url: 'https://mcp.slack.com/mcp',
        authMode: 'oauth-browser',
        ok: false,
        error: 'missing_token',
      }],
    });

    expect(resolution.remediation).toContain('Run `node dist/cli.js auth login --server <name>` to bootstrap OAuth tokens for this backend.');
  });
});
