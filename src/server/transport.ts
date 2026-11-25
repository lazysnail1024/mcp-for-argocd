import express from 'express';
import type { AddressInfo } from 'node:net';
import {
  createMcpHandler,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
  type McpRequestContext,
  type ServerContext
} from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { toWebRequest } from '@modelcontextprotocol/node';
import packageJSON from '../../package.json' with { type: 'json' };
import { resolveMaxResponseBytes } from '../governance/byteBreaker.js';
import { createWriteStateCodec } from '../governance/mrtrGate.js';
import { ScopeFence } from '../governance/scopeFence.js';
import { logger } from '../logging/logging.js';
import { resolveSelectedTools, type ToolSelectionConfig } from '../toolsets/index.js';
import { headerGuard } from './headerGuard.js';
import {
  applyListenerSecurity,
  resolveListenerSecurity,
  type ListenerSecurityOptions
} from './security.js';
import { createServer } from './server.js';
import { TokenRegistry, tokenRegistryFromEnv } from './tokenRegistry.js';

export type LegacyMode = 'stateless' | 'reject';

export type CommonServerOptions = {
  toolsets?: string;
  tools?: string;
  legacyMode?: LegacyMode;
  tokenRegistry?: TokenRegistry;
  scopeFence?: ScopeFence;
  requestStateSecret?: string;
  maxResponseBytes?: number;
  allowPrune?: boolean;
};

export type TransportOptions = ListenerSecurityOptions &
  CommonServerOptions & {
    stateless?: boolean;
    jsonResponse?: boolean;
  };

const resolveSelection = (options: CommonServerOptions): ToolSelectionConfig => ({
  toolsets: options.toolsets,
  tools: options.tools
});

const validateStartupConfig = (options: CommonServerOptions): void => {
  // Fail closed on invalid toolsets, tool names, or max response byte configuration.
  resolveSelectedTools(resolveSelection(options));
  if (options.maxResponseBytes === undefined) {
    resolveMaxResponseBytes();
  }
};

export const connectStdioTransport = (options: CommonServerOptions = {}) => {
  validateStartupConfig(options);
  const tokenRegistry = options.tokenRegistry ?? tokenRegistryFromEnv();
  const scopeFence = options.scopeFence ?? ScopeFence.fromEnv();
  const selection = resolveSelection(options);
  const legacyMode = options.legacyMode ?? 'stateless';
  const stateCodec = createWriteStateCodec({
    secret: options.requestStateSecret,
    getCaller: () => 'stdio'
  });

  logger.info(
    `Starting ${packageJSON.name}@${packageJSON.version} over stdio (legacy=${legacyMode})`
  );

  return serveStdio(
    (ctx: McpRequestContext) =>
      createServer({
        argocdBaseUrl: process.env.ARGOCD_BASE_URL || '',
        argocdApiToken: process.env.ARGOCD_API_TOKEN || '',
        tokenRegistry,
        scopeFence,
        selection,
        era: ctx.era,
        caller: 'stdio',
        stateCodec,
        maxResponseBytes: options.maxResponseBytes,
        allowPrune: options.allowPrune
      }),
    {
      legacy: legacyMode === 'reject' ? 'reject' : 'serve',
      onerror: (error) => {
        logger.error({ err: error.message }, 'Stdio MCP server error');
      }
    }
  );
};

// Liveness probe registered before the security middleware so Kubelet probes
// addressing the pod IP without a bearer token succeed.
const registerHealthz = (app: express.Express) => {
  app.get('/healthz', (_, res) => {
    res.status(200).json({
      status: 'ok',
      name: packageJSON.name,
      version: packageJSON.version
    });
  });
};

const listen = (app: express.Express, bindAddress: string, port: number, label: string) => {
  const server = app.listen(port, bindAddress);
  server.on('listening', () => {
    const { address, port: boundPort } = server.address() as AddressInfo;
    logger.info(`${label} listening on ${address}:${boundPort}`);
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    logger.error(`${label} could not bind ${bindAddress}:${port}: ${err.code ?? err.message}`);
    process.exit(1);
  });
  return server;
};

const resolveCredentials = (
  req: express.Request,
  res: express.Response,
  tokenRegistry: TokenRegistry
): { argocdBaseUrl: string; argocdApiToken: string } | null => {
  const argocdBaseUrl =
    (req.headers['x-argocd-base-url'] as string) || process.env.ARGOCD_BASE_URL || '';
  const argocdApiToken =
    (req.headers['x-argocd-api-token'] as string) || process.env.ARGOCD_API_TOKEN || '';
  if (!argocdApiToken && tokenRegistry.getSize() === 0) {
    res
      .status(400)
      .send(
        'x-argocd-api-token must be provided in the request header (or the ARGOCD_API_TOKEN env var), ' +
          'or a token registry must be configured via ARGOCD_TOKEN_REGISTRY_PATH.'
      );
    return null;
  }
  return { argocdBaseUrl, argocdApiToken };
};

