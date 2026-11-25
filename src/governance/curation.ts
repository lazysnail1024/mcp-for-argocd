import type {
  V1alpha1Application,
  V1alpha1ApplicationTree,
  V1alpha1ResourceDiff,
  V1alpha1ResourceNode,
  V1EventList
} from '../types/argocd-types.js';
import { sanitizePayload } from './sanitizer.js';

export type DiagnosedResource = {
  group: string;
  version: string;
  kind: string;
  namespace?: string;
  name?: string;
  uid?: string;
  healthStatus?: string;
  healthMessage?: string;
  syncStatus?: string;
  requiresPruning?: boolean;
};

export type ApplicationDiagnosis = {
  application: {
    name?: string;
    namespace?: string;
    project?: string;
    destination?: { server?: string; name?: string; namespace?: string };
    syncStatus?: string;
    syncRevision?: string;
    healthStatus?: string;
    healthMessage?: string;
  };
  operationState?: {
    phase?: string;
    message?: string;
    startedAt?: string;
    finishedAt?: string;
    failedResources?: Array<{
      kind?: string;
      namespace?: string;
      name?: string;
      status?: string;
      message?: string;
    }>;
  };
  conditions: Array<{ type?: string; message?: string; lastTransitionTime?: string }>;
  resourceSummary: {
    totalNodes: number;
    healthySyncedNodesOmitted: number;
    abnormalNodes: number;
  };
  abnormalResources: DiagnosedResource[];
  warningEvents: Array<{
    reason?: string;
    message?: string;
    involvedObject?: string;
    count?: number;
    lastTimestamp?: string;
  }>;
  domainHints: string[];
};

const isHealthyNode = (
  node: V1alpha1ResourceNode,
  syncByKey: Map<string, { status?: string; requiresPruning?: boolean }>
): { abnormal: boolean; syncStatus?: string; requiresPruning?: boolean } => {
  const key = `${node.group ?? ''}/${node.kind ?? ''}/${node.namespace ?? ''}/${node.name ?? ''}`;
  const appResource = syncByKey.get(key);
  const healthStatus = node.health?.status;
  const syncStatus = appResource?.status;
  const requiresPruning = appResource?.requiresPruning;

  const healthOk = !healthStatus || healthStatus === 'Healthy';
  const syncOk = !syncStatus || syncStatus === 'Synced';
  const abnormal = !healthOk || !syncOk || Boolean(requiresPruning);
  return { abnormal, syncStatus, requiresPruning };
};

const EVENT_KIND_PRIORITY: Record<string, number> = {
  Pod: 0,
  Deployment: 1,
  Rollout: 1,
  StatefulSet: 1,
  DaemonSet: 1,
  Job: 1,
  ReplicaSet: 2
};

export type DiagnosticEventNode = {
  uid: string;
  namespace: string;
  name: string;
  kind: string;
};

// Select the highest-signal abnormal child resources whose Kubernetes Warning events
// should be fetched alongside Application-level events (Argo CD's /events without
// resourceUID only returns events on the Application CR itself).
export const selectDiagnosticEventNodes = (
  app: V1alpha1Application,
  tree: V1alpha1ApplicationTree,
  maxNodes = 5
): DiagnosticEventNode[] => {
  const syncByKey = new Map<string, { status?: string; requiresPruning?: boolean }>();
  for (const res of app.status?.resources ?? []) {
    const key = `${res.group ?? ''}/${res.kind ?? ''}/${res.namespace ?? ''}/${res.name ?? ''}`;
    syncByKey.set(key, {
      status: res.status,
      requiresPruning: res.requiresPruning
    });
  }

  const candidates: Array<DiagnosticEventNode & { priority: number }> = [];
  for (const node of tree.nodes ?? []) {
    const { abnormal } = isHealthyNode(node, syncByKey);
    if (!abnormal) continue;
    if (!node.uid || !node.namespace || !node.name) continue;
    const kind = node.kind ?? '';
    const healthBad = Boolean(node.health?.status && node.health.status !== 'Healthy');
    const basePriority = EVENT_KIND_PRIORITY[kind] ?? 3;
    // Prefer unhealthy workloads over purely OutOfSync ConfigMaps/Services
    candidates.push({
      uid: node.uid,
      namespace: node.namespace,
      name: node.name,
      kind,
      priority: healthBad ? basePriority : basePriority + 10
    });
  }

  candidates.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  return candidates.slice(0, maxNodes).map(({ uid, namespace, name, kind }) => ({
    uid,
    namespace,
    name,
    kind
  }));
};

