import { createHash, randomBytes } from 'node:crypto';
import {
  acceptedContent,
  createRequestStateCodec,
  inputRequired,
  type InputRequiredResult,
  type RequestStateCodec,
  type ServerContext
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { logger } from '../logging/logging.js';

export type WriteConfirmationState = {
  tool: string;
  target: string;
  digest: string;
  caller: string;
};

const ConfirmSchema = z.object({
  confirm: z.boolean().describe('Set to true to approve this operation')
});

const deriveKeyBytes = (secret: string | undefined): Uint8Array => {
  const trimmed = secret?.trim();
  if (trimmed) {
    // Domain-separated SHA-256 guarantees a deterministic 32-byte (256-bit) HMAC key
    // across all stateless replicas even if the operator supplied a shorter secret.
    return new Uint8Array(
      createHash('sha256').update('argocd-mcp-plus:mrtr-request-state:v1:').update(trimmed).digest()
    );
  }
  logger.warn(
    'MCP_REQUEST_STATE_SECRET is unset; generating an ephemeral per-process HMAC key. ' +
      'Set a shared MCP_REQUEST_STATE_SECRET across replicas to support multi-pod MRTR approvals.'
  );
  return new Uint8Array(randomBytes(32));
};

export const computeParamsDigest = (payload: Record<string, unknown>): string => {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return createHash('sha256').update(canonical).digest('hex').slice(0, 24);
};

export const createWriteStateCodec = (options?: {
  secret?: string;
  ttlSeconds?: number;
  getCaller?: (ctx: ServerContext) => string;
}): RequestStateCodec<WriteConfirmationState> => {
  const key = deriveKeyBytes(options?.secret ?? process.env.MCP_REQUEST_STATE_SECRET);
  return createRequestStateCodec<WriteConfirmationState>({
    key,
    ttlSeconds: options?.ttlSeconds ?? 300,
    bind: (ctx) => {
      const caller = options?.getCaller?.(ctx) ?? '';
      return `${ctx.mcpReq.method}\0${caller}`;
    }
  });
};

export type ConfirmationGateInput = {
  era: 'modern' | 'legacy';
  toolName: string;
  target: string;
  summary: string;
  paramsDigest: string;
  caller: string;
  ctx: ServerContext;
  stateCodec: RequestStateCodec<WriteConfirmationState>;
};

export type ConfirmationGateOutcome =
  | { kind: 'approved' }
  | { kind: 'challenge'; result: InputRequiredResult }
  | { kind: 'unsupported_client' };

// Check whether the current request is on the 2026-07-28 modern era AND declared
// form elicitation support in its per-request envelope (strictly gated on the
// authoritative era rather than unnegotiated version strings).
export const clientSupportsModernElicitation = (
  era: 'modern' | 'legacy',
  ctx: ServerContext
): boolean => {
  if (era !== 'modern') return false;
  const envelope = (ctx.mcpReq as { envelope?: Record<string, unknown> }).envelope;
  const caps = envelope?.['io.modelcontextprotocol/clientCapabilities'] as
    | { elicitation?: unknown }
    | undefined;
  return caps?.elicitation !== undefined && caps.elicitation !== false;
};

export const evaluateMrtrConfirmation = async (
  input: ConfirmationGateInput
): Promise<ConfirmationGateOutcome> => {
  if (!clientSupportsModernElicitation(input.era, input.ctx)) {
    return { kind: 'unsupported_client' };
  }

  const confirmed = acceptedContent(input.ctx.mcpReq.inputResponses, 'confirm', ConfirmSchema);
  const verifiedState = input.ctx.mcpReq.requestState<WriteConfirmationState>();

  if (
    confirmed?.confirm === true &&
    verifiedState &&
    verifiedState.tool === input.toolName &&
    verifiedState.target === input.target &&
    verifiedState.digest === input.paramsDigest &&
    verifiedState.caller === input.caller
  ) {
    return { kind: 'approved' };
  }

  const minted = await input.stateCodec.mint(
    {
      tool: input.toolName,
      target: input.target,
      digest: input.paramsDigest,
      caller: input.caller
    },
    input.ctx
  );

  return {
    kind: 'challenge',
    result: inputRequired({
      requestState: minted,
      inputRequests: {
        confirm: inputRequired.elicit({
          message: input.summary,
          requestedSchema: ConfirmSchema
        })
      }
    })
  };
};
