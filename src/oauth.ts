import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { DEFAULT_AUTH_DIR } from './constants.js';
import { buildConnectionPlans, inferAuthMode, type ConnectionPlan } from './connection-resolver.js';
import type { LoadedServerConfig, NormalizedServerConfig } from './types.js';
import { ensureDir, fileExists, readJsonFile, withTimeout, writeJsonFile } from './utils.js';

interface OAuthState {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
}

export interface AuthLoginResult {
  server: string;
  strategy: string;
  authFile: string;
  toolCount: number;
  transport: string;
  url?: string;
}

export class FileOAuthClientProvider implements OAuthClientProvider {
  private readonly redirectCallbackUrl: URL;
  private listener?: Server;
  private authorizationCodePromise?: Promise<string>;
  private resolveAuthorizationCode?: (code: string) => void;
  private rejectAuthorizationCode?: (error: Error) => void;

  constructor(
    private readonly config: NormalizedServerConfig,
    private readonly authFilePath: string,
    private readonly interactive = false,
  ) {
    const callbackPort = getCallbackPort(config);
    this.redirectCallbackUrl = new URL(`http://127.0.0.1:${callbackPort}/callback`);
  }

  get redirectUrl(): string {
    return this.redirectCallbackUrl.toString();
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'mcp-graph',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const state = await this.readState();
    if (state.clientInformation) {
      return state.clientInformation;
    }

    const oauth = this.config.metadata?.oauth;
    if (oauth && typeof oauth === 'object' && !Array.isArray(oauth)) {
      const oauthRecord = oauth as Record<string, unknown>;
      const clientId = typeof oauthRecord.clientId === 'string'
        ? oauthRecord.clientId
        : undefined;
      if (clientId) {
        return { client_id: clientId };
      }
    }

    return undefined;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    const state = await this.readState();
    state.clientInformation = clientInformation;
    await this.writeState(state);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.readState()).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const state = await this.readState();
    state.tokens = tokens;
    await this.writeState(state);
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    process.stderr.write(`[mcp-graph] OAuth required for ${this.config.name}.\n${authorizationUrl.toString()}\n`);
    if (this.interactive) {
      void openBrowser(authorizationUrl.toString());
    }
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    const state = await this.readState();
    state.codeVerifier = codeVerifier;
    await this.writeState(state);
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await this.readState()).codeVerifier;
    if (!verifier) {
      throw new Error(`No code verifier saved for ${this.config.name}`);
    }
    return verifier;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    const current = await this.readState();
    current.discoveryState = state;
    await this.writeState(current);
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.readState()).discoveryState;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    const state = await this.readState();
    if (scope === 'all' || scope === 'client') {
      delete state.clientInformation;
    }
    if (scope === 'all' || scope === 'tokens') {
      delete state.tokens;
    }
    if (scope === 'all' || scope === 'verifier') {
      delete state.codeVerifier;
    }
    if (scope === 'all' || scope === 'discovery') {
      delete state.discoveryState;
    }
    await this.writeState(state);
  }

  async startAuthorizationListener(timeoutMs = 1000 * 120): Promise<Promise<string>> {
    if (this.authorizationCodePromise) {
      return this.authorizationCodePromise;
    }

    this.authorizationCodePromise = withTimeout(new Promise<string>((resolve, reject) => {
      this.resolveAuthorizationCode = resolve;
      this.rejectAuthorizationCode = reject;

      const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', this.redirectUrl);
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        if (code) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end('<html><body><h1>mcp-graph auth complete</h1><p>You can close this window.</p></body></html>');
          resolve(code);
          setTimeout(() => void this.stopAuthorizationListener(), 100);
          return;
        }

        if (error) {
          res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
          res.end(`<html><body><h1>mcp-graph auth failed</h1><p>${error}</p></body></html>`);
          reject(new Error(`OAuth authorization failed: ${error}`));
          setTimeout(() => void this.stopAuthorizationListener(), 100);
          return;
        }

        res.writeHead(404);
        res.end('Not found');
      });

      server.on('error', (error) => reject(error instanceof Error ? error : new Error(String(error))));
      server.listen(Number.parseInt(this.redirectCallbackUrl.port, 10), '127.0.0.1', () => {
        process.stderr.write(`[mcp-graph] Waiting for OAuth callback on ${this.redirectUrl}\n`);
      });
      this.listener = server;
    }), timeoutMs, `OAuth callback for ${this.config.name}`);

    return this.authorizationCodePromise;
  }

  async stopAuthorizationListener(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.listener) {
        resolve();
        return;
      }
      this.listener.close(() => resolve());
    });
    this.listener = undefined;
    this.authorizationCodePromise = undefined;
    this.resolveAuthorizationCode = undefined;
    this.rejectAuthorizationCode = undefined;
  }

  get authFilePathValue(): string {
    return this.authFilePath;
  }

  private async readState(): Promise<OAuthState> {
    if (!(await fileExists(this.authFilePath))) {
      return {};
    }
    return (await readJsonFile<OAuthState>(this.authFilePath)) ?? {};
  }

  private async writeState(state: OAuthState): Promise<void> {
    await ensureDir(path.dirname(this.authFilePath));
    await writeJsonFile(this.authFilePath, state);
  }
}

