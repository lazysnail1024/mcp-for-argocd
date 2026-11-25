import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo, Server } from 'node:net';
import { connectHttpTransport } from './transport.js';

const INBOUND_TOKEN = 'inbound-secret';

const freePort = async (): Promise<number> => {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
};

const startTransport = async (): Promise<{ port: number; close: () => Promise<void> }> => {
  const port = await freePort();
  const previousToken = process.env.ARGOCD_API_TOKEN;
  delete process.env.ARGOCD_API_TOKEN;
  const server: Server = connectHttpTransport({ port, authToken: INBOUND_TOKEN });
  await new Promise((resolve) => server.once('listening', resolve));
  return {
    port,
    close: async () => {
      if (previousToken !== undefined) process.env.ARGOCD_API_TOKEN = previousToken;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
};

const request = (
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: options.path ?? '/mcp',
        method: options.method ?? 'POST',
        headers: options.headers ?? {}
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      }
    );
    req.on('error', reject);
    req.end(options.body);
  });

const initialize = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'transport-test', version: '1.0.0' }
  }
});

const authorized = (port: number) => ({
  host: `localhost:${port}`,
  authorization: `Bearer ${INBOUND_TOKEN}`,
  'content-type': 'application/json'
});

test('the http transport requires the inbound token on /mcp', async () => {
  const { port, close } = await startTransport();
  try {
    for (const method of ['POST', 'GET', 'DELETE']) {
      const res = await request(port, {
        method,
        headers: { host: `localhost:${port}`, 'content-type': 'application/json' },
        body: method === 'POST' ? initialize : undefined
      });
      assert.equal(res.status, 401, `${method} /mcp without a token is rejected`);
    }
  } finally {
    await close();
  }
});

test('the http transport rejects a forged Host and a cross-origin request on /mcp', async () => {
  const { port, close } = await startTransport();
  try {
    const forgedHost = await request(port, {
      headers: { ...authorized(port), host: 'evil.example' },
      body: initialize
    });
    assert.equal(forgedHost.status, 403);
    assert.match(forgedHost.body, /Invalid Host/);

    const crossOrigin = await request(port, {
      headers: { ...authorized(port), origin: 'https://evil.example' },
      body: initialize
    });
    assert.equal(crossOrigin.status, 403);
    assert.match(crossOrigin.body, /Invalid Origin/);
  } finally {
    await close();
  }
});

test('an authorized request reaches the http transport credential check and stateless GET/DELETE return 405', async () => {
  const { port, close } = await startTransport();
  try {
    const res = await request(port, { headers: authorized(port), body: initialize });
    assert.equal(res.status, 400);
    assert.match(res.body, /x-argocd-api-token/);

    for (const method of ['GET', 'DELETE']) {
      const m = await request(port, { method, headers: authorized(port) });
      assert.equal(m.status, 405);
      assert.equal(m.headers.allow, 'POST');
    }

    const legacySse = await request(port, {
      method: 'GET',
      path: '/sse',
      headers: authorized(port)
    });
    assert.equal(legacySse.status, 404);
  } finally {
    await close();
  }
});

test('/healthz stays reachable without a token and reports argocd-mcp-plus 0.9.1', async () => {
  const { port, close } = await startTransport();
  try {
    const res = await request(port, {
      method: 'GET',
      path: '/healthz',
      headers: { host: '10.1.2.3:8080' }
    });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body) as { status: string; name: string; version: string };
    assert.equal(parsed.status, 'ok');
    assert.equal(parsed.name, 'argocd-mcp-plus');
    assert.equal(parsed.version, '0.9.1');
  } finally {
    await close();
  }
});

const rawRequest = (port: number, payload: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(payload));
    let response = '';
    socket.on('data', (chunk) => (response += chunk));
    socket.on('end', () => resolve(response.split('\r\n')[0]));
    socket.on('error', reject);
  });

test('an absent or empty Host header is rejected, not treated as an allowed name', async () => {
  const { port, close } = await startTransport();
  try {
    const authorization = `Authorization: Bearer ${INBOUND_TOKEN}`;
    const absent = await rawRequest(port, `GET /mcp HTTP/1.0\r\n${authorization}\r\n\r\n`);
    assert.match(absent, /^HTTP\/1\.1 403/);

    const empty = await rawRequest(port, `GET /mcp HTTP/1.0\r\nHost:\r\n${authorization}\r\n\r\n`);
    assert.match(empty, /^HTTP\/1\.1 403/);
  } finally {
    await close();
  }
});
