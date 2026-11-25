import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizePayload } from './sanitizer.js';
import { serializeWithByteLimit } from './byteBreaker.js';
import { ScopeFence } from './scopeFence.js';
import {
  buildApplicationDiagnosis,
  buildApplicationDiff,
  selectDiagnosticEventNodes,
  summarizeResourceTree
} from './curation.js';
import {
  ResponseSizeLimitError,
  ScopeViolationError,
  translateErrorForAgent
} from '../argocd/errors.js';

test('sanitizer strips managedFields and last-applied-configuration while keeping ConfigMap intact', () => {
  const configMap = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: 'app-config',
      namespace: 'default',
      managedFields: [{ manager: 'argocd-controller', operation: 'Apply' }],
      annotations: {
        'kubectl.kubernetes.io/last-applied-configuration': '{"huge":"blob"}',
        'app.example.com/owner': 'platform'
      }
    },
    data: {
      LOG_LEVEL: 'info',
      MAX_TOKENS: '4096',
      SECRET_MOUNT_PATH: '/var/run/secrets'
    }
  };

  const sanitized = sanitizePayload(configMap);
  assert.equal('managedFields' in sanitized.metadata, false);
  assert.equal(
    'kubectl.kubernetes.io/last-applied-configuration' in (sanitized.metadata.annotations ?? {}),
    false
  );
  assert.equal(sanitized.metadata.annotations?.['app.example.com/owner'], 'platform');
  // ConfigMap values are preserved without regex false positives.
  assert.deepEqual(sanitized.data, configMap.data);
});

test('sanitizer masks v1/Secret data and stringData including embedded JSON manifests', () => {
  const secretManifest = JSON.stringify({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: 'db-creds',
      annotations: { 'argocd.argoproj.io/show-secret-value': 'true' },
      managedFields: [{ manager: 'kubectl' }]
    },
    type: 'Opaque',
    data: { username: 'YWRtaW4=', password: 'c3VwZXItc2VjcmV0' },
    stringData: { dsn: 'postgres://secret' }
  });

  const wrapped = sanitizePayload({ manifest: secretManifest });
  const parsed = JSON.parse(wrapped.manifest) as {
    metadata: Record<string, unknown>;
    data: Record<string, string>;
    stringData: Record<string, string>;
  };

  assert.equal('managedFields' in parsed.metadata, false);
  assert.deepEqual(parsed.data, { username: '[REDACTED]', password: '[REDACTED]' });
  assert.deepEqual(parsed.stringData, { dsn: '[REDACTED]' });
});

test('byteBreaker refuses oversized payloads cleanly without producing broken JSON', () => {
  const small = serializeWithByteLimit({ ok: true }, 'get_application', 1024);
  assert.equal(small, '{"ok":true}');

  assert.throws(
    () => serializeWithByteLimit({ big: 'x'.repeat(2000) }, 'get_resources', 512),
    (err) => {
      assert.ok(err instanceof ResponseSizeLimitError);
      assert.equal(err.limitBytes, 512);
      const hint = translateErrorForAgent(err);
      assert.match(hint, /diagnose_application/);
      return true;
    }
  );
});

test('ScopeFence enforces MCP_ALLOWED_PROJECTS and MCP_DENIED_NAMESPACES bidirectionally', () => {
  const fence = new ScopeFence({
    allowedProjects: ['core', 'payments'],
    deniedNamespaces: ['kube-system', 'mcp-e2e-denied']
  });

  fence.assertApplicationAllowed({
    spec: { project: 'core', destination: { namespace: 'app-ns' } },
    metadata: { namespace: 'argocd' }
  });

  assert.throws(
    () =>
      fence.assertApplicationAllowed({
        spec: { project: 'other-proj', destination: { namespace: 'app-ns' } }
      }),
    ScopeViolationError
  );

  assert.throws(
    () =>
      fence.assertApplicationAllowed({
        spec: { project: 'core', destination: { namespace: 'kube-system' } }
      }),
    ScopeViolationError
  );

  const filtered = fence.filterApplications([
    {
      metadata: { name: 'a1', namespace: 'argocd' },
      spec: { project: 'core', destination: { namespace: 'ok' } }
    },
    {
      metadata: { name: 'a2', namespace: 'argocd' },
      spec: { project: 'blocked', destination: { namespace: 'ok' } }
    },
    {
      metadata: { name: 'a3', namespace: 'argocd' },
      spec: { project: 'core', destination: { namespace: 'mcp-e2e-denied' } }
    }
  ]);
  assert.deepEqual(
    filtered.map((a) => a.metadata.name),
    ['a1']
  );
});