export const buildApplicationDiagnosis = (
  app: V1alpha1Application,
  tree: V1alpha1ApplicationTree,
  events: V1EventList
): ApplicationDiagnosis => {
  const syncByKey = new Map<string, { status?: string; requiresPruning?: boolean }>();
  for (const res of app.status?.resources ?? []) {
    const key = `${res.group ?? ''}/${res.kind ?? ''}/${res.namespace ?? ''}/${res.name ?? ''}`;
    syncByKey.set(key, {
      status: res.status,
      requiresPruning: res.requiresPruning
    });
  }

  const allNodes = tree.nodes ?? [];
  const abnormalResources: DiagnosedResource[] = [];
  let hasPausedRollout = false;

  for (const node of allNodes) {
    const { abnormal, syncStatus, requiresPruning } = isHealthyNode(node, syncByKey);
    if (!abnormal) continue;

    const healthStatus = node.health?.status;
    if (
      node.kind === 'Rollout' &&
      (node.group ?? '').includes('argoproj.io') &&
      (healthStatus === 'Suspended' ||
        (healthStatus === 'Progressing' &&
          (node.health?.message ?? '').toLowerCase().includes('paused')))
    ) {
      hasPausedRollout = true;
    }

    abnormalResources.push({
      group: node.group ?? '',
      version: node.version ?? '',
      kind: node.kind ?? '',
      namespace: node.namespace,
      name: node.name,
      uid: node.uid,
      healthStatus,
      healthMessage: node.health?.message,
      syncStatus,
      requiresPruning
    });
  }

  const failedResources = (app.status?.operationState?.syncResult?.resources ?? [])
    .filter((r) => r.status && r.status !== 'Synced')
    .slice(0, 20)
    .map((r) => ({
      kind: r.kind,
      namespace: r.namespace,
      name: r.name,
      status: r.status,
      message: r.message
    }));

  const seenEventKeys = new Set<string>();
  const warningEvents = (events.items ?? [])
    .filter((e) => (e.type ?? '').toLowerCase() === 'warning')
    .sort((a, b) =>
      String(b.lastTimestamp ?? b.eventTime ?? '').localeCompare(
        String(a.lastTimestamp ?? a.eventTime ?? '')
      )
    )
    .filter((e) => {
      const involved = [e.involvedObject?.kind, e.involvedObject?.namespace, e.involvedObject?.name]
        .filter(Boolean)
        .join('/');
      const key = e.metadata?.uid || `${involved}|${e.reason ?? ''}|${e.message ?? ''}`;
      if (seenEventKeys.has(key)) return false;
      seenEventKeys.add(key);
      return true;
    })
    .slice(0, 25)
    .map((e) => ({
      reason: e.reason,
      message: e.message,
      involvedObject: [e.involvedObject?.kind, e.involvedObject?.namespace, e.involvedObject?.name]
        .filter(Boolean)
        .join('/'),
      count: e.count,
      lastTimestamp: String(e.lastTimestamp ?? e.eventTime ?? '')
    }));

  const domainHints: string[] = [];
  if (hasPausedRollout) {
    domainHints.push(
      'Detected Argo Rollout in Canary/BlueGreen paused state (Suspended/Progressing). This is an expected progressive delivery pause gate rather than a workload crash; do not blindly trigger a retry sync.'
    );
  }

  return {
    application: {
      name: app.metadata?.name,
      namespace: app.metadata?.namespace,
      project: app.spec?.project,
      destination: app.spec?.destination,
      syncStatus: app.status?.sync?.status,
      syncRevision: app.status?.sync?.revision,
      healthStatus: app.status?.health?.status,
      healthMessage: app.status?.health?.message
    },
    operationState: app.status?.operationState
      ? {
          phase: app.status.operationState.phase,
          message: app.status.operationState.message,
          startedAt: app.status.operationState.startedAt,
          finishedAt: app.status.operationState.finishedAt,
          failedResources: failedResources.length > 0 ? failedResources : undefined
        }
      : undefined,
    conditions: (app.status?.conditions ?? []).map((c) => ({
      type: c.type,
      message: c.message,
      lastTransitionTime: c.lastTransitionTime
    })),
    resourceSummary: {
      totalNodes: allNodes.length,
      healthySyncedNodesOmitted: allNodes.length - abnormalResources.length,
      abnormalNodes: abnormalResources.length
    },
    abnormalResources,
    warningEvents,
    domainHints
  };
};

export type TreeSummary = {
  totalNodes: number;
  byKind: Record<string, Record<string, number>>;
  unhealthyNodes: Array<{
    group?: string;
    version?: string;
    kind?: string;
    namespace?: string;
    name?: string;
    uid?: string;
    health?: { status?: string; message?: string };
  }>;
};

