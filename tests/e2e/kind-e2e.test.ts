import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

const BASE_URL = process.env.E2E_BASE_URL;
const AUTH_TOKEN = process.env.E2E_MCP_AUTH_TOKEN;
const ARGOCD_TOKEN = process.env.E2E_ARGOCD_TOKEN ?? '';
const E2E_NS = process.env.E2E_NAMESPACE ?? 'mcp-e2e-system';

assert.ok(BASE_URL, 'E2E_BASE_URL must be set');
assert.ok(AUTH_TOKEN, 'E2E_MCP_AUTH_TOKEN must be set');

const parsedBase = new URL(BASE_URL);

const httpReq = (
  targetUrl: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; raw: string; json?: unknown }> =>
  new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const bodyStr = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const req = http.request(
      {
        hostname: u.hostname,
        port: Number(u.port || 80),
        path: `${u.pathname}${u.search}`,
        method: options.method ?? 'POST',
        agent: false, // Force fresh TCP connection per request so kube-proxy distributes across replicas
        headers: {
          connection: 'close',
          ...(bodyStr !== undefined ? { 'content-type': 'application/json' } : {}),
          ...options.headers
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
            // SSE or text body
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, raw, json });
        });
      }
    );
    req.on('error', reject);
    if (bodyStr !== undefined) req.write(bodyStr);
    req.end();
  });

const modernMeta = (withElicitation = false) => ({
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': withElicitation ? { elicitation: {} } : {},
  'io.modelcontextprotocol/clientInfo': { name: 'kind-e2e-runner', version: '0.9.1' }
});

