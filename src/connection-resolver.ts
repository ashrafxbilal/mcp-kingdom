import type {
  ConnectionAttemptReport,
  ConnectionResolution,
  GraphAuthMode,
  GraphTransport,
  NormalizedServerConfig,
} from './types.js';

export interface ConnectionPlan {
  strategy: string;
  transport: GraphTransport;
  authMode: GraphAuthMode;
  url?: string;
  headers?: Record<string, string>;
}

export function buildConnectionPlans(config: NormalizedServerConfig): ConnectionPlan[] {
  if (config.transport === 'stdio') {
    return [{
      strategy: 'configured',
      transport: 'stdio',
      authMode: 'none',
    }];
  }

  const authMode = inferAuthMode(config);
  const plans: ConnectionPlan[] = [];
  const pushPlan = (plan: ConnectionPlan) => {
    const key = `${plan.transport}::${plan.url ?? ''}::${plan.strategy}`;
    if (plans.some((entry) => `${entry.transport}::${entry.url ?? ''}::${entry.strategy}` === key)) {
      return;
    }
    plans.push(plan);
  };

  const configuredUrl = config.url;
  const host = configuredUrl ? safeHostname(configuredUrl) : undefined;
  const pathname = configuredUrl ? safePathname(configuredUrl) : undefined;

  if (configuredUrl && host && isCoralogixHost(host) && config.transport === 'sse') {
    pushPlan({
      strategy: 'coralogix-streamable-http',
      transport: 'streamable-http',
      authMode,
      url: configuredUrl,
      headers: config.headers,
    });
  }

  pushPlan({
    strategy: 'configured',
    transport: config.transport,
    authMode,
    url: configuredUrl,
    headers: config.headers,
  });

  if (configuredUrl && config.transport === 'sse') {
    pushPlan({
      strategy: 'same-url-streamable-http',
      transport: 'streamable-http',
      authMode,
      url: configuredUrl,
      headers: config.headers,
    });
  }

  if (configuredUrl && pathname?.endsWith('/sse')) {
    pushPlan({
      strategy: 'sse-sibling-mcp',
      transport: 'streamable-http',
      authMode,
      url: replacePathname(configuredUrl, pathname.replace(/\/sse$/i, '/mcp')),
      headers: config.headers,
    });
  }

  if (configuredUrl && host === 'prod-gandalf-mcp.razorpay.com') {
    pushPlan({
      strategy: 'gandalf-streamable-http',
      transport: 'streamable-http',
      authMode,
      url: replacePathname(configuredUrl, '/mcp'),
      headers: config.headers,
    });
  }

  return plans;
}

export function inferAuthMode(config: NormalizedServerConfig): GraphAuthMode {
  if (config.headers && Object.keys(config.headers).some((key) => key.toLowerCase() === 'authorization')) {
    return 'static-headers';
  }

  const oauth = config.metadata?.oauth;
  if (oauth && typeof oauth === 'object' && !Array.isArray(oauth)) {
    return 'oauth-browser';
  }

  if (config.url) {
    const host = safeHostname(config.url);
    if (host === 'mcp.slack.com' || host === 'spinnaker-mcp.razorpay.com') {
      return 'oauth-browser';
    }
  }

  return 'none';
}

export function createResolution({
  plans,
  selected,
}: {
  plans: ConnectionAttemptReport[];
  selected?: ConnectionAttemptReport;
}): ConnectionResolution {
  return {
    selectedStrategy: selected?.strategy,
    effectiveTransport: selected?.transport,
    effectiveUrl: selected?.url,
    authMode: selected?.authMode ?? plans[0]?.authMode ?? 'none',
    attempts: plans,
    remediation: buildRemediation(plans),
  };
}

export function buildRemediation(attempts: ConnectionAttemptReport[]): string[] {
  const errors = attempts
    .filter((attempt) => !attempt.ok && attempt.error)
    .map((attempt) => attempt.error ?? '');
  const remediation = new Set<string>();

  if (errors.some((error) => /invalid_token|missing_token|unauthorized|authorization/i.test(error))) {
    remediation.add('Run `node dist/cli.js auth login --server <name>` to bootstrap OAuth tokens for this backend.');
  }

  if (errors.some((error) => /405/.test(error))) {
    remediation.add('This backend likely expects streamable HTTP instead of SSE. mcp-graph now tries that automatically.');
  }

  if (errors.some((error) => /503/.test(error))) {
    remediation.add('The backend is unavailable right now. Retry later or check the upstream MCP service health.');
  }

  return [...remediation];
}

function isCoralogixHost(host: string): boolean {
  return host === 'api.coralogix.in' || host.endsWith('.coralogix.com');
}

function safeHostname(value: string): string | undefined {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function safePathname(value: string): string | undefined {
  try {
    return new URL(value).pathname;
  } catch {
    return undefined;
  }
}

function replacePathname(value: string, pathname: string): string {
  const url = new URL(value);
  url.pathname = pathname;
  return url.toString();
}
