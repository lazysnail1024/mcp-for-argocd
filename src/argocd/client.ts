import {
  ApplicationLogEntry,
  V1alpha1Application,
  V1alpha1ApplicationList,
  V1alpha1ApplicationTree,
  V1EventList,
  V1alpha1ResourceAction,
  V1alpha1ResourceDiff,
  V1alpha1ResourceResult,
  V1alpha1ApplicationResourceResult,
  V1alpha1ClusterList,
  V1alpha1AppProject,
  V1alpha1AppProjectList,
  V1alpha1SyncOperationResource
} from '../types/argocd-types.js';
import { HttpClient, type RequestOptions } from './http.js';
import { encodePathSegment } from './url.js';

export type ListApplicationsParams = {
  search?: string;
  project?: string;
  healthStatus?: string;
  syncStatus?: string;
  appNamespace?: string;
  limit?: number;
  offset?: number;
};

export type ApplicationSummary = {
  metadata: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    creationTimestamp?: string;
  };
  spec: {
    project?: string;
    source?: NonNullable<V1alpha1Application['spec']>['source'];
    destination?: NonNullable<V1alpha1Application['spec']>['destination'];
  };
  status: {
    sync?: {
      status?: string;
      revision?: string;
    };
    health?: {
      status?: string;
      message?: string;
    };
    summary?: NonNullable<V1alpha1Application['status']>['summary'];
  };
};

export type WorkloadLogsOptions = {
  container?: string;
  tailLines?: number;
  grep?: string;
  maxBytes?: number;
};

const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_LOG_TAIL_LINES = 100;
const MAX_LOG_TAIL_LINES = 500;
const DEFAULT_LOG_MAX_BYTES = 32 * 1024;

export class ArgoCDClient {
  private baseUrl: string;
  private apiToken: string;
  private client: HttpClient;

  constructor(baseUrl: string, apiToken: string) {
    this.baseUrl = baseUrl;
    this.apiToken = apiToken;
    this.client = new HttpClient(this.baseUrl, this.apiToken);
  }

  public async listApplications(params?: ListApplicationsParams, options?: RequestOptions) {
    const queryParams: Record<string, string> = {};
    if (params?.project) queryParams.projects = params.project;
    if (params?.appNamespace) queryParams.appNamespace = params.appNamespace;

    const { body } = await this.client.get<V1alpha1ApplicationList>(
      'api/v1/applications',
      Object.keys(queryParams).length > 0 ? queryParams : undefined,
      options
    );

    const searchNeedle = params?.search?.trim().toLowerCase();
    const projectFilter = params?.project?.trim();
    const healthFilter = params?.healthStatus?.trim().toLowerCase();
    const syncFilter = params?.syncStatus?.trim().toLowerCase();

    const filteredApps = (body.items ?? []).filter((app) => {
      if (searchNeedle) {
        const name = (app.metadata?.name ?? '').toLowerCase();
        if (!name.includes(searchNeedle)) return false;
      }
      if (projectFilter && app.spec?.project !== projectFilter) {
        return false;
      }
      if (healthFilter && (app.status?.health?.status ?? '').toLowerCase() !== healthFilter) {
        return false;
      }
      if (syncFilter && (app.status?.sync?.status ?? '').toLowerCase() !== syncFilter) {
        return false;
      }
      return true;
    });

    const strippedItems: ApplicationSummary[] = filteredApps.map((app) => ({
      metadata: {
        name: app.metadata?.name,
        namespace: app.metadata?.namespace,
        labels: app.metadata?.labels,
        creationTimestamp: app.metadata?.creationTimestamp
      },
      spec: {
        project: app.spec?.project,
        source: app.spec?.source,
        destination: app.spec?.destination
      },
      status: {
        sync: app.status?.sync
          ? {
              status: app.status.sync.status,
              revision: app.status.sync.revision
            }
          : undefined,
        health: app.status?.health
          ? {
              status: app.status.health.status,
              message: app.status.health.message
            }
          : undefined,
        summary: app.status?.summary
      }
    }));

    const start = params?.offset ?? 0;
    const limit = params?.limit ?? DEFAULT_LIST_LIMIT;
    const end = start + limit;
    const items = strippedItems.slice(start, end);

    return {
      items,
      metadata: {
        resourceVersion: body.metadata?.resourceVersion,
        totalItems: strippedItems.length,
        returnedItems: items.length,
        offset: start,
        limit,
        hasMore: end < strippedItems.length
      }
    };
  }