const callModern = async (
  endpoint: string,
  method: string,
  params: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
  id = 1
) =>
  await httpReq(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${AUTH_TOKEN}`,
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method,
      'x-mcp-caller': 'e2e-auditor',
      ...extraHeaders
    },
    body: {
      jsonrpc: '2.0',
      id,
      method,
      params: { ...params, _meta: modernMeta(extraHeaders['x-e2e-elicit'] === '1') }
    }
  });

const callModernTool = async (
  endpoint: string,
  name: string,
  args: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {},
  extraParams: Record<string, unknown> = {}
) => {
  const paramHeaders: Record<string, string> = {};
  if (typeof args.applicationName === 'string') {
    paramHeaders['mcp-param-app-name'] = args.applicationName;
  }
  if (typeof args.project === 'string') {
    paramHeaders['mcp-param-argo-project'] = args.project;
  } else if (typeof args.projectName === 'string') {
    paramHeaders['mcp-param-argo-project'] = args.projectName;
  }
  if (typeof args.argocdBaseUrl === 'string') {
    paramHeaders['mcp-param-argo-instance'] = args.argocdBaseUrl;
  }

  return await callModern(
    endpoint,
    'tools/call',
    { name, arguments: args, ...extraParams },
    { 'mcp-name': name, ...paramHeaders, ...extraHeaders }
  );
};

const parseToolJson = <T = unknown>(res: { json?: unknown }): { isError: boolean; data: T; rawText: string } => {
  const envelope = res.json as {
    result?: { isError?: boolean; content?: Array<{ text: string }> };
    error?: { code: number; message: string };
  };
  assert.ok(envelope?.result, `expected tool result, got: ${JSON.stringify(res.json)}`);
  const rawText = envelope.result.content?.[0]?.text ?? '';
  let data = rawText as unknown as T;
  if (!envelope.result.isError) {
    try {
      data = JSON.parse(rawText) as T;
    } catch {
      // plain text
    }
  }
  return { isError: Boolean(envelope.result.isError), data, rawText };
};

const kubectl = (...args: string[]): string =>
  execFileSync('kubectl', args, { encoding: 'utf8' }).trim();

const getPodNames = (): string[] => {
  const raw = kubectl('get', 'pods', '-n', E2E_NS, '-l', 'app=argocd-mcp-plus', '-o', 'json');
  const parsed = JSON.parse(raw) as {
    items: Array<{
      metadata: { name: string; deletionTimestamp?: string };
      status?: { phase?: string; containerStatuses?: Array<{ ready?: boolean }> };
    }>;
  };
  return parsed.items
    .filter(
      (p) =>
        !p.metadata.deletionTimestamp &&
        p.status?.phase === 'Running' &&
        (p.status.containerStatuses?.every((c) => c.ready) ?? false)
    )
    .map((p) => p.metadata.name);
};

const freePort = async (): Promise<number> => {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
};

const startPodPortForward = async (
  podName: string
): Promise<{ url: string; close: () => Promise<void> }> => {
  const localPort = await freePort();
  const child = spawn('kubectl', ['port-forward', '-n', E2E_NS, `pod/${podName}`, `${localPort}:3000`], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  for (let i = 0; i < 40; i++) {
    try {
      const h = await httpReq(`http://127.0.0.1:${localPort}/healthz`, { method: 'GET' });
      if (h.status === 200) {
        return {
          url: `http://127.0.0.1:${localPort}/mcp`,
          close: async () => {
            child.kill('SIGTERM');
            await new Promise<void>((resolve) => child.once('exit', () => resolve()));
          }
        };
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  child.kill('SIGKILL');
  throw new Error(`Port-forward to pod/${podName} did not become ready`);
};

const MCP_URL = `${parsedBase.origin}/mcp`;

// =========================================================================
// PHASE A: Default Read-Only Deployment (core,diagnostics enabled; 2 replicas)
// =========================================================================

test('E2E-01: 2-replica pods healthy on /healthz and 30 stateless requests load-balance across both pods', async () => {
  const pods = getPodNames();
  assert.equal(pods.length, 2, `expected 2 replicas, got ${pods.join(', ')}`);

  const health = await httpReq(`${parsedBase.origin}/healthz`, { method: 'GET' });
  assert.equal(health.status, 200);
  const hJson = health.json as { status: string; name: string; version: string };
  assert.equal(hJson.status, 'ok');
  assert.equal(hJson.name, 'argocd-mcp-plus');
  assert.equal(hJson.version, '0.9.1');

  for (let i = 0; i < 30; i++) {
    const res = await callModernTool(MCP_URL, 'list_clusters', {}, { 'x-mcp-caller': `lb-check-${i}` });
    assert.equal(res.status, 200);
    assert.equal(res.headers['mcp-session-id'], undefined);
    const { isError } = parseToolJson(res);
    assert.equal(isError, false);
  }

  let podsWithTraffic = 0;
  for (const pod of pods) {
    const logs = kubectl('logs', '-n', E2E_NS, pod);
    if (logs.includes('"tool":"list_clusters"')) {
      podsWithTraffic += 1;
    }
  }
  assert.equal(podsWithTraffic, 2, 'expected kube-proxy Service to distribute traffic to BOTH replicas');
});

test('E2E-02: Dual-Era protocol compatibility (2026-07-28 + 2025-11-25 + stdio + /sse removed)', async () => {
  // 2026-07-28 server/discover + cache hints + instructions
  const discover = await callModern(MCP_URL, 'server/discover', {});
  assert.equal(discover.status, 200);
  const d = (
    discover.json as {
      result: {
        resultType: string;
        ttlMs: number;
        cacheScope: string;
        instructions: string;
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: string; version: string } };
      };
    }
  ).result;
  assert.equal(d.resultType, 'complete');
  assert.equal(d._meta['io.modelcontextprotocol/serverInfo'].name, 'argocd-mcp-plus');
  assert.equal(d._meta['io.modelcontextprotocol/serverInfo'].version, '0.9.1');
  assert.equal(d.ttlMs, 3600000);
  assert.equal(d.cacheScope, 'public');
  assert.match(d.instructions, /diagnose_application/);

  // 2026-07-28 empty subscriptions/listen closes cleanly within 2s
  const t0 = Date.now();
  const listen = await callModern(MCP_URL, 'subscriptions/listen', {
    notifications: { toolsListChanged: true }
  });
  assert.equal(listen.status, 200);
  assert.ok(Date.now() - t0 < 2000, 'subscriptions/listen closed immediately');
  assert.match(listen.raw, /"resultType":"complete"/);

  // 2025-11-25 legacy stateless handshake + notifications/initialized + GET 405 + stale session header
  const legacyInit = await httpReq(MCP_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${AUTH_TOKEN}`, accept: 'application/json' },
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'legacy-e2e', version: '1.0' }
      }
    }
  });
  assert.equal(legacyInit.status, 200);
  assert.equal(legacyInit.headers['mcp-session-id'], undefined);

  const legacyNotify = await httpReq(MCP_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${AUTH_TOKEN}`,
      accept: 'application/json',
      'mcp-session-id': 'stale-legacy-session-id'
    },
    body: { jsonrpc: '2.0', method: 'notifications/initialized' }
  });
  assert.equal(legacyNotify.status, 202);

  const legacyGet = await httpReq(MCP_URL, {
    method: 'GET',
    headers: { authorization: `Bearer ${AUTH_TOKEN}` }
  });
  assert.equal(legacyGet.status, 405);
  assert.equal(legacyGet.headers.allow, 'POST');

  const legacyDelete = await httpReq(MCP_URL, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${AUTH_TOKEN}` }
  });
  assert.equal(legacyDelete.status, 405);
  assert.equal(legacyDelete.headers.allow, 'POST');

  const legacyCall = await httpReq(MCP_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${AUTH_TOKEN}`,
      accept: 'application/json',
      'mcp-session-id': 'stale-legacy-session-id'
    },
    body: {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'list_projects', arguments: {} }
    }
  });
  assert.equal(legacyCall.status, 200);
  assert.equal(parseToolJson(legacyCall).isError, false);

  // Verify /sse is removed (404)
  const sseRes = await httpReq(`${parsedBase.origin}/sse`, {
    method: 'GET',
    headers: { authorization: `Bearer ${AUTH_TOKEN}` }
  });
  assert.equal(sseRes.status, 404);

  // Verify stdio inside live container
  const [pod] = getPodNames();
  const stdioOut = execFileSync(
    'kubectl',
    ['exec', '-i', '-n', E2E_NS, pod, '--', 'node', 'dist/index.js', 'stdio'],
    {
      input:
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'server/discover',
          params: { _meta: modernMeta() }
        }) + '\n',
      encoding: 'utf8'
    }
  );
  assert.match(stdioOut, /argocd-mcp-plus/);
});