// Write a Web Standard Response (JSON or SSE ReadableStream) onto Express res.
const writeWebResponse = async (webRes: Response, res: express.Response): Promise<void> => {
  res.status(webRes.status);
  webRes.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  if (!webRes.body) {
    res.end();
    return;
  }

  const reader = webRes.body.getReader();
  const onClose = () => {
    reader.cancel().catch(() => {});
  };
  res.on('close', onClose);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        if (!res.write(value)) {
          await new Promise<void>((resolve) => res.once('drain', resolve));
        }
      }
    }
    res.end();
  } finally {
    res.off('close', onClose);
  }
};

// Normalize Accept header on legacy stateless JSON-enabled requests so clients
// sending `Accept: application/json` (without `text/event-stream`) are served
// cleanly with `application/json` instead of receiving a spurious 406.
const normalizeLegacyAccept = (req: Request): Request => {
  const accept = req.headers.get('accept') ?? '';
  if (accept.includes('application/json') && accept.includes('text/event-stream')) {
    return req;
  }
  const headers = new Headers(req.headers);
  headers.set('accept', 'application/json, text/event-stream');
  return new Request(req, { headers });
};

const extractCallerHeader = (headers: Headers | undefined): string =>
  (headers?.get('x-mcp-caller') ?? '').trim();

export const createHttpApp = (options: TransportOptions) => {
  validateStartupConfig(options);
  const security = resolveListenerSecurity(options);
  const tokenRegistry = options.tokenRegistry ?? tokenRegistryFromEnv();
  const scopeFence = options.scopeFence ?? ScopeFence.fromEnv();
  const selection = resolveSelection(options);
  const legacyMode: LegacyMode = options.legacyMode ?? 'stateless';
  const jsonResponse = options.jsonResponse ?? true;

  if (options.stateless === false) {
    logger.warn(
      'Stateful HTTP session mode (--no-stateless) has been removed; ' +
        'running in stateless Dual-Era mode instead.'
    );
  }

  const stateCodec = createWriteStateCodec({
    secret: options.requestStateSecret,
    getCaller: (ctx: ServerContext) => {
      const httpHeaders = (ctx as { http?: { req?: Request } }).http?.req?.headers;
      return extractCallerHeader(httpHeaders);
    }
  });

  const buildServerForRequest = (ctx: McpRequestContext) => {
    const reqHeaders = ctx.requestInfo?.headers;
    const argocdBaseUrl = reqHeaders?.get('x-argocd-base-url') || process.env.ARGOCD_BASE_URL || '';
    const argocdApiToken =
      reqHeaders?.get('x-argocd-api-token') || process.env.ARGOCD_API_TOKEN || '';
    const caller = extractCallerHeader(reqHeaders);

    return createServer({
      argocdBaseUrl,
      argocdApiToken,
      tokenRegistry,
      scopeFence,
      selection,
      era: ctx.era,
      caller,
      stateCodec,
      maxResponseBytes: options.maxResponseBytes,
      allowPrune: options.allowPrune
    });
  };

  // Modern 2026-07-28 handler (rejects legacy when routed here directly).
  const modernHandler = createMcpHandler(buildServerForRequest, {
    legacy: 'reject',
    responseMode: 'auto',
    onerror: (error) => {
      logger.warn({ err: error.message }, 'MCP HTTP request error');
    }
  });

  const app = express();
  registerHealthz(app);
  applyListenerSecurity(app, security);
  app.use(express.json());
  app.use('/mcp', headerGuard);

  const methodNotAllowed: express.RequestHandler = (_req, res) => {
    res.setHeader('Allow', 'POST');
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Method Not Allowed in stateless mode' },
      id: null
    });
  };

  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  app.post('/mcp', async (req, res) => {
    const credentials = resolveCredentials(req, res, tokenRegistry);
    if (!credentials) return;

    try {
      const webReq = await toWebRequest(req, req.body);
      const legacy = await isLegacyRequest(webReq, req.body);

      if (!legacy || legacyMode === 'reject') {
        const response = await modernHandler.fetch(webReq, { parsedBody: req.body });
        await writeWebResponse(response, res);
        return;
      }

      // Legacy 2025-era stateless serving (JSON response by default; SSE frames with --no-json-response).
      const legacyReq = jsonResponse ? normalizeLegacyAccept(webReq) : webReq;
      const server = buildServerForRequest({ era: 'legacy', requestInfo: legacyReq });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: jsonResponse
      });
      await server.connect(transport);
      try {
        const response = await transport.handleRequest(legacyReq, { parsedBody: req.body });
        await writeWebResponse(response, res);
      } finally {
        await transport.close().catch(() => {});
        await server.close().catch(() => {});
      }
    } catch (error) {
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'Unhandled error serving /mcp request'
      );
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null
        });
      }
    }
  });

  return { app, security, close: () => modernHandler.close() };
};

export const connectHttpTransport = (options: TransportOptions) => {
  const { app, security } = createHttpApp(options);
  const legacyMode = options.legacyMode ?? 'stateless';
  const jsonResponse = options.jsonResponse ?? true;
  return listen(
    app,
    security.bindAddress,
    options.port,
    `${packageJSON.name}@${packageJSON.version} HTTP stateless transport (legacy=${legacyMode}, jsonResponse=${jsonResponse})`
  );
};
