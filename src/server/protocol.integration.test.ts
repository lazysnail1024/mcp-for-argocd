import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { test } from 'node:test';
import { connectHttpTransport } from './transport.js';

const INBOUND_TOKEN = 'integration-inbound-secret';
const SHARED_STATE_SECRET = 'shared-multi-replica-mrtr-secret-for-tests';

const freePort = async (): Promise<number> => {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
};

type MockArgoCD = {
  baseUrl: string;
  requests: Array<{ method: string; url: string; body?: string }>;
  close: () => Promise<void>;
};

const startMockArgoCD = async (): Promise<MockArgoCD> => {
  const requests: MockArgoCD['requests'] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const url = req.url ?? '';
      requests.push({ method: req.method ?? 'GET', url, body: body || undefined });
      res.setHeader('Content-Type', 'application/json');

      if (url.startsWith('/api/v1/applications/demo-broken/resource-tree')) {
        res.end(
          JSON.stringify({
            nodes: [
              {
                group: '',
                version: 'v1',
                kind: 'Service',
                namespace: 'demo',
                name: 'svc-ok',
                uid: 'u1',
                health: { status: 'Healthy' }
              },
              {
                group: 'apps',
                version: 'v1',
                kind: 'Deployment',
                namespace: 'demo',
                name: 'web-bad',
                uid: 'u2',
                health: { status: 'Degraded', message: 'ImagePullBackOff' }
              }
            ]
          })
        );
        return;
      }

      if (url.startsWith('/api/v1/applications/demo-broken/events')) {
        res.end(
          JSON.stringify({
            items: [
              {
                type: 'Warning',
                reason: 'Failed',
                message: 'ErrImagePull',
                involvedObject: { kind: 'Pod', namespace: 'demo', name: 'web-bad-0' }
              }
            ]
          })
        );
        return;
      }

      if (url.startsWith('/api/v1/applications/demo-broken/managed-resources')) {
        res.end(
          JSON.stringify({
            items: [
              {
                group: '',
                kind: 'ConfigMap',
                namespace: 'demo',
                name: 'cfg',
                modified: true,
                normalizedLiveState: JSON.stringify({
                  kind: 'ConfigMap',
                  metadata: { name: 'cfg', managedFields: [{ manager: 'kubectl' }] },
                  data: { LOG_LEVEL: 'debug' }
                }),
                targetState: JSON.stringify({
                  kind: 'ConfigMap',
                  metadata: { name: 'cfg' },
                  data: { LOG_LEVEL: 'info' }
                })
              }
            ]
          })
        );
        return;
      }

      if (url.startsWith('/api/v1/applications/demo-broken/resource')) {
        const parsedUrl = new URL(url, 'http://127.0.0.1');
        const kind = parsedUrl.searchParams.get('kind');
        if (kind === 'Secret') {
          res.end(
            JSON.stringify({
              manifest: JSON.stringify({
                apiVersion: 'v1',
                kind: 'Secret',
                metadata: {
                  name: 'app-secret',
                  annotations: { 'argocd.argoproj.io/show-secret-value': 'true' },
                  managedFields: [{ manager: 'argocd' }]
                },
                data: { token: 'c2VjcmV0' }
              })
            })
          );
          return;
        }
        res.end(
          JSON.stringify({
            manifest: JSON.stringify({
              apiVersion: 'v1',
              kind: 'ConfigMap',
              metadata: {
                name: 'cfg',
                managedFields: [{ manager: 'argocd' }],
                annotations: {
                  'kubectl.kubernetes.io/last-applied-configuration': '{"noise":true}'
                }
              },
              data: { LOG_LEVEL: 'info', MAX_TOKENS: '4096' }
            })
          })
        );
        return;
      }

      if (url.startsWith('/api/v1/applications/demo-broken/sync') && req.method === 'POST') {
        res.end(
          JSON.stringify({
            metadata: { name: 'demo-broken', namespace: 'argocd' },
            status: {
              sync: { status: 'Synced' },
              health: { status: 'Healthy' },
              operationState: { phase: 'Running', message: 'sync started' }
            }
          })
        );
        return;
      }

      if (url.startsWith('/api/v1/applications/demo-broken') && req.method === 'DELETE') {
        res.end(JSON.stringify({ metadata: { name: 'demo-broken' } }));
        return;
      }

      if (url.startsWith('/api/v1/applications/demo-broken') && req.method === 'GET') {
        res.end(
          JSON.stringify({
            metadata: { name: 'demo-broken', namespace: 'argocd' },
            spec: { project: 'default', destination: { namespace: 'demo' } },
            status: {
              sync: { status: 'OutOfSync', revision: 'rev1' },
              health: { status: 'Degraded' },
              resources: [
                { group: '', kind: 'Service', namespace: 'demo', name: 'svc-ok', status: 'Synced' },
                {
                  group: 'apps',
                  kind: 'Deployment',
                  namespace: 'demo',
                  name: 'web-bad',
                  status: 'OutOfSync'
                }
              ]
            }
          })
        );
        return;
      }

      if (url.startsWith('/api/v1/applications')) {
        res.end(
          JSON.stringify({
            metadata: { resourceVersion: '1' },
            items: [
              {
                metadata: { name: 'demo-ok', namespace: 'argocd' },
                spec: { project: 'default', destination: { namespace: 'demo' } },
                status: { sync: { status: 'Synced' }, health: { status: 'Healthy' } }
              },
              {
                metadata: { name: 'demo-broken', namespace: 'argocd' },
                spec: { project: 'default', destination: { namespace: 'demo' } },
                status: { sync: { status: 'OutOfSync' }, health: { status: 'Degraded' } }
              }
            ]
          })
        );
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ message: 'not found' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
};

const postMcp = (
  port: number,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; raw: string; json?: unknown }> =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          host: `localhost:${port}`,
          authorization: `Bearer ${INBOUND_TOKEN}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers
        }
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          let json: unknown;
          try {
            json = raw ? JSON.parse(raw) : undefined;
          } catch {
            // SSE or non-JSON response
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, raw, json });
        });
      }
    );
    req.on('error', reject);
    req.end(payload);
  });

const modernMeta = (withElicitation = false) => ({
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': withElicitation ? { elicitation: {} } : {},
  'io.modelcontextprotocol/clientInfo': { name: 'test-modern-client', version: '1.0.0' }
});

test('Tier 2 HTTP Dual-Era integration: 2026-07-28 modern + 2025-11-25 legacy + headerGuard + empty listen close', async () => {
  const mockArgo = await startMockArgoCD();
  const port = await freePort();
  const server = connectHttpTransport({
    port,
    authToken: INBOUND_TOKEN,
    legacyMode: 'stateless'
  });
  await new Promise((resolve) => server.once('listening', resolve));

  const argoHeaders = {
    'x-argocd-base-url': mockArgo.baseUrl,
    'x-argocd-api-token': 'mock-argo-token',
    'x-mcp-caller': 'sre-alice'
  };

  try {
    // 1. Modern 2026-07-28 server/discover
    const discover = await postMcp(
      port,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'server/discover',
        params: { _meta: modernMeta() }
      },
      {
        ...argoHeaders,
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'server/discover'
      }
    );
    assert.equal(discover.status, 200);
    const discoverRes = discover.json as {
      result: {
        resultType: string;
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: string; version: string } };
        instructions: string;
        ttlMs: number;
        cacheScope: string;
        capabilities: { tools?: { listChanged?: boolean } };
      };
    };
    assert.equal(discoverRes.result.resultType, 'complete');
    assert.equal(
      discoverRes.result._meta['io.modelcontextprotocol/serverInfo'].name,
      'argocd-mcp-plus'
    );
    assert.equal(discoverRes.result._meta['io.modelcontextprotocol/serverInfo'].version, '0.9.1');
    assert.equal(discoverRes.result.ttlMs, 3600000);
    assert.equal(discoverRes.result.cacheScope, 'public');
    assert.equal(discoverRes.result.capabilities.tools?.listChanged, false);
    assert.match(discoverRes.result.instructions, /diagnose_application/);

    // 2. Modern 2026-07-28 tools/list: 14 read-only tools in alphabetical order with cache hints
    const listTools = await postMcp(
      port,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: { _meta: modernMeta() }
      },
      {
        ...argoHeaders,
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/list'
      }
    );
    assert.equal(listTools.status, 200);
    const toolsRes = listTools.json as {
      result: {
        resultType: string;
        ttlMs: number;
        cacheScope: string;
        tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>;
      };
    };
    assert.equal(toolsRes.result.tools.length, 14);
    const names = toolsRes.result.tools.map((t) => t.name);
    assert.deepEqual(names, [...names].sort());
    assert.equal(toolsRes.result.ttlMs, 3600000);
    assert.equal(toolsRes.result.cacheScope, 'public');

    // 3. Modern 2026-07-28 subscriptions/listen closes cleanly immediately (no connection leak)
    const listenStart = Date.now();
    const listen = await postMcp(
      port,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'subscriptions/listen',
        params: { notifications: { toolsListChanged: true }, _meta: modernMeta() }
      },
      {
        ...argoHeaders,
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'subscriptions/listen'
      }
    );
    assert.equal(listen.status, 200);
    assert.ok(Date.now() - listenStart < 2000, 'empty subscriptions/listen closed promptly');
    assert.match(listen.raw, /notifications\/subscriptions\/acknowledged/);
    assert.match(listen.raw, /"resultType":"complete"/);

    // 4. Modern 2026-07-28 diagnose_application & diff_application & get_resources
    const diag = await postMcp(
      port,
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'diagnose_application',
          arguments: { applicationName: 'demo-broken' },
          _meta: modernMeta()
        }
      },
      {
        ...argoHeaders,
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'diagnose_application',
        'mcp-param-app-name': 'demo-broken'
      }
    );
    assert.equal(diag.status, 200);
    const diagPayload = JSON.parse(
      (diag.json as { result: { content: Array<{ text: string }> } }).result.content[0].text
    ) as {
      resourceSummary: { healthySyncedNodesOmitted: number; abnormalNodes: number };
      abnormalResources: Array<{ name: string }>;
      warningEvents: Array<{ reason: string }>;
    };
    assert.equal(diagPayload.resourceSummary.healthySyncedNodesOmitted, 1);
    assert.equal(diagPayload.resourceSummary.abnormalNodes, 1);
    assert.equal(diagPayload.abnormalResources[0].name, 'web-bad');
    assert.equal(diagPayload.warningEvents[0].reason, 'Failed');

    const secretRead = await postMcp(
      port,
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'get_resources',
          arguments: {
            applicationName: 'demo-broken',
            applicationNamespace: 'argocd',
            resourceRefs: [
              { group: '', version: 'v1', kind: 'ConfigMap', namespace: 'demo', name: 'cfg' },
              { group: '', version: 'v1', kind: 'Secret', namespace: 'demo', name: 'app-secret' }
            ]
          },
          _meta: modernMeta()
        }
      },
      {
        ...argoHeaders,
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'get_resources',
        'mcp-param-app-name': 'demo-broken'
      }
    );
    const manifests = JSON.parse(
      (secretRead.json as { result: { content: Array<{ text: string }> } }).result.content[0].text
    ) as Array<{ kind: string; metadata: Record<string, unknown>; data: Record<string, string> }>;
    assert.equal(manifests[0].data.MAX_TOKENS, '4096');
    assert.equal('managedFields' in manifests[0].metadata, false);
    assert.equal(manifests[1].data.token, '[REDACTED]');

    // 5. Header-Body desync smuggling is rejected with 400 / -32020 before touching Argo CD
    const beforeCount = mockArgo.requests.length;
    const desync = await postMcp(
      port,
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'get_application',
          arguments: { applicationName: 'demo-broken' },
          _meta: modernMeta()
        }
      },
      {
        ...argoHeaders,
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'list_applications'
      }
    );
    assert.equal(desync.status, 400);
    assert.equal((desync.json as { error: { code: number } }).error.code, -32020);
    assert.equal(mockArgo.requests.length, beforeCount, 'Argo CD was never contacted on desync');

    // 6. Legacy 2025-11-25 stateless flow: pure JSON Accept, no Mcp-Session-Id, stale session header tolerated
    const legacyInit = await postMcp(
      port,
      {
        jsonrpc: '2.0',
        id: 10,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'legacy-ide', version: '1.0.0' }
        }
      },
      { ...argoHeaders, accept: 'application/json' }
    );
    assert.equal(legacyInit.status, 200);
    assert.equal(legacyInit.headers['mcp-session-id'], undefined);
    assert.equal(
      (legacyInit.json as { result: { serverInfo: { name: string } } }).result.serverInfo.name,
      'argocd-mcp-plus'
    );

    const legacyInitialized = await postMcp(
      port,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { ...argoHeaders, accept: 'application/json', 'mcp-session-id': 'stale-id-ignored' }
    );
    assert.equal(legacyInitialized.status, 202);

    const legacyCall = await postMcp(
      port,
      {
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: { name: 'list_applications', arguments: { search: 'broken' } }
      },
      { ...argoHeaders, accept: 'application/json', 'mcp-session-id': 'stale-id-ignored' }
    );
    assert.equal(legacyCall.status, 200);
    const listData = JSON.parse(
      (legacyCall.json as { result: { content: Array<{ text: string }> } }).result.content[0].text
    ) as { items: Array<{ metadata: { name: string } }> };
    assert.deepEqual(
      listData.items.map((a) => a.metadata.name),
      ['demo-broken']
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await mockArgo.close();
  }
});

test('Tier 2 cross-replica MRTR HMAC approval + forced prune=false + legacy delete confirmation guard', async () => {
  const mockArgo = await startMockArgoCD();
  const portA = await freePort();
  const portB = await freePort();

  // Two completely independent HTTP server instances sharing only MCP_REQUEST_STATE_SECRET.
  const podA = connectHttpTransport({
    port: portA,
    authToken: INBOUND_TOKEN,
    toolsets: 'core,diagnostics,ops,admin',
    requestStateSecret: SHARED_STATE_SECRET
  });
  const podB = connectHttpTransport({
    port: portB,
    authToken: INBOUND_TOKEN,
    toolsets: 'core,diagnostics,ops,admin',
    requestStateSecret: SHARED_STATE_SECRET
  });
  await Promise.all([
    new Promise((resolve) => podA.once('listening', resolve)),
    new Promise((resolve) => podB.once('listening', resolve))
  ]);

  const argoHeaders = {
    'x-argocd-base-url': mockArgo.baseUrl,
    'x-argocd-api-token': 'mock-argo-token',
    'x-mcp-caller': 'ops-bob'
  };

  try {
    // Round 1 hits Pod A -> receives input_required + signed requestState
    const round1 = await postMcp(
      portA,
      {
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: {
          name: 'sync_application',
          arguments: { applicationName: 'demo-broken', prune: true },
          _meta: modernMeta(true)
        }
      },
      {
        ...argoHeaders,
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'sync_application',
        'mcp-param-app-name': 'demo-broken'
      }
    );
    assert.equal(round1.status, 200);
    const challenge = round1.json as {
      result: { resultType: string; requestState: string; inputRequests: { confirm: unknown } };
    };
    assert.equal(challenge.result.resultType, 'input_required');
    assert.ok(challenge.result.requestState.startsWith('v1.'));

    // Tampered requestState hitting Pod B -> rejected with -32602
    const tampered = await postMcp(
      portB,
      {
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: {
          name: 'sync_application',
          arguments: { applicationName: 'demo-broken', prune: true },
          requestState: `${challenge.result.requestState.slice(0, -2)}AA`,
          inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
          _meta: modernMeta(true)
        }
      },
      {
        ...argoHeaders,
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'sync_application',
        'mcp-param-app-name': 'demo-broken'
      }
    );
    assert.equal((tampered.json as { error: { code: number } }).error.code, -32602);

    // Round 2 valid requestState hitting Pod B -> succeeds across replicas and forces prune=false
    const round2 = await postMcp(
      portB,
      {
        jsonrpc: '2.0',
        id: 22,
        method: 'tools/call',
        params: {
          name: 'sync_application',
          arguments: { applicationName: 'demo-broken', prune: true },
          requestState: challenge.result.requestState,
          inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
          _meta: modernMeta(true)
        }
      },
      {
        ...argoHeaders,
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'sync_application',
        'mcp-param-app-name': 'demo-broken'
      }
    );
    assert.equal(round2.status, 200);
    const syncBody = JSON.parse(
      (round2.json as { result: { content: Array<{ text: string }> } }).result.content[0].text
    ) as { effectivePrune: boolean; policyNote?: string };
    assert.equal(syncBody.effectivePrune, false);
    assert.match(syncBody.policyNote ?? '', /overridden to prune=false/);

    const syncReq = mockArgo.requests.find((r) => r.url.endsWith('/sync'));
    assert.ok(syncReq);
    assert.equal((JSON.parse(syncReq.body ?? '{}') as { prune: boolean }).prune, false);

    // Legacy 2025 delete_application requires confirmApplicationName match
    const legacyDeleteNoConfirm = await postMcp(
      portA,
      {
        jsonrpc: '2.0',
        id: 23,
        method: 'tools/call',
        params: {
          name: 'delete_application',
          arguments: { applicationName: 'demo-broken' }
        }
      },
      { ...argoHeaders, accept: 'application/json' }
    );
    assert.equal(
      (legacyDeleteNoConfirm.json as { result: { isError: boolean } }).result.isError,
      true
    );

    const legacyDeleteConfirmed = await postMcp(
      portA,
      {
        jsonrpc: '2.0',
        id: 24,
        method: 'tools/call',
        params: {
          name: 'delete_application',
          arguments: { applicationName: 'demo-broken', confirmApplicationName: 'demo-broken' }
        }
      },
      { ...argoHeaders, accept: 'application/json' }
    );
    assert.equal(
      (legacyDeleteConfirmed.json as { result: { isError: boolean } }).result.isError,
      false
    );
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => podA.close(() => resolve())),
      new Promise<void>((resolve) => podB.close(() => resolve()))
    ]);
    await mockArgo.close();
  }
});

test('Tier 2 --legacy-mode=reject refuses 2025-11-25 initialize requests', async () => {
  const port = await freePort();
  const server = connectHttpTransport({
    port,
    authToken: INBOUND_TOKEN,
    legacyMode: 'reject'
  });
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const res = await postMcp(
      port,
      {
        jsonrpc: '2.0',
        id: 30,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'legacy', version: '1.0.0' }
        }
      },
      { 'x-argocd-api-token': 'tok' }
    );
    assert.equal(res.status, 400);
    assert.equal((res.json as { error: { code: number } }).error.code, -32022);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Tier 2 stdio subprocess serves 2025-11-25 legacy and 2026-07-28 modern exchanges', async () => {
  const mockArgo = await startMockArgoCD();
  try {
    const runStdioSession = (messages: unknown[]) =>
      new Promise<string[]>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', './node_modules/tsx/dist/loader.mjs', 'src/index.ts', 'stdio'],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              ARGOCD_BASE_URL: mockArgo.baseUrl,
              ARGOCD_API_TOKEN: 'stdio-token'
            },
            stdio: ['pipe', 'pipe', 'pipe']
          }
        );
        const lines: string[] = [];
        let buf = '';
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`stdio session timed out; collected=${lines.join('\n')}`));
        }, 10000);

        child.stdout.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          const parts = buf.split('\n');
          buf = parts.pop() ?? '';
          for (const part of parts) {
            if (part.trim()) lines.push(part.trim());
          }
          if (
            lines.length >= messages.filter((m) => 'id' in (m as Record<string, unknown>)).length
          ) {
            child.stdin.end();
          }
        });
        child.on('close', () => {
          clearTimeout(timer);
          resolve(lines);
        });
        child.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });

        for (const msg of messages) {
          child.stdin.write(`${JSON.stringify(msg)}\n`);
        }
      });

    // Legacy 2025-11-25 stdio exchange
    const legacyOut = await runStdioSession([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'stdio-legacy', version: '1.0' }
        }
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'list_applications', arguments: { search: 'ok' } }
      }
    ]);
    assert.equal(legacyOut.length, 2);
    const legacyCall = JSON.parse(legacyOut[1]) as {
      result: { content: Array<{ text: string }> };
    };
    assert.match(legacyCall.result.content[0].text, /demo-ok/);

    // Modern 2026-07-28 stdio exchange
    const modernOut = await runStdioSession([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'server/discover',
        params: { _meta: modernMeta() }
      },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'diagnose_application',
          arguments: { applicationName: 'demo-broken' },
          _meta: modernMeta()
        }
      }
    ]);
    assert.equal(modernOut.length, 2);
    const discover = JSON.parse(modernOut[0]) as {
      result: {
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: string; version: string } };
      };
    };
    assert.equal(
      discover.result._meta['io.modelcontextprotocol/serverInfo'].name,
      'argocd-mcp-plus'
    );
    assert.equal(discover.result._meta['io.modelcontextprotocol/serverInfo'].version, '0.9.1');
  } finally {
    await mockArgo.close();
  }
});