test('E2E-03: Default core,diagnostics exposes exactly 14 read-only tools and rejects writes with -32602', async () => {
  const listRes = await callModern(MCP_URL, 'tools/list', {});
  assert.equal(listRes.status, 200);
  const listResult = (
    listRes.json as {
      result: {
        ttlMs?: number;
        cacheScope?: string;
        tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>;
      };
    }
  ).result;
  assert.equal(listResult.ttlMs, 3600000);
  assert.equal(listResult.cacheScope, 'public');
  const tools = listResult.tools;
  assert.equal(tools.length, 14);
  const names = tools.map((t) => t.name);
  assert.deepEqual(names, [...names].sort());
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, true, `${t.name} must be readOnlyHint=true`);
  }

  for (const forbidden of ['sync_application', 'delete_application', 'create_application']) {
    const res = await callModernTool(MCP_URL, forbidden, { applicationName: 'e2e-broken-app' });
    const errCode = (res.json as { error?: { code: number } }).error?.code;
    assert.equal(errCode, -32602, `calling disabled tool ${forbidden} should return -32602`);
  }
});

test('E2E-04: Cluster, Project, and multi-dimensional list_applications local search/filtering on real Argo CD', async () => {
  const clusters = parseToolJson<{ items: unknown[] }>(await callModernTool(MCP_URL, 'list_clusters'));
  assert.equal(clusters.isError, false);
  assert.ok(clusters.data.items.length >= 1);

  const projects = parseToolJson<{ items: Array<{ name: string }> }>(
    await callModernTool(MCP_URL, 'list_projects')
  );
  assert.equal(projects.isError, false);
  assert.ok(projects.data.items.some((p) => p.name === 'mcp-e2e-project'));

  const projDetail = parseToolJson<{ metadata: { name: string } }>(
    await callModernTool(MCP_URL, 'get_appproject', { projectName: 'mcp-e2e-project' })
  );
  assert.equal(projDetail.isError, false);
  assert.equal(projDetail.data.metadata.name, 'mcp-e2e-project');

  const appDetail = parseToolJson<{ metadata: { name: string }; status?: { sync?: { status?: string } } }>(
    await callModernTool(MCP_URL, 'get_application', {
      applicationName: 'e2e-healthy-app',
      refresh: 'normal'
    })
  );
  assert.equal(appDetail.isError, false);
  assert.equal(appDetail.data.metadata.name, 'e2e-healthy-app');
  assert.equal(appDetail.data.status?.sync?.status, 'Synced');

  const brokenSearch = parseToolJson<{ items: Array<{ metadata: { name: string } }> }>(
    await callModernTool(MCP_URL, 'list_applications', {
      search: 'BROKEN',
      project: 'mcp-e2e-project',
      healthStatus: 'Degraded',
      syncStatus: 'OutOfSync'
    })
  );
  assert.equal(brokenSearch.isError, false);
  assert.deepEqual(
    brokenSearch.data.items.map((a) => a.metadata.name),
    ['e2e-broken-app']
  );

  // Also test host-bound Token Registry override using the registered alias URL
  const aliasCall = parseToolJson<{ items: Array<{ metadata: { name: string } }> }>(
    await callModernTool(MCP_URL, 'list_applications', {
      search: 'healthy',
      argocdBaseUrl: 'https://argocd-server.argocd.svc'
    })
  );
  assert.equal(aliasCall.isError, false);
  assert.deepEqual(
    aliasCall.data.items.map((a) => a.metadata.name),
    ['e2e-healthy-app']
  );
});