test('buildApplicationDiagnosis strips Synced+Healthy nodes and detects paused Argo Rollout', () => {
  const diagnosis = buildApplicationDiagnosis(
    {
      metadata: { name: 'demo', namespace: 'argocd' },
      spec: { project: 'default', destination: { namespace: 'demo' } },
      status: {
        sync: { status: 'OutOfSync', revision: 'abc123' },
        health: { status: 'Degraded' },
        resources: [
          { group: '', kind: 'Service', namespace: 'demo', name: 'svc-ok', status: 'Synced' },
          {
            group: 'apps',
            kind: 'Deployment',
            namespace: 'demo',
            name: 'web-bad',
            status: 'OutOfSync'
          },
          {
            group: 'argoproj.io',
            kind: 'Rollout',
            namespace: 'demo',
            name: 'canary',
            status: 'Synced'
          }
        ],
        operationState: { phase: 'Failed', message: 'sync error' }
      }
    },
    {
      nodes: [
        {
          group: '',
          version: 'v1',
          kind: 'Service',
          namespace: 'demo',
          name: 'svc-ok',
          health: { status: 'Healthy' }
        },
        {
          group: 'apps',
          version: 'v1',
          kind: 'Deployment',
          namespace: 'demo',
          name: 'web-bad',
          health: { status: 'Degraded', message: 'ImagePullBackOff' }
        },
        {
          group: 'argoproj.io',
          version: 'v1alpha1',
          kind: 'Rollout',
          namespace: 'demo',
          name: 'canary',
          health: { status: 'Suspended', message: 'Canary paused' }
        }
      ]
    },
    {
      items: [
        { type: 'Normal', reason: 'Pulled', message: 'ok' },
        {
          type: 'Warning',
          reason: 'Failed',
          message: 'ErrImagePull',
          involvedObject: { kind: 'Pod', namespace: 'demo', name: 'web-bad-1' }
        }
      ]
    }
  );

  assert.equal(diagnosis.resourceSummary.totalNodes, 3);
  assert.equal(diagnosis.resourceSummary.healthySyncedNodesOmitted, 1);
  assert.equal(diagnosis.abnormalResources.length, 2);
  assert.equal(
    diagnosis.abnormalResources.some((r) => r.name === 'svc-ok'),
    false
  );
  assert.equal(diagnosis.warningEvents.length, 1);
  assert.equal(diagnosis.domainHints.length, 1);
  assert.match(diagnosis.domainHints[0], /Rollout/);
});

test('selectDiagnosticEventNodes prioritizes unhealthy Pods over Deployments and ConfigMaps and caps count', () => {
  const targets = selectDiagnosticEventNodes(
    {
      status: {
        resources: [
          { group: '', kind: 'ConfigMap', namespace: 'ns', name: 'cm-drift', status: 'OutOfSync' }
        ]
      }
    },
    {
      nodes: [
        {
          kind: 'Service',
          namespace: 'ns',
          name: 'svc-ok',
          uid: 'u-svc',
          health: { status: 'Healthy' }
        },
        { kind: 'ConfigMap', namespace: 'ns', name: 'cm-drift', uid: 'u-cm' },
        {
          kind: 'Deployment',
          namespace: 'ns',
          name: 'dep-bad',
          uid: 'u-dep',
          health: { status: 'Degraded' }
        },
        {
          kind: 'Pod',
          namespace: 'ns',
          name: 'pod-bad',
          uid: 'u-pod',
          health: { status: 'Degraded' }
        }
      ]
    },
    2
  );
  assert.deepEqual(
    targets.map((t) => `${t.kind}/${t.name}`),
    ['Pod/pod-bad', 'Deployment/dep-bad']
  );
});

test('summarizeResourceTree aggregates counts by Kind and highlights unhealthy nodes', () => {
  const summary = summarizeResourceTree({
    nodes: [
      { kind: 'Service', name: 's1', health: { status: 'Healthy' } },
      { kind: 'Deployment', name: 'd1', health: { status: 'Healthy' } },
      { kind: 'Deployment', name: 'd2', health: { status: 'Degraded', message: 'crash' } }
    ]
  });
  assert.equal(summary.totalNodes, 3);
  assert.deepEqual(summary.byKind, {
    Service: { Healthy: 1 },
    Deployment: { Healthy: 1, Degraded: 1 }
  });
  assert.equal(summary.unhealthyNodes.length, 1);
  assert.equal(summary.unhealthyNodes[0].name, 'd2');
});

test('buildApplicationDiff computes field-level diffs and skips identical resources', () => {
  const diff = buildApplicationDiff('demo', {
    items: [
      {
        group: '',
        kind: 'ConfigMap',
        namespace: 'demo',
        name: 'unchanged',
        liveState: JSON.stringify({
          kind: 'ConfigMap',
          metadata: { name: 'unchanged', resourceVersion: '10', managedFields: [{}] },
          data: { k: 'v' }
        }),
        targetState: JSON.stringify({
          kind: 'ConfigMap',
          metadata: { name: 'unchanged' },
          data: { k: 'v' }
        })
      },
      {
        group: '',
        kind: 'ConfigMap',
        namespace: 'demo',
        name: 'drifted',
        normalizedLiveState: JSON.stringify({
          kind: 'ConfigMap',
          metadata: { name: 'drifted' },
          data: { mode: 'manual-hotfix' }
        }),
        targetState: JSON.stringify({
          kind: 'ConfigMap',
          metadata: { name: 'drifted' },
          data: { mode: 'git-desired' }
        })
      }
    ]
  });

  assert.equal(diff.totalManagedResources, 2);
  assert.equal(diff.outOfSyncResources, 1);
  assert.equal(diff.diffs[0].name, 'drifted');
  assert.deepEqual(diff.diffs[0].changes, [
    { path: 'data.mode', change: 'modified', live: 'manual-hotfix', target: 'git-desired' }
  ]);
});