export function createOAuthProvider(config: NormalizedServerConfig, options?: { interactive?: boolean; authDir?: string }): FileOAuthClientProvider | undefined {
  if (config.transport === 'stdio') {
    return undefined;
  }
  const authMode = inferAuthMode(config);
  if (authMode === 'static-headers' || authMode === 'none') {
    return undefined;
  }

  const authDir = options?.authDir ?? process.env.MCP_GRAPH_AUTH_DIR ?? DEFAULT_AUTH_DIR;
  const authFilePath = path.join(authDir, `${sanitizeServerName(config.name)}.json`);
  return new FileOAuthClientProvider(config, authFilePath, options?.interactive ?? false);
}

export async function authLogin(loadedConfig: LoadedServerConfig, serverName: string): Promise<AuthLoginResult> {
  const config = resolveServer(loadedConfig, serverName);
  if (config.transport === 'stdio') {
    throw new Error(`Server ${config.name} uses stdio and does not require remote OAuth bootstrap.`);
  }
  if (inferAuthMode(config) === 'static-headers') {
    throw new Error(`Server ${config.name} uses static Authorization headers and does not require OAuth bootstrap.`);
  }

  const provider = createOAuthProvider(config, { interactive: true });
  if (!provider) {
    throw new Error(`Server ${config.name} does not advertise an OAuth-capable auth mode.`);
  }

  const plans = buildConnectionPlans(config).filter((plan) => plan.transport !== 'stdio');
  let lastError: unknown;

  for (const plan of plans) {
    const callbackPromise = await provider.startAuthorizationListener();
    let client: Client | undefined;
    let transport: StreamableHTTPClientTransport | SSEClientTransport | undefined;

    try {
      ({ client, transport } = createOAuthAwareClient(plan, provider));
      await client.connect(transport);
      const tools = await client.listTools();
      await provider.stopAuthorizationListener();
      await client.close();
      return {
        server: config.name,
        strategy: plan.strategy,
        authFile: provider.authFilePathValue,
        toolCount: tools.tools.length,
        transport: plan.transport,
        url: plan.url,
      };
    } catch (error) {
      lastError = error;
      if (!isAuthBootstrapError(error)) {
        await provider.stopAuthorizationListener();
        await client?.close().catch(() => undefined);
        continue;
      }

      const authorizationCode = await callbackPromise;
      await transport?.finishAuth?.(authorizationCode);
      await client?.close().catch(() => undefined);

      const retried = createOAuthAwareClient(plan, provider);
      await retried.client.connect(retried.transport);
      const tools = await retried.client.listTools();
      await retried.client.close();
      await provider.stopAuthorizationListener();

      return {
        server: config.name,
        strategy: plan.strategy,
        authFile: provider.authFilePathValue,
        toolCount: tools.tools.length,
        transport: plan.transport,
        url: plan.url,
      };
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function createOAuthAwareClient(
  plan: ConnectionPlan,
  provider: FileOAuthClientProvider,
): {
  client: Client;
  transport: StreamableHTTPClientTransport | SSEClientTransport;
} {
  if (!plan.url) {
    throw new Error(`Missing URL for strategy ${plan.strategy}`);
  }

  const url = new URL(plan.url);
  const transport = plan.transport === 'sse'
    ? new SSEClientTransport(url, {
      authProvider: provider,
      requestInit: { headers: plan.headers },
      eventSourceInit: { fetch: globalThis.fetch as typeof fetch, headers: plan.headers } as never,
    })
    : new StreamableHTTPClientTransport(url, {
      authProvider: provider,
      requestInit: { headers: plan.headers },
    });

  return {
    client: new Client({ name: 'mcp-graph-auth-client', version: '0.1.0' }, { capabilities: {} }),
    transport,
  };
}

function resolveServer(loadedConfig: LoadedServerConfig, serverName: string): NormalizedServerConfig {
  const exact = loadedConfig.servers.find((entry) => entry.name === serverName);
  if (exact) {
    return exact;
  }

  const normalized = normalizeToken(serverName);
  const candidates = loadedConfig.servers.filter((entry) => normalizeToken(entry.name) === normalized);
  if (candidates.length === 1) {
    return candidates[0];
  }
  if (candidates.length > 1) {
    throw new Error(`Ambiguous server ${serverName}. Matches: ${candidates.map((entry) => entry.name).join(', ')}`);
  }

  throw new Error(`Unknown server ${serverName}`);
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function sanitizeServerName(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, '_');
}

function getCallbackPort(config: NormalizedServerConfig): number {
  const oauth = config.metadata?.oauth;
  if (oauth && typeof oauth === 'object' && !Array.isArray(oauth)) {
    const value = (oauth as Record<string, unknown>).callbackPort;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return 33339;
}

function isAuthBootstrapError(error: unknown): boolean {
  if (error instanceof UnauthorizedError) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /invalid_token|missing_token|unauthorized|authorization/i.test(message);
}

async function openBrowser(url: string): Promise<void> {
  const candidates = process.platform === 'darwin'
    ? ['open']
    : process.platform === 'win32'
      ? ['cmd']
      : ['xdg-open'];

  const command = candidates[0];
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];

  await new Promise<void>((resolve) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => resolve());
    child.unref();
    resolve();
  });
}