test('E2E-05: diagnose_application strips healthy Service & surfaces abnormal workloads; diff_application isolates ConfigMap drift', async () => {
  const diag = parseToolJson<{
    resourceSummary: { totalNodes: number; healthySyncedNodesOmitted: number; abnormalNodes: number };
    abnormalResources: Array<{ kind: string; name: string; healthStatus?: string; syncStatus?: string }>;
    warningEvents: Array<{ reason?: string; message?: string }>;
  }>(await callModernTool(MCP_URL, 'diagnose_application', { applicationName: 'e2e-broken-app' }));

  assert.equal(diag.isError, false);
  assert.ok(diag.data.resourceSummary.healthySyncedNodesOmitted >= 1, 'healthy nodes stripped');
  assert.equal(
    diag.data.abnormalResources.some((r) => r.name === 'broken-ok-svc'),
    false,
    'healthy Service must be omitted from abnormalResources'
  );
  assert.ok(
    diag.data.abnormalResources.some((r) => r.name === 'broken-bad-image'),
    'failing deployment must appear in abnormalResources'
  );
  assert.ok(
    diag.data.abnormalResources.some((r) => r.name === 'broken-drift-cm'),
    'drifted ConfigMap must appear in abnormalResources'
  );
  assert.ok(diag.data.warningEvents.length >= 1, 'real Kubernetes Warning events must be surfaced');

  const diff = parseToolJson<{
    outOfSyncResources: number;
    diffs: Array<{ kind: string; name: string; changes: Array<{ path: string; live?: unknown; target?: unknown }> }>;
  }>(await callModernTool(MCP_URL, 'diff_application', { applicationName: 'e2e-broken-app' }));
  assert.equal(diff.isError, false);
  assert.ok(diff.data.outOfSyncResources >= 1);
  const cmDiff = diff.data.diffs.find((d) => d.kind === 'ConfigMap' && d.name === 'broken-drift-cm');
  assert.ok(cmDiff, 'expected broken-drift-cm in diff_application output');
  assert.ok(
    cmDiff.changes.some((c) => c.path === 'data.mode' && c.live === 'manual-hotfix' && c.target === 'git-desired'),
    `expected data.mode diff, got: ${JSON.stringify(cmDiff.changes)}`
  );
  assert.equal(diff.rawText.includes('managedFields'), false);
});