  public async listClusters(params?: { server?: string; name?: string }, options?: RequestOptions) {
    const queryParams: Record<string, string> = {};
    if (params?.server) queryParams.server = params.server;
    if (params?.name) queryParams.name = params.name;

    const { body } = await this.client.get<V1alpha1ClusterList>(
      'api/v1/clusters',
      Object.keys(queryParams).length > 0 ? queryParams : undefined,
      options
    );

    return body;
  }

  public async listProjects(options?: RequestOptions) {
    const { body } = await this.client.get<V1alpha1AppProjectList>(
      'api/v1/projects',
      undefined,
      options
    );
    const items = (body.items ?? []).map((proj) => ({
      name: proj.metadata?.name,
      namespace: proj.metadata?.namespace,
      description: proj.spec?.description,
      sourceRepos: proj.spec?.sourceRepos ?? [],
      destinations: proj.spec?.destinations ?? []
    }));
    return { items, totalItems: items.length };
  }

  public async getApplication(
    applicationName: string,
    appNamespace?: string,
    refresh?: 'normal' | 'hard',
    options?: RequestOptions
  ) {
    const appSeg = encodePathSegment(applicationName, 'applicationName');
    const queryParams: Record<string, string> = {};
    if (appNamespace) queryParams.appNamespace = appNamespace;
    if (refresh) queryParams.refresh = refresh;

    const { body } = await this.client.get<V1alpha1Application>(
      `api/v1/applications/${appSeg}`,
      Object.keys(queryParams).length > 0 ? queryParams : undefined,
      options
    );
    return body;
  }

  public async getAppProject(projectName: string, options?: RequestOptions) {
    const projSeg = encodePathSegment(projectName, 'projectName');
    const { body } = await this.client.get<V1alpha1AppProject>(
      `api/v1/projects/${projSeg}`,
      undefined,
      options
    );
    return body;
  }

  public async createApplication(application: V1alpha1Application, options?: RequestOptions) {
    const { body } = await this.client.post<V1alpha1Application, V1alpha1Application>(
      'api/v1/applications',
      null,
      application,
      options
    );
    return body;
  }

  public async updateApplication(
    applicationName: string,
    application: V1alpha1Application,
    options?: RequestOptions
  ) {
    const appSeg = encodePathSegment(applicationName, 'applicationName');
    const { body } = await this.client.put<V1alpha1Application, V1alpha1Application>(
      `api/v1/applications/${appSeg}`,
      null,
      application,
      options
    );
    return body;
  }

  public async deleteApplication(
    applicationName: string,
    deleteOptions?: {
      appNamespace?: string;
      cascade?: boolean;
      propagationPolicy?: string;
    },
    requestOptions?: RequestOptions
  ) {
    const appSeg = encodePathSegment(applicationName, 'applicationName');
    const queryParams: Record<string, string | boolean> = {};

    if (deleteOptions?.appNamespace) {
      queryParams.appNamespace = deleteOptions.appNamespace;
    }
    if (deleteOptions?.cascade !== undefined) {
      queryParams.cascade = deleteOptions.cascade;
    }
    if (deleteOptions?.propagationPolicy) {
      queryParams.propagationPolicy = deleteOptions.propagationPolicy;
    }

    const { body } = await this.client.delete<V1alpha1Application>(
      `api/v1/applications/${appSeg}`,
      Object.keys(queryParams).length > 0 ? queryParams : undefined,
      requestOptions
    );
    return body;
  }

