import { ResponseSizeLimitError } from '../argocd/errors.js';

export const DEFAULT_MAX_RESPONSE_BYTES = 65536;

export const resolveMaxResponseBytes = (
  raw: string | undefined = process.env.MCP_MAX_RESPONSE_BYTES
): number => {
  if (!raw || !raw.trim()) {
    return DEFAULT_MAX_RESPONSE_BYTES;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid MCP_MAX_RESPONSE_BYTES value "${raw}". Expected a positive integer.`);
  }
  return parsed;
};

// Serialize a payload to JSON and enforce a hard UTF-8 byte ceiling.
// Never truncates JSON mid-stream into invalid syntax; throws ResponseSizeLimitError
// so the ErrorTranslator returns an actionable filter hint instead.
export const serializeWithByteLimit = (
  payload: unknown,
  toolName: string,
  limitBytes: number = resolveMaxResponseBytes()
): string => {
  const serialized = JSON.stringify(payload);
  const actualBytes = Buffer.byteLength(serialized, 'utf8');
  if (actualBytes > limitBytes) {
    throw new ResponseSizeLimitError(toolName, actualBytes, limitBytes);
  }
  return serialized;
};