test('E2E-06: diagnostics toolset (resource tree summary vs detailed, optional-container logs + grep, events, actions)', async () => {
  const summaryRes = await callModernTool(MCP_URL, 'get_application_resource_tree', {
    applicationName: 'e2e-broken-app',
    detailLevel: 'summary'
  });
  const detailedRes = await callModernTool(MCP_URL, 'get_application_resource_tree', {
    applicationName: 'e2e-broken-app',
    detailLevel: 'detailed'
  });
  const summary = parseToolJson<{ totalNodes: number; byKind: Record<string, Record<string, number>> }>(summaryRes);
  const detailed = parseToolJson<{ nodes: Array<{ kind: string; name: string; uid: string; namespace: string }> }>(
    detailedRes
  );
  assert.equal(summary.isError, false);
  assert.equal(detailed.isError, false);
  assert.ok(summary.rawText.length < detailed.rawText.length, 'summary tree must be smaller than detailed tree');

  // Optional container + server-side grep on single-container Deployment broken-logger
  const logsRes = parseToolJson<{ entries: Array<{ content?: string }>; returnedLines: number }>(
    await callModernTool(MCP_URL, 'get_application_workload_logs', {
      applicationName: 'e2e-broken-app',
      applicationNamespace: 'argocd',
      resourceRef: {
        group: 'apps',
        version: 'v1',
        kind: 'Deployment',
        namespace: 'mcp-e2e-broken',
        name: 'broken-logger'
      },
      tailLines: 50,
      grep: 'e2e-sentinel-fault'
    })
  );
  assert.equal(logsRes.isError, false);
  assert.ok(logsRes.data.returnedLines >= 1, 'expected matching sentinel log line');
  assert.ok(
    logsRes.data.entries.every((e) => (e.content ?? '').includes('e2e-sentinel-fault')),
    'grep filter must exclude non-matching lines'
  );

  // Events & resource actions
  const appEvents = parseToolJson<{ items: unknown[] }>(
    await callModernTool(MCP_URL, 'get_application_events', { applicationName: 'e2e-broken-app' })
  );
  assert.equal(appEvents.isError, false);

  const loggerNode = detailed.data.nodes.find((n) => n.kind === 'Deployment' && n.name === 'broken-logger');
  assert.ok(loggerNode);
  const resEvents = parseToolJson(
    await callModernTool(MCP_URL, 'get_resource_events', {
      applicationName: 'e2e-broken-app',
      applicationNamespace: 'argocd',
      resourceUID: loggerNode.uid,
      resourceNamespace: loggerNode.namespace,
      resourceName: loggerNode.name
    })
  );
  assert.equal(resEvents.isError, false);

  const actions = parseToolJson<{ actions: Array<{ name: string }> }>(
    await callModernTool(MCP_URL, 'get_resource_actions', {
      applicationName: 'e2e-broken-app',
      applicationNamespace: 'argocd',
      resourceRef: {
        group: 'apps',
        version: 'v1',
        kind: 'Deployment',
        namespace: 'mcp-e2e-broken',
        name: 'broken-logger'
      }
    })
  );
  assert.equal(actions.isError, false);
  assert.ok(actions.data.actions.some((a) => a.name === 'restart'));

  const managed = parseToolJson<{ items: Array<{ kind: string; name: string }> }>(
    await callModernTool(MCP_URL, 'get_application_managed_resources', {
      applicationName: 'e2e-broken-app'
    })
  );
  assert.equal(managed.isError, false);
  assert.ok(managed.data.items.length >= 4);
  assert.equal(managed.rawText.includes('managedFields'), false);
});

