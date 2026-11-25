import { McpServer, type RequestStateCodec } from '@modelcontextprotocol/server';
import packageJSON from '../../package.json' with { type: 'json' };
import { ArgoCDClient } from '../argocd/client.js';
import { resolveMaxResponseBytes } from '../governance/byteBreaker.js';
import { createWriteStateCodec, type WriteConfirmationState } from '../governance/mrtrGate.js';
import { ScopeFence } from '../governance/scopeFence.js';
import { registerEnabledToolsets, type ToolSelectionConfig } from '../toolsets/index.js';
import { TokenRegistry, tokenRegistryFromEnv } from './tokenRegistry.js';

export const SERVER_INSTRUCTIONS =
  'When troubleshooting an Argo CD application, do NOT fetch unfiltered full resource trees or raw manifests first. ' +
  'Start with diagnose_application to inspect only abnormal resources, operationState errors, and Warning events; ' +
  'then call diff_application to view structured live-vs-target configuration differences; ' +
  'finally use scoped diagnostics tools (with kind/name/resourceRefs/grep filters) only when deep inspection is needed.';

export type ServerInfo = {
  argocdBaseUrl: string;
  argocdApiToken: string;
  tokenRegistry?: TokenRegistry;
  era?: 'modern' | 'legacy';
  caller?: string;
  selection?: ToolSelectionConfig;
  scopeFence?: ScopeFence;
  stateCodec?: RequestStateCodec<WriteConfirmationState>;
  maxResponseBytes?: number;
  allowPrune?: boolean;
  allowedResourceActions?: string[];
};

const MAX_CACHED_CLIENTS = 64;

const parseCsvSet = (raw: string | undefined): Set<string> | undefined => {
  if (!raw || !raw.trim()) return undefined;
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length > 0 ? new Set(items) : undefined;
};

// Bounded pool of outbound ArgoCDClient instances keyed by normalized baseUrl + token.
// Credentials are strictly resolved per call using the host-bound invariant:
//   - The default token is bound ONLY to the default base URL and never sent elsewhere.
//   - Any non-default base URL must resolve its token from the configured TokenRegistry.
export class ArgoCDClientResolver {
  private readonly defaultBaseUrl: string;
  private readonly defaultApiToken: string;
  private readonly tokenRegistry: TokenRegistry;
  private readonly clientCache = new Map<string, ArgoCDClient>();

  constructor(defaultBaseUrl: string, defaultApiToken: string, tokenRegistry: TokenRegistry) {
    this.defaultBaseUrl = defaultBaseUrl;
    this.defaultApiToken = defaultApiToken;
    this.tokenRegistry = tokenRegistry;
  }

  public resolve(args: { argocdBaseUrl?: string }): { client: ArgoCDClient; baseUrl: string } {
    const baseUrl = (args.argocdBaseUrl || this.defaultBaseUrl || '').trim();
    if (!baseUrl) {
      throw new Error(
        'Missing required ArgoCD base URL: argocdBaseUrl. ' +
          'Provide it as a tool argument, or configure the server via the ' +
          'x-argocd-base-url header or ARGOCD_BASE_URL env var.'
      );
    }

    const isDefaultBaseUrl =
      this.defaultBaseUrl.trim().length > 0 &&
      TokenRegistry.normalize(baseUrl) === TokenRegistry.normalize(this.defaultBaseUrl);

    const apiToken = isDefaultBaseUrl
      ? this.defaultApiToken || this.tokenRegistry.getToken(baseUrl)
      : this.tokenRegistry.getToken(baseUrl);

    if (!apiToken) {
      throw new Error(
        `Missing required ArgoCD API token for base URL "${baseUrl}". ` +
          'Provide it via the x-argocd-api-token header / ARGOCD_API_TOKEN env var, ' +
          'or register a token for this base URL in ARGOCD_TOKEN_REGISTRY_PATH.'
      );
    }

    const cacheKey = `${TokenRegistry.normalize(baseUrl)}\0${apiToken}`;
    let client = this.clientCache.get(cacheKey);
    if (!client) {
      if (this.clientCache.size >= MAX_CACHED_CLIENTS) {
        const oldestKey = this.clientCache.keys().next().value;
        if (oldestKey !== undefined) this.clientCache.delete(oldestKey);
      }
      client = new ArgoCDClient(baseUrl, apiToken);
      this.clientCache.set(cacheKey, client);
    }
    return { client, baseUrl };
  }
}

export const createServer = (serverInfo: ServerInfo): McpServer => {
  const tokenRegistry = serverInfo.tokenRegistry ?? tokenRegistryFromEnv();
  const scopeFence = serverInfo.scopeFence ?? ScopeFence.fromEnv();
  const era = serverInfo.era ?? 'modern';
  const caller = serverInfo.caller ?? '';
  const stateCodec =
    serverInfo.stateCodec ??
    createWriteStateCodec({
      getCaller: () => caller
    });
  const maxResponseBytes = serverInfo.maxResponseBytes ?? resolveMaxResponseBytes();
  const allowPrune =
    serverInfo.allowPrune !== undefined
      ? serverInfo.allowPrune
      : String(process.env.MCP_ALLOW_PRUNE ?? '')
          .trim()
          .toLowerCase() === 'true';
  const allowedResourceActions =
    serverInfo.allowedResourceActions !== undefined
      ? new Set(serverInfo.allowedResourceActions)
      : parseCsvSet(process.env.MCP_ALLOWED_RESOURCE_ACTIONS);

  const resolver = new ArgoCDClientResolver(
    serverInfo.argocdBaseUrl,
    serverInfo.argocdApiToken,
    tokenRegistry
  );

  const server = new McpServer(
    {
      name: packageJSON.name,
      version: packageJSON.version
    },
    {
      // Toolsets are static per server startup; disabling listChanged lets SDK v2's
      // subscriptions/listen router acknowledge empty subscriptions and close streams immediately.
      capabilities: {
        tools: { listChanged: false }
      },
      instructions: SERVER_INSTRUCTIONS,
      cacheHints: {
        'tools/list': { ttlMs: 3600000, cacheScope: 'public' },
        'server/discover': { ttlMs: 3600000, cacheScope: 'public' }
      },
      requestState: {
        verify: stateCodec.verify
      }
    }
  );

  registerEnabledToolsets(
    server,
    {
      era,
      caller,
      scopeFence,
      stateCodec,
      maxResponseBytes,
      allowPrune,
      allowedResourceActions,
      resolveClient: (args) => resolver.resolve(args)
    },
    serverInfo.selection
  );

  return server;
};
