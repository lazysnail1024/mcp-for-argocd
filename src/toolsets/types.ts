import type {
  CallToolResult,
  InputRequiredResult,
  McpServer,
  RequestStateCodec,
  ServerContext,
  ToolAnnotations
} from '@modelcontextprotocol/server';
import { isInputRequiredResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ArgoCDClient } from '../argocd/client.js';
import type { RequestOptions } from '../argocd/http.js';
import { translateErrorForAgent } from '../argocd/errors.js';
import { serializeWithByteLimit } from '../governance/byteBreaker.js';
import type { WriteConfirmationState } from '../governance/mrtrGate.js';
import { sanitizePayload } from '../governance/sanitizer.js';
import type { ScopeFence } from '../governance/scopeFence.js';
import { logToolAudit } from '../logging/logging.js';
import { assertNoReservedParamNames } from '../shared/models/schema.js';

export type ToolsetName = 'core' | 'diagnostics' | 'ops' | 'admin';

export const ALL_TOOLSETS: readonly ToolsetName[] = ['core', 'diagnostics', 'ops', 'admin'];
export const DEFAULT_TOOLSETS: readonly ToolsetName[] = ['core', 'diagnostics'];
export const WRITE_TOOLSETS: ReadonlySet<ToolsetName> = new Set(['ops', 'admin']);

export const argocdBaseUrlField = z
  .string()
  .optional()
  .meta({ 'x-mcp-header': 'Argo-Instance' })
  .describe(
    'Optional Argo CD base URL override for this call (e.g. "https://argocd.example.com"). ' +
      'Non-default instances must be registered in ARGOCD_TOKEN_REGISTRY_PATH.'
  );

export const appNameField = z
  .string()
  .min(1)
  .meta({ 'x-mcp-header': 'App-Name' })
  .describe('Argo CD Application name.');

export const projectField = z.string().min(1).meta({ 'x-mcp-header': 'Argo-Project' });

export type ToolExecutionEnv = {
  era: 'modern' | 'legacy';
  caller: string;
  scopeFence: ScopeFence;
  stateCodec: RequestStateCodec<WriteConfirmationState>;
  maxResponseBytes: number;
  allowPrune: boolean;
  allowedResourceActions?: ReadonlySet<string>;
  resolveClient: (args: { argocdBaseUrl?: string }) => {
    client: ArgoCDClient;
    baseUrl: string;
  };
};

export type ToolHandlerContext = {
  client: ArgoCDClient;
  baseUrl: string;
  requestOptions: RequestOptions;
  mcpCtx: ServerContext;
  env: ToolExecutionEnv;
};

export type ToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> = {
  name: string;
  toolset: ToolsetName;
  description: string;
  inputShape: Shape;
  annotations: ToolAnnotations;
  handler: (
    args: z.infer<z.ZodObject<Shape>>,
    ctx: ToolHandlerContext
  ) => Promise<unknown | InputRequiredResult>;
};

const extractTraceparent = (ctx: ServerContext): string | undefined => {
  const meta = (ctx.mcpReq as { _meta?: Record<string, unknown> })._meta;
  const tp = meta?.traceparent;
  return typeof tp === 'string' && tp.trim().length > 0 ? tp.trim() : undefined;
};

const extractProtocolVersion = (ctx: ServerContext, era: 'modern' | 'legacy'): string => {
  const envelope = (ctx.mcpReq as { envelope?: Record<string, unknown> }).envelope;
  const rev = envelope?.['io.modelcontextprotocol/protocolVersion'];
  if (typeof rev === 'string' && rev.length > 0) return rev;
  return era === 'modern' ? '2026-07-28' : '2025-11-25';
};

export const registerToolDefinition = (
  server: McpServer,
  def: ToolDefinition,
  env: ToolExecutionEnv
): void => {
  assertNoReservedParamNames(def.name, def.inputShape);
  const fullSchema = z.object({
    ...def.inputShape,
    argocdBaseUrl: argocdBaseUrlField
  });

  server.registerTool(
    def.name,
    {
      description: def.description,
      inputSchema: fullSchema,
      annotations: def.annotations
    },
    async (rawArgs, mcpCtx): Promise<CallToolResult | InputRequiredResult> => {
      const startedAt = Date.now();
      const argsObj = (rawArgs ?? {}) as Record<string, unknown>;
      const argocdBaseUrl =
        typeof argsObj.argocdBaseUrl === 'string' ? argsObj.argocdBaseUrl : undefined;
      const applicationName =
        typeof argsObj.applicationName === 'string' ? argsObj.applicationName : undefined;
      const projectName =
        typeof argsObj.project === 'string'
          ? argsObj.project
          : typeof argsObj.projectName === 'string'
            ? argsObj.projectName
            : undefined;

      let resolvedBaseUrl = argocdBaseUrl;
      const protocolVersion = extractProtocolVersion(mcpCtx, env.era);

      try {
        const { client, baseUrl } = env.resolveClient({ argocdBaseUrl });
        resolvedBaseUrl = baseUrl;

        const traceparent = extractTraceparent(mcpCtx);
        const requestOptions: RequestOptions = traceparent ? { headers: { traceparent } } : {};

        const restArgs = { ...argsObj };
        delete restArgs.argocdBaseUrl;

        const rawResult = await def.handler(restArgs, {
          client,
          baseUrl,
          requestOptions,
          mcpCtx,
          env
        });

        if (isInputRequiredResult(rawResult)) {
          logToolAudit({
            caller: env.caller || undefined,
            tool: def.name,
            argocdBaseUrl: resolvedBaseUrl,
            applicationName,
            project: projectName,
            protocolVersion,
            durationMs: Date.now() - startedAt,
            isError: false
          });
          return rawResult;
        }

        const sanitized = sanitizePayload(rawResult);
        const text = serializeWithByteLimit(sanitized, def.name, env.maxResponseBytes);

        logToolAudit({
          caller: env.caller || undefined,
          tool: def.name,
          argocdBaseUrl: resolvedBaseUrl,
          applicationName,
          project: projectName,
          protocolVersion,
          durationMs: Date.now() - startedAt,
          isError: false
        });

        return {
          isError: false,
          content: [{ type: 'text', text }]
        };
      } catch (error) {
        const errorType = error instanceof Error ? error.name : 'UnknownError';
        const message = translateErrorForAgent(error, {
          toolName: def.name,
          applicationName,
          projectName
        });

        logToolAudit({
          caller: env.caller || undefined,
          tool: def.name,
          argocdBaseUrl: resolvedBaseUrl,
          applicationName,
          project: projectName,
          protocolVersion,
          durationMs: Date.now() - startedAt,
          isError: true,
          errorType
        });

        return {
          isError: true,
          content: [{ type: 'text', text: message }]
        };
      }
    }
  );
};