test('E2E-07: Noise stripping, ConfigMap preservation, show-secret-value Secret fallback redaction, and 64KB breaker', async () => {
  const cmRes = parseToolJson<
    Array<{ kind: string; metadata: Record<string, unknown>; data: Record<string, string> }>
  >(
    await callModernTool(MCP_URL, 'get_resources', {
      applicationName: 'e2e-healthy-app',
      applicationNamespace: 'argocd',
      resourceRefs: [
        { group: '', version: 'v1', kind: 'ConfigMap', namespace: 'mcp-e2e-ok', name: 'healthy-config' }
      ]
    })
  );
  assert.equal(cmRes.isError, false);
  assert.equal(cmRes.data[0].data.MAX_TOKENS, '4096');
  assert.equal(cmRes.data[0].data.LOG_LEVEL, 'info');
  assert.equal('managedFields' in cmRes.data[0].metadata, false);
  assert.equal(cmRes.rawText.includes('last-applied-configuration'), false);

  // Standard Secret + show-secret-value: "true" Secret both have data masked by Argo CD + MCP fallback!
  const secRes = parseToolJson<Array<{ kind: string; metadata?: { name?: string }; data?: Record<string, string> }>>(
    await callModernTool(MCP_URL, 'get_resources', {
      applicationName: 'e2e-broken-app',
      applicationNamespace: 'argocd',
      resourceRefs: [
        {
          group: '',
          version: 'v1',
          kind: 'Secret',
          namespace: 'mcp-e2e-broken',
          name: 'broken-std-secret'
        },
        {
          group: '',
          version: 'v1',
          kind: 'Secret',
          namespace: 'mcp-e2e-broken',
          name: 'broken-exposed-secret'
        }
      ]
    })
  );
  assert.equal(secRes.isError, false);
  const exposedSecret = secRes.data.find((r) => r.metadata?.name === 'broken-exposed-secret');
  assert.ok(exposedSecret, 'expected broken-exposed-secret in response');
  assert.equal(exposedSecret.data?.api_key, '[REDACTED]');
  assert.equal(secRes.rawText.includes('exposed-secret-must-be-redacted-by-mcp'), false);
  assert.equal(secRes.rawText.includes('standard-secret-value'), false);

  // Real default 64KB (65536 bytes) response byte breaker on healthy-large-cm (~75KB)
  const oversized = parseToolJson(
    await callModernTool(MCP_URL, 'get_resources', {
      applicationName: 'e2e-healthy-app',
      applicationNamespace: 'argocd',
      resourceRefs: [
        { group: '', version: 'v1', kind: 'ConfigMap', namespace: 'mcp-e2e-ok', name: 'healthy-large-cm' }
      ]
    })
  );
  assert.equal(oversized.isError, true);
  assert.match(oversized.rawText, /exceeded the 65536-byte limit/);
  assert.match(oversized.rawText, /narrow filters/);
});