  public async syncApplication(
    applicationName: string,
    syncOptions?: {
      appNamespace?: string;
      dryRun?: boolean;
      prune?: boolean;
      revision?: string;
      syncOptions?: string[];
      resources?: V1alpha1SyncOperationResource[];
    },
    requestOptions?: RequestOptions
  ) {
    const appSeg = encodePathSegment(applicationName, 'applicationName');
    const syncRequest: Record<string, unknown> = {};

    if (syncOptions?.appNamespace) {
      syncRequest.appNamespace = syncOptions.appNamespace;
    }
    if (syncOptions?.dryRun !== undefined) {
      syncRequest.dryRun = syncOptions.dryRun;
    }
    if (syncOptions?.prune !== undefined) {
      syncRequest.prune = syncOptions.prune;
    }
    if (syncOptions?.revision) {
      syncRequest.revision = syncOptions.revision;
    }
    if (syncOptions?.syncOptions) {
      syncRequest.syncOptions = syncOptions.syncOptions;
    }
    if (syncOptions?.resources && syncOptions.resources.length > 0) {
      syncRequest.resources = syncOptions.resources;
    }

    const { body } = await this.client.post<Record<string, unknown>, V1alpha1Application>(
      `api/v1/applications/${appSeg}/sync`,
      null,
      Object.keys(syncRequest).length > 0 ? syncRequest : undefined,
      requestOptions
    );
    return body;
  }

  public async getApplicationResourceTree(
    applicationName: string,
    appNamespace?: string,
    options?: RequestOptions
  ) {
    const appSeg = encodePathSegment(applicationName, 'applicationName');
    const queryParams = appNamespace ? { appNamespace } : undefined;
    const { body } = await this.client.get<V1alpha1ApplicationTree>(
      `api/v1/applications/${appSeg}/resource-tree`,
      queryParams,
      options
    );
    return body;
  }

  public async getApplicationManagedResources(
    applicationName: string,
    filters?: {
      namespace?: string;
      name?: string;
      version?: string;
      group?: string;
      kind?: string;
      appNamespace?: string;
      project?: string;
    },
    options?: RequestOptions
  ) {
    const appSeg = encodePathSegment(applicationName, 'applicationName');
    const { body } = await this.client.get<{ items?: V1alpha1ResourceDiff[] }>(
      `api/v1/applications/${appSeg}/managed-resources`,
      filters,
      options
    );
    return body;
  }

  public async getWorkloadLogs(
    applicationName: string,
    applicationNamespace: string,
    resourceRef: V1alpha1ResourceResult,
    logOptions?: WorkloadLogsOptions,
    requestOptions?: RequestOptions
  ) {
    const appSeg = encodePathSegment(applicationName, 'applicationName');
    const tailLines = Math.min(
      Math.max(logOptions?.tailLines ?? DEFAULT_LOG_TAIL_LINES, 1),
      MAX_LOG_TAIL_LINES
    );
    const maxBytes = logOptions?.maxBytes ?? DEFAULT_LOG_MAX_BYTES;
    const grepNeedle = logOptions?.grep?.trim().toLowerCase();

    const params: Record<string, string | number | boolean | undefined> = {
      appNamespace: applicationNamespace,
      namespace: resourceRef.namespace,
      resourceName: resourceRef.name,
      group: resourceRef.group,
      kind: resourceRef.kind,
      version: resourceRef.version,
      follow: false,
      tailLines
    };
    if (logOptions?.container) {
      params.container = logOptions.container;
    }

    const entries: ApplicationLogEntry[] = [];
    let accumulatedBytes = 0;
    let truncated = false;

    await this.client.getStream<ApplicationLogEntry>(
      `api/v1/applications/${appSeg}/logs`,
      params,
      (chunk) => {
        if (grepNeedle) {
          const content = (chunk.content ?? '').toLowerCase();
          if (!content.includes(grepNeedle)) return true;
        }
        const chunkBytes = Buffer.byteLength(JSON.stringify(chunk), 'utf8');
        if (accumulatedBytes + chunkBytes > maxBytes) {
          truncated = true;
          return false;
        }
        accumulatedBytes += chunkBytes;
        entries.push(chunk);
        return true;
      },
      {
        headers: requestOptions?.headers,
        maxBytes: maxBytes * 4
      }
    );

    return {
      entries,
      returnedLines: entries.length,
      truncated,
      maxBytes
    };
  }

