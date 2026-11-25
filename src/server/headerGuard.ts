import type express from 'express';

// Non-secret routing parameter header aliases (SEP-2243 x-mcp-header mapping).
// Secrets and tokens MUST NEVER be added to this map.
export const ROUTABLE_PARAM_HEADER_MAP: Record<string, string[]> = {
  'argo-instance': ['argocdBaseUrl'],
  'argo-project': ['project', 'projectName'],
  'app-name': ['applicationName']
};

const HEADER_MISMATCH_ERROR_CODE = -32020;

const decodeMcpHeaderValue = (raw: string): { ok: true; value: string } | { ok: false } => {
  const match = /^=\?base64\?([^?]*)\?=$/.exec(raw);
  if (!match) {
    return { ok: true, value: raw };
  }
  const encoded = match[1];
  // Validate canonical base64 characters before decoding.
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    return { ok: false };
  }
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    return { ok: true, value: decoded };
  } catch {
    return { ok: false };
  }
};

const firstHeader = (value: string | string[] | undefined): string | undefined => {
  if (Array.isArray(value)) return value[0];
  return value;
};

const rejectMismatch = (
  res: express.Response,
  id: string | number | null,
  message: string
): void => {
  res.status(400).json({
    jsonrpc: '2.0',
    error: {
      code: HEADER_MISMATCH_ERROR_CODE,
      message
    },
    id
  });
};

// Cross-era SEP-2243 anti-desync guard.
// Validates Mcp-Method, Mcp-Name, and Mcp-Param-* headers against the JSON-RPC
// request body whenever those headers are present — protecting both 2026-07-28
// modern requests and 2025-era fallback requests from header-forging gateway
// bypasses (Protocol Desync), while letting header-less 2025 requests pass.
export const headerGuard: express.RequestHandler = (req, res, next) => {
  if (req.method.toUpperCase() !== 'POST') {
    next();
    return;
  }

  const body = req.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    next();
    return;
  }

  const rpcId = typeof body.id === 'string' || typeof body.id === 'number' ? body.id : null;
  const bodyMethod = typeof body.method === 'string' ? body.method : undefined;
  const params =
    body.params && typeof body.params === 'object' && !Array.isArray(body.params)
      ? (body.params as Record<string, unknown>)
      : undefined;

  const mcpMethod = firstHeader(req.headers['mcp-method']);
  if (mcpMethod !== undefined) {
    if (!bodyMethod || mcpMethod.trim() !== bodyMethod) {
      rejectMismatch(
        res,
        rpcId,
        `Header mismatch: Mcp-Method "${mcpMethod}" does not match JSON-RPC method "${bodyMethod ?? ''}".`
      );
      return;
    }
  }

  const mcpName = firstHeader(req.headers['mcp-name']);
  if (mcpName !== undefined) {
    const decoded = decodeMcpHeaderValue(mcpName);
    if (!decoded.ok) {
      rejectMismatch(res, rpcId, 'Header mismatch: malformed base64 encoding in Mcp-Name.');
      return;
    }
    const bodyName = typeof params?.name === 'string' ? params.name : undefined;
    if (bodyName === undefined || decoded.value !== bodyName) {
      rejectMismatch(
        res,
        rpcId,
        `Header mismatch: Mcp-Name "${decoded.value}" does not match JSON-RPC params.name "${bodyName ?? ''}".`
      );
      return;
    }
  }

  const args =
    params?.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? (params.arguments as Record<string, unknown>)
      : undefined;

  for (const [headerKey, rawVal] of Object.entries(req.headers)) {
    if (!headerKey.startsWith('mcp-param-')) continue;
    const headerVal = firstHeader(rawVal);
    if (headerVal === undefined) continue;

    const decoded = decodeMcpHeaderValue(headerVal);
    if (!decoded.ok) {
      rejectMismatch(res, rpcId, `Header mismatch: malformed base64 encoding in ${headerKey}.`);
      return;
    }

    const suffix = headerKey.slice('mcp-param-'.length).toLowerCase();
    const candidateArgKeys = ROUTABLE_PARAM_HEADER_MAP[suffix] ?? [suffix];

    if (!args) {
      rejectMismatch(
        res,
        rpcId,
        `Header mismatch: ${headerKey} supplied but JSON-RPC params.arguments is missing.`
      );
      return;
    }

    const matchedKey = candidateArgKeys.find((k) => Object.prototype.hasOwnProperty.call(args, k));
    if (!matchedKey) {
      rejectMismatch(
        res,
        rpcId,
        `Header mismatch: ${headerKey} does not correspond to any supplied tool argument.`
      );
      return;
    }

    const bodyArgVal = args[matchedKey];
    const normalizedBodyVal =
      typeof bodyArgVal === 'string' ||
      typeof bodyArgVal === 'number' ||
      typeof bodyArgVal === 'boolean'
        ? String(bodyArgVal)
        : undefined;

    if (normalizedBodyVal === undefined || decoded.value !== normalizedBodyVal) {
      rejectMismatch(
        res,
        rpcId,
        `Header mismatch: ${headerKey} value does not match JSON-RPC argument "${matchedKey}".`
      );
      return;
    }
  }

  next();
};