export const summarizeResourceTree = (tree: V1alpha1ApplicationTree): TreeSummary => {
  const nodes = tree.nodes ?? [];
  const byKind: Record<string, Record<string, number>> = {};
  const unhealthyNodes: TreeSummary['unhealthyNodes'] = [];

  for (const node of nodes) {
    const kind = node.kind || 'Unknown';
    const health = node.health?.status || 'NoHealthCheck';
    byKind[kind] = byKind[kind] ?? {};
    byKind[kind][health] = (byKind[kind][health] ?? 0) + 1;

    if (node.health?.status && node.health.status !== 'Healthy') {
      unhealthyNodes.push({
        group: node.group,
        version: node.version,
        kind: node.kind,
        namespace: node.namespace,
        name: node.name,
        uid: node.uid,
        health: node.health
      });
    }
  }

  return {
    totalNodes: nodes.length,
    byKind,
    unhealthyNodes
  };
};

export type FieldChange = {
  path: string;
  change: 'added' | 'removed' | 'modified';
  live?: unknown;
  target?: unknown;
};

export type ResourceDiffSummary = {
  group: string;
  kind: string;
  namespace?: string;
  name?: string;
  status: 'out_of_sync' | 'missing_live' | 'extra_live';
  changes: FieldChange[];
  truncatedChanges?: boolean;
};

const MAX_CHANGES_PER_RESOURCE = 40;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const parseState = (raw: string | undefined): Record<string, unknown> | null => {
  if (!raw || !raw.trim() || raw.trim() === 'null') return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? sanitizePayload(parsed) : null;
  } catch {
    return null;
  }
};

// Keys managed dynamically by Kubernetes controllers that do not indicate GitOps spec drift.
const IGNORED_DIFF_ROOT_KEYS = new Set(['status']);
const IGNORED_METADATA_KEYS = new Set([
  'resourceVersion',
  'uid',
  'generation',
  'creationTimestamp',
  'managedFields',
  'selfLink'
]);

const collectDiffs = (
  liveVal: unknown,
  targetVal: unknown,
  path: string,
  changes: FieldChange[]
): void => {
  if (changes.length >= MAX_CHANGES_PER_RESOURCE) return;
  if (Object.is(liveVal, targetVal)) return;

  if (liveVal === undefined && targetVal !== undefined) {
    changes.push({ path, change: 'added', target: targetVal });
    return;
  }
  if (liveVal !== undefined && targetVal === undefined) {
    changes.push({ path, change: 'removed', live: liveVal });
    return;
  }

  if (Array.isArray(liveVal) && Array.isArray(targetVal)) {
    if (JSON.stringify(liveVal) !== JSON.stringify(targetVal)) {
      changes.push({ path, change: 'modified', live: liveVal, target: targetVal });
    }
    return;
  }

  if (isRecord(liveVal) && isRecord(targetVal)) {
    const keys = new Set([...Object.keys(liveVal), ...Object.keys(targetVal)]);
    for (const key of [...keys].sort()) {
      if (path === '' && IGNORED_DIFF_ROOT_KEYS.has(key)) continue;
      if (path === 'metadata' && IGNORED_METADATA_KEYS.has(key)) continue;
      const nextPath = path ? `${path}.${key}` : key;
      collectDiffs(liveVal[key], targetVal[key], nextPath, changes);
      if (changes.length >= MAX_CHANGES_PER_RESOURCE) return;
    }
    return;
  }

  changes.push({ path, change: 'modified', live: liveVal, target: targetVal });
};

export const buildApplicationDiff = (
  applicationName: string,
  managedResources: { items?: V1alpha1ResourceDiff[] }
) => {
  const items = managedResources.items ?? [];
  const diffs: ResourceDiffSummary[] = [];

  for (const item of items) {
    const live = parseState(item.normalizedLiveState || item.liveState);
    const target = parseState(item.targetState);

    if (!live && !target) continue;

    if (!live && target) {
      diffs.push({
        group: item.group ?? '',
        kind: item.kind ?? '',
        namespace: item.namespace,
        name: item.name,
        status: 'missing_live',
        changes: [{ path: '', change: 'added', target: { kind: item.kind, name: item.name } }]
      });
      continue;
    }

    if (live && !target) {
      diffs.push({
        group: item.group ?? '',
        kind: item.kind ?? '',
        namespace: item.namespace,
        name: item.name,
        status: 'extra_live',
        changes: [{ path: '', change: 'removed', live: { kind: item.kind, name: item.name } }]
      });
      continue;
    }

    const changes: FieldChange[] = [];
    collectDiffs(live, target, '', changes);
    if (changes.length > 0 || item.modified) {
      diffs.push({
        group: item.group ?? '',
        kind: item.kind ?? '',
        namespace: item.namespace,
        name: item.name,
        status: 'out_of_sync',
        changes,
        truncatedChanges: changes.length >= MAX_CHANGES_PER_RESOURCE ? true : undefined
      });
    }
  }

  return {
    applicationName,
    totalManagedResources: items.length,
    outOfSyncResources: diffs.length,
    diffs
  };
};
