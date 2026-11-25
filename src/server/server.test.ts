import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ArgoCDClientResolver, createServer } from './server.js';
import { TokenRegistry } from './tokenRegistry.js';
import {
  ALL_DEFINITIONS,
  resolveEnabledToolsets,
  resolveSelectedTools
} from '../toolsets/index.js';
import { assertNoReservedParamNames } from '../shared/models/schema.js';

const DEFAULT_BASE_URL = 'https://argocd.internal.example.com';
const DEFAULT_TOKEN = 'default-secret-token';
const EVIL_BASE_URL = 'https://evil.example.com';
const OTHER_BASE_URL = 'https://argocd.other.example.com';

const callTool = async (
  server: ReturnType<typeof createServer>,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ isError?: boolean; content: { text: string }[] }> => {
  const registered = (
    server as unknown as {
      _registeredTools: Record<string, { handler: (...a: unknown[]) => Promise<unknown> }>;
    }
  )._registeredTools;
  const tool = registered[toolName];
  assert.ok(tool, `tool "${toolName}" is registered`);
  return (await tool.handler(args, { mcpReq: { method: 'tools/call' } })) as {
    isError?: boolean;
    content: { text: string }[];
  };
};

const textOf = (result: { content: { text: string }[] }): string =>
  result.content.map((c) => c.text).join('\n');

test('overridden base URL with no registry entry does NOT receive the default token', async () => {
  const server = createServer({
    argocdBaseUrl: DEFAULT_BASE_URL,
    argocdApiToken: DEFAULT_TOKEN,
    tokenRegistry: new TokenRegistry()
  });

  const result = await callTool(server, 'list_applications', { argocdBaseUrl: EVIL_BASE_URL });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Missing required ArgoCD API token/);
  assert.match(textOf(result), new RegExp(EVIL_BASE_URL));
});

test('overridden base URL with a registry entry uses the registry token, not the default', () => {
  const registry = new TokenRegistry([{ baseUrl: EVIL_BASE_URL, token: 'registered-token' }]);
  const resolver = new ArgoCDClientResolver(DEFAULT_BASE_URL, DEFAULT_TOKEN, registry);

  const { client } = resolver.resolve({ argocdBaseUrl: EVIL_BASE_URL }) as unknown as {
    client: { client: { apiToken: string } };
  };
  assert.equal(client.client.apiToken, 'registered-token');
  assert.notEqual(client.client.apiToken, DEFAULT_TOKEN);
});

test('default base URL uses the default token', () => {
  const resolver = new ArgoCDClientResolver(DEFAULT_BASE_URL, DEFAULT_TOKEN, new TokenRegistry());
  const { client } = resolver.resolve({ argocdBaseUrl: DEFAULT_BASE_URL }) as unknown as {
    client: { client: { apiToken: string } };
  };
  assert.equal(client.client.apiToken, DEFAULT_TOKEN);
});

test('default base URL match is normalized (trailing slash / case)', () => {
  const resolver = new ArgoCDClientResolver(DEFAULT_BASE_URL, DEFAULT_TOKEN, new TokenRegistry());
  const { client } = resolver.resolve({
    argocdBaseUrl: `${DEFAULT_BASE_URL.toUpperCase()}/`
  }) as unknown as { client: { client: { apiToken: string } } };
  assert.equal(client.client.apiToken, DEFAULT_TOKEN);
});

test('overriding argocdBaseUrl to the default instance reuses the session token (registry present)', () => {
  const registry = new TokenRegistry([{ baseUrl: OTHER_BASE_URL, token: 'registered-token' }]);
  const resolver = new ArgoCDClientResolver(DEFAULT_BASE_URL, DEFAULT_TOKEN, registry);
  const { client } = resolver.resolve({
    argocdBaseUrl: `${DEFAULT_BASE_URL.toUpperCase()}/`
  }) as unknown as { client: { client: { apiToken: string } } };
  assert.equal(client.client.apiToken, DEFAULT_TOKEN);
});

test('overriding argocdBaseUrl to a different instance with no registry entry sends no request', async () => {
  const registry = new TokenRegistry([{ baseUrl: DEFAULT_BASE_URL, token: 'registered-default' }]);
  const server = createServer({
    argocdBaseUrl: DEFAULT_BASE_URL,
    argocdApiToken: DEFAULT_TOKEN,
    tokenRegistry: registry
  });

  const result = await callTool(server, 'list_applications', { argocdBaseUrl: EVIL_BASE_URL });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Missing required ArgoCD API token/);
  assert.match(textOf(result), new RegExp(EVIL_BASE_URL));
});

test('with no default token, an overridden URL still resolves only from the registry', async () => {
  const registry = new TokenRegistry([{ baseUrl: DEFAULT_BASE_URL, token: 'registered-default' }]);
  const server = createServer({
    argocdBaseUrl: '',
    argocdApiToken: '',
    tokenRegistry: registry
  });

  const result = await callTool(server, 'list_applications', { argocdBaseUrl: EVIL_BASE_URL });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Missing required ArgoCD API token/);
});

test('default toolsets enable core and diagnostics (14 read-only tools) and hide ops/admin', () => {
  const enabled = resolveEnabledToolsets({}, {});
  assert.deepEqual([...enabled].sort(), ['core', 'diagnostics']);

  const tools = resolveSelectedTools({}, {});
  assert.equal(tools.length, 14);
  for (const tool of tools) {
    assert.equal(tool.annotations.readOnlyHint, true, `${tool.name} is read-only`);
  }
  assert.equal(
    tools.some((t) => t.name === 'sync_application'),
    false
  );
  assert.equal(
    tools.some((t) => t.name === 'delete_application'),
    false
  );
});

test('MCP_READ_ONLY=true always strips ops and admin even when toolsets=all', () => {
  const enabled = resolveEnabledToolsets({ toolsets: 'all' }, { MCP_READ_ONLY: 'true' });
  assert.deepEqual([...enabled].sort(), ['core', 'diagnostics']);
});

test('no registered tool uses reserved 2026-07-28 MRTR parameter names', () => {
  assert.equal(ALL_DEFINITIONS.length, 19);
  for (const def of ALL_DEFINITIONS) {
    assert.doesNotThrow(() => assertNoReservedParamNames(def.name, def.inputShape));
  }
});