test('E2E-08: Security redlines (401 auth, 403 origin, 400/-32020 desync, path traversal, SSRF, ScopeFence)', async () => {
  // Missing / wrong bearer token -> 401
  const noAuth = await httpReq(MCP_URL, {
    method: 'POST',
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
  });
  assert.equal(noAuth.status, 401);

  // Cross-origin -> 403
  const badOrigin = await httpReq(MCP_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${AUTH_TOKEN}`, origin: 'https://evil.example' },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
  });
  assert.equal(badOrigin.status, 403);

  // Protocol Desync (Mcp-Name mismatch) -> 400 / -32020
  const desync = await callModern(
    MCP_URL,
    'tools/call',
    { name: 'get_application', arguments: { applicationName: 'e2e-healthy-app' } },
    { 'mcp-name': 'list_applications' }
  );
  assert.equal(desync.status, 400);
  assert.equal((desync.json as { error: { code: number } }).error.code, -32020);

  // Path traversal blocked before HTTP dispatch
  const traversal = parseToolJson(
    await callModernTool(MCP_URL, 'get_application', {
      applicationName: '../clusters/in-cluster'
    })
  );
  assert.equal(traversal.isError, true);
  assert.match(traversal.rawText, /Invalid parameter "applicationName"/);

  // Unregistered argocdBaseUrl blocked without leaking default token
  const ssrf = parseToolJson(
    await callModernTool(MCP_URL, 'list_applications', {
      argocdBaseUrl: 'https://evil.example.com'
    })
  );
  assert.equal(ssrf.isError, true);
  assert.match(ssrf.rawText, /Missing required ArgoCD API token/);

  // ScopeFence MCP_DENIED_NAMESPACES=mcp-e2e-denied blocks e2e-denied-app
  const deniedGet = parseToolJson(
    await callModernTool(MCP_URL, 'get_application', { applicationName: 'e2e-denied-app' })
  );
  assert.equal(deniedGet.isError, true);
  assert.match(deniedGet.rawText, /MCP_DENIED_NAMESPACES/);

  const listAll = parseToolJson<{ items: Array<{ metadata: { name: string } }> }>(
    await callModernTool(MCP_URL, 'list_applications', { project: 'mcp-e2e-project' })
  );
  assert.equal(listAll.isError, false);
  assert.equal(
    listAll.data.items.some((a) => a.metadata.name === 'e2e-denied-app'),
    false,
    'denied-namespace app must be filtered out of list_applications'
  );
});

// =========================================================================
// PHASE B: Enable ops,admin + Test Cross-Pod MRTR, Forced prune=false, CRUD & Audit Logs
// =========================================================================

test('E2E-09 & E2E-10: Cross-replica MRTR HMAC sync (forced prune=false, partial sync), legacy CRUD lifecycle & clean audit logs', async () => {
  let pfA: { url: string; close: () => Promise<void> } | undefined;
  let pfB: { url: string; close: () => Promise<void> } | undefined;

  try {
    // Roll out Deployment with ops,admin enabled
    kubectl(
      'set',
      'env',
      '-n',
      E2E_NS,
      'deployment/argocd-mcp-plus',
      'MCP_TOOLSETS=core,diagnostics,ops,admin'
    );
    kubectl('rollout', 'status', '-n', E2E_NS, 'deployment/argocd-mcp-plus', '--timeout=120s');

    const pods = getPodNames();
    assert.equal(pods.length, 2);
    pfA = await startPodPortForward(pods[0]);
    pfB = await startPodPortForward(pods[1]);
    // E2E-09: Round 1 hits Pod A -> receives input_required + signed requestState
    const partialSyncArgs = {
      applicationName: 'e2e-broken-app',
      prune: true,
      resources: [
        { group: '', kind: 'ConfigMap', namespace: 'mcp-e2e-broken', name: 'broken-drift-cm' }
      ]
    };

    const r1 = await callModernTool(pfA.url, 'sync_application', partialSyncArgs, {
      'x-e2e-elicit': '1'
    });
    assert.equal(r1.status, 200);
    const challenge = (
      r1.json as { result: { resultType: string; requestState: string; inputRequests: { confirm: unknown } } }
    ).result;
    assert.equal(challenge.resultType, 'input_required');
    assert.ok(challenge.requestState.startsWith('v1.'));

    // Tampered requestState hitting Pod B -> rejected with -32602
    const tampered = await callModernTool(
      pfB.url,
      'sync_application',
      partialSyncArgs,
      { 'x-e2e-elicit': '1' },
      {
        requestState: `${challenge.requestState.slice(0, -2)}ZZ`,
        inputResponses: { confirm: { action: 'accept', content: { confirm: true } } }
      }
    );
    assert.equal((tampered.json as { error?: { code: number } }).error?.code, -32602);

    // Round 2 valid requestState hitting Pod B -> cross-pod HMAC verification passes & forces prune=false!
    const r2 = await callModernTool(
      pfB.url,
      'sync_application',
      partialSyncArgs,
      { 'x-e2e-elicit': '1' },
      {
        requestState: challenge.requestState,
        inputResponses: { confirm: { action: 'accept', content: { confirm: true } } }
      }
    );
    assert.equal(r2.status, 200);
    const syncOut = parseToolJson<{ effectivePrune: boolean; policyNote?: string }>(r2);
    assert.equal(syncOut.isError, false);
    assert.equal(syncOut.data.effectivePrune, false);
    assert.match(syncOut.data.policyNote ?? '', /prune=false/);

    // Verify real Argo CD reconciled broken-drift-cm back to git-desired AND preserved unmanaged e2e-orphan-cm!
    let reconciled = false;
    for (let i = 0; i < 30; i++) {
      const mode = kubectl(
        'get',
        'configmap',
        'broken-drift-cm',
        '-n',
        'mcp-e2e-broken',
        '-o',
        'jsonpath={.data.mode}'
      );
      if (mode === 'git-desired') {
        reconciled = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.equal(reconciled, true, 'broken-drift-cm must be synced back to git-desired');
    const orphanKeep = kubectl(
      'get',
      'configmap',
      'e2e-orphan-cm',
      '-n',
      'mcp-e2e-broken',
      '-o',
      'jsonpath={.data.keep}'
    );
    assert.equal(orphanKeep, 'yes', 'unmanaged orphan ConfigMap must NOT be pruned');

    // Also verify run_resource_action allowlist enforcement (MCP_ALLOWED_RESOURCE_ACTIONS=restart)
    const blockedAction = parseToolJson(
      await callModernTool(pfA.url, 'run_resource_action', {
        applicationName: 'e2e-broken-app',
        applicationNamespace: 'argocd',
        resourceRef: {
          group: 'apps',
          version: 'v1',
          kind: 'Deployment',
          namespace: 'mcp-e2e-broken',
          name: 'broken-logger'
        },
        action: 'forbidden-action'
      })
    );
    assert.equal(blockedAction.isError, true);
    assert.match(blockedAction.rawText, /MCP_ALLOWED_RESOURCE_ACTIONS/);

    // E2E-10: Legacy 2025 client full create -> update -> delete lifecycle with confirmApplicationName guard
    const legacyPost = (name: string, args: Record<string, unknown>) =>
      httpReq(MCP_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${AUTH_TOKEN}`,
          accept: 'application/json',
          'x-mcp-caller': 'legacy-operator'
        },
        body: { jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name, arguments: args } }
      });

    const tempAppSpec = {
      metadata: { name: 'e2e-temp-app', namespace: 'argocd' },
      spec: {
        project: 'mcp-e2e-project',
        source: {
          repoURL: 'git://e2e-git-repo.mcp-e2e-system.svc.cluster.local:9418/e2e-repo.git',
          path: 'apps/healthy',
          targetRevision: 'main'
        },
        destination: {
          server: 'https://kubernetes.default.svc',
          namespace: 'mcp-e2e-temp'
        }
      }
    };

    const created = parseToolJson(await legacyPost('create_application', { application: tempAppSpec }));
    assert.equal(created.isError, false, `create_application failed: ${created.rawText}`);

    const updatedSpec = {
      ...tempAppSpec,
      metadata: {
        ...tempAppSpec.metadata,
        annotations: { 'e2e.argocd-mcp-plus/updated': 'true' }
      }
    };
    const updated = parseToolJson<{ metadata?: { annotations?: Record<string, string> } }>(
      await legacyPost('update_application', {
        applicationName: 'e2e-temp-app',
        application: updatedSpec
      })
    );
    assert.equal(updated.isError, false, `update_application failed: ${updated.rawText}`);
    assert.equal(updated.data.metadata?.annotations?.['e2e.argocd-mcp-plus/updated'], 'true');

    // Delete without confirmApplicationName -> rejected!
    const delRejected = parseToolJson(
      await legacyPost('delete_application', { applicationName: 'e2e-temp-app', cascade: false })
    );
    assert.equal(delRejected.isError, true);
    assert.match(delRejected.rawText, /confirmApplicationName/);

    // Delete with matching confirmApplicationName -> succeeds!
    const delOk = parseToolJson(
      await legacyPost('delete_application', {
        applicationName: 'e2e-temp-app',
        cascade: false,
        confirmApplicationName: 'e2e-temp-app'
      })
    );
    assert.equal(delOk.isError, false, `delete_application failed: ${delOk.rawText}`);

    // Verify structured JSON audit logs on stderr across both pods and ZERO plaintext token leakage
    let combinedLogs = '';
    for (const pod of pods) {
      combinedLogs += '\n' + kubectl('logs', '-n', E2E_NS, pod);
    }
    assert.match(combinedLogs, /"event":"mcp_tool_call"/);
    assert.match(combinedLogs, /"durationMs":\d+/);
    assert.match(combinedLogs, /"caller":"e2e-auditor"/);
    assert.match(combinedLogs, /"caller":"legacy-operator"/);
    assert.equal(combinedLogs.includes(AUTH_TOKEN), false, 'inbound MCP_AUTH_TOKEN must never appear in logs');
    if (ARGOCD_TOKEN) {
      assert.equal(
        combinedLogs.includes(ARGOCD_TOKEN),
        false,
        'outbound ARGOCD_API_TOKEN must never appear in logs'
      );
    }
  } finally {
    await pfA?.close();
    await pfB?.close();
    // Restore default read-only deployment posture after Phase B verification
    kubectl('set', 'env', '-n', E2E_NS, 'deployment/argocd-mcp-plus', 'MCP_TOOLSETS-');
    kubectl('rollout', 'status', '-n', E2E_NS, 'deployment/argocd-mcp-plus', '--timeout=120s');
  }
});
