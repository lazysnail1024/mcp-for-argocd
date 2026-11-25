import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { ArgoCDClient } from './client.js';
import { ArgoCDApiError, translateErrorForAgent } from './errors.js';

const startStubArgoCD = async (
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<{ baseUrl: string; close: () => Promise<void> }> => {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/argocd`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
};

test('ArgoCDClient preserves subpath, filters listApplications in memory, and forwards traceparent', async () => {
  const seenPaths: string[] = [];
  const seenTraceparents: Array<string | undefined> = [];

  const stub = await startStubArgoCD((req, res) => {
    seenPaths.push(req.url ?? '');
    seenTraceparents.push(req.headers['traceparent'] as string | undefined);
    res.setHeader('Content-Type', 'application/json');

    if (req.url?.startsWith('/argocd/api/v1/applications')) {
      res.end(
        JSON.stringify({
          metadata: { resourceVersion: '42' },
          items: [
            {
              metadata: { name: 'payments-prod', namespace: 'argocd' },
              spec: { project: 'core' },
              status: { health: { status: 'Healthy' }, sync: { status: 'Synced' } }
            },
            {
              metadata: { name: 'orders-broken', namespace: 'argocd' },
              spec: { project: 'core' },
              status: { health: { status: 'Degraded' }, sync: { status: 'OutOfSync' } }
            },
            {
              metadata: { name: 'analytics-broken', namespace: 'argocd' },
              spec: { project: 'data' },
              status: { health: { status: 'Degraded' }, sync: { status: 'OutOfSync' } }
            }
          ]
        })
      );
      return;
    }

    if (req.url === '/argocd/api/v1/projects') {
      res.end(
        JSON.stringify({
          items: [
            {
              metadata: { name: 'core', namespace: 'argocd' },
              spec: { description: 'Core services', sourceRepos: ['*'], destinations: [] }
            }
          ]
        })
      );
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ code: 5, message: 'not found' }));
  });

  try {
    const client = new ArgoCDClient(stub.baseUrl, 'test-token');
    const result = await client.listApplications(
      { search: 'BROKEN', project: 'core', healthStatus: 'Degraded', syncStatus: 'OutOfSync' },
      { headers: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' } }
    );

    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].metadata.name, 'orders-broken');
    assert.equal(result.metadata.totalItems, 1);
    assert.equal(seenPaths[0], '/argocd/api/v1/applications?projects=core');
    assert.equal(seenTraceparents[0], '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');

    const projects = await client.listProjects();
    assert.equal(projects.totalItems, 1);
    assert.equal(projects.items[0].name, 'core');
  } finally {
    await stub.close();
  }
});

test('HttpClient surfaces non-2xx JSON and plain-text responses as typed ArgoCDApiError', async () => {
  const stub = await startStubArgoCD((req, res) => {
    if (req.url?.includes('/missing-app')) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({ code: 5, message: 'applications.argoproj.io "missing-app" not found' })
      );
      return;
    }
    res.statusCode = 502;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Bad Gateway from upstream proxy');
  });

  try {
    const client = new ArgoCDClient(stub.baseUrl, 'test-token');
    await assert.rejects(
      () => client.getApplication('missing-app'),
      (err) => {
        assert.ok(err instanceof ArgoCDApiError);
        assert.equal(err.status, 404);
        const translated = translateErrorForAgent(err, { applicationName: 'missing-app' });
        assert.match(translated, /list_applications\(search="missing-app"\)/);
        return true;
      }
    );

    await assert.rejects(
      () => client.listClusters(),
      (err) => {
        assert.ok(err instanceof ArgoCDApiError);
        assert.equal(err.status, 502);
        assert.match(err.message, /Bad Gateway/);
        return true;
      }
    );
  } finally {
    await stub.close();
  }
});

test('getWorkloadLogs supports optional container, grep filtering, and trailing NDJSON lines', async () => {
  let capturedUrl = '';
  const stub = await startStubArgoCD((req, res) => {
    capturedUrl = req.url ?? '';
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.write(
      JSON.stringify({ result: { content: 'INFO starting server', podName: 'p1' } }) + '\n'
    );
    res.write(
      JSON.stringify({ result: { content: 'ERROR database connection refused', podName: 'p1' } }) +
        '\n'
    );
    // Deliberately omit trailing newline to verify flush handling.
    res.end(JSON.stringify({ result: { content: 'ERROR retry exhausted', podName: 'p1' } }));
  });

  try {
    const client = new ArgoCDClient(stub.baseUrl, 'test-token');
    const result = await client.getWorkloadLogs(
      'demo-app',
      'argocd',
      { group: 'apps', version: 'v1', kind: 'Deployment', namespace: 'default', name: 'web' },
      { tailLines: 50, grep: 'error' }
    );

    assert.ok(!capturedUrl.includes('container='), 'container omitted when not provided');
    assert.ok(capturedUrl.includes('tailLines=50'));
    assert.equal(result.returnedLines, 2);
    assert.equal(result.truncated, false);
    assert.match(result.entries[1].content ?? '', /retry exhausted/);
  } finally {
    await stub.close();
  }
});