  public async getPodLogs(applicationName: string, podName: string, options?: RequestOptions) {
    const appSeg = encodePathSegment(applicationName, 'applicationName');
    const podSeg = encodePathSegment(podName, 'podName');
    const logs: ApplicationLogEntry[] = [];
    await this.client.getStream<ApplicationLogEntry>(
      `api/v1/applications/${appSeg}/pods/${podSeg}/logs`,
      {
        follow: false,
        tailLines: DEFAULT_LOG_TAIL_LINES
      },
      (chunk) => {
        logs.push(chunk);
      },
      { headers: options?.headers, maxBytes: DEFAULT_LOG_MAX_BYTES * 4 }
    );
    return logs;
  }

  public async getApplicationEvents(
    applicationName: string,
    appNamespace?: string,
    options?: RequestOptions
  ) {
    const appSeg = encodePathSegment(applicationName, 'applicationName');
    const queryParams = appNamespace ? { appNamespace } : undefined;
    const { body } = await this.client.get<V1EventList>(
      `api/v1/applications/${appSeg}/events`,
      queryParams,
      options
    );
    return body;
  }

  public async getResource(
    applicationName: string,
    applicationNamespace: string,
    resourceRef: V1alpha1ResourceResult,
    options?: RequestOptions
  ) {
    const appSeg = encodePathSegment(applicationName, 'applicationName');
    const { body } = await this.client.get<V1alpha1ApplicationResourceResult>(
      `api/v1/applications/${appSeg}/resource`,
      {
        appNamespace: applicationNamespace,
        namespace: resourceRef.namespace,
        resourceName: resourceRef.name,
        group: resourceRef.group,
        kind: resourceRef.kind,
        version: resourceRef.version
      },
      options
    );
    return body.manifest;
  }

  public async getResourceEvents(
    applicationName: string,
    applicationNamespace: string,
    resourceUID: string,
    resourceNamespace: string,
    resourceName: string,
    options?: RequestOptions
  ) {
    const appSeg = encodePathSegment(applicationName, 'applicationName');
    const { body } = await this.client.get<V1EventList>(
      `api/v1/applications/${appSeg}/events`,
      {
        appNamespace: applicationNamespace,
        resourceNamespace,
        resourceUID,
        resourceName
      },
      options
    );
    return body;
  }

  public async getResourceActions(
    applicationName: string,
    applicationNamespace: string,
    resourceRef: V1alpha1ResourceResult,
    options?: RequestOptions
  ) {
    const appSeg = encodePathSegment(applicationName, 'applicationName');
    const { body } = await this.client.get<{ actions: V1alpha1ResourceAction[] }>(
      `api/v1/applications/${appSeg}/resource/actions`,
      {
        appNamespace: applicationNamespace,
        namespace: resourceRef.namespace,
        resourceName: resourceRef.name,
        group: resourceRef.group,
        kind: resourceRef.kind,
        version: resourceRef.version
      },
      options
    );
    return body;
  }

  public async runResourceAction(
    applicationName: string,
    applicationNamespace: string,
    resourceRef: V1alpha1ResourceResult,
    action: string,
    options?: RequestOptions
  ) {
    const appSeg = encodePathSegment(applicationName, 'applicationName');
    const { body } = await this.client.post<string, V1alpha1Application>(
      `api/v1/applications/${appSeg}/resource/actions`,
      {
        appNamespace: applicationNamespace,
        namespace: resourceRef.namespace,
        resourceName: resourceRef.name,
        group: resourceRef.group,
        kind: resourceRef.kind,
        version: resourceRef.version
      },
      action,
      options
    );
    return body;
  }
}
