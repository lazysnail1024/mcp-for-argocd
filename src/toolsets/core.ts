import { z } from 'zod';
import {
  buildApplicationDiagnosis,
  buildApplicationDiff,
  selectDiagnosticEventNodes
} from '../governance/curation.js';
import { ApplicationNamespaceSchema } from '../shared/models/schema.js';
import { appNameField, projectField, type ToolDefinition } from './types.js';

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};

export const coreTools: ToolDefinition[] = [
  {
    name: 'diagnose_application',
    toolset: 'core',
    description:
      'High-signal SRE diagnostic tool: concurrently fetches Application status, Resource Tree, and Events, strips Synced+Healthy nodes, and returns abnormal resources, operationState errors, Warning events, and progressive-delivery hints. Prefer this tool first when investigating unhealthy or out-of-sync applications.',
    inputShape: {
      applicationName: appNameField,
      applicationNamespace: ApplicationNamespaceSchema.optional()
    },
    annotations: READ_ONLY_ANNOTATIONS,
    handler: async (args, { client, requestOptions, env }) => {
      const applicationName = args.applicationName as string;
      const applicationNamespace = args.applicationNamespace as string | undefined;

      const app = await client.getApplication(
        applicationName,
        applicationNamespace,
        undefined,
        requestOptions
      );
      env.scopeFence.assertApplicationAllowed(app);

      const [tree, appEvents] = await Promise.all([
        client.getApplicationResourceTree(applicationName, applicationNamespace, requestOptions),
        client.getApplicationEvents(applicationName, applicationNamespace, requestOptions)
      ]);

      // Argo CD's /events without resourceUID returns only Application CR events;
      // also fetch events for up to 5 highest-signal abnormal child workloads (e.g. crashing Pods).
      const resolvedAppNs = applicationNamespace ?? app.metadata?.namespace ?? 'argocd';
      const eventNodes = selectDiagnosticEventNodes(app, tree, 5);
      const childEventResults =
        eventNodes.length > 0
          ? await Promise.allSettled(
              eventNodes.map((node) =>
                client.getResourceEvents(
                  applicationName,
                  resolvedAppNs,
                  node.uid,
                  node.namespace,
                  node.name,
                  requestOptions
                )
              )
            )
          : [];

      const mergedItems = [...(appEvents.items ?? [])];
      for (const settled of childEventResults) {
        if (settled.status === 'fulfilled' && settled.value?.items) {
          mergedItems.push(...settled.value.items);
        }
      }

      return buildApplicationDiagnosis(app, tree, { items: mergedItems });
    }
  },
  {
    name: 'diff_application',
    toolset: 'core',
    description:
      'Computes structured field-level configuration diffs between live and target states for out-of-sync managed resources in an Argo CD application, excluding identical resources and Kubernetes controller noise.',
    inputShape: {
      applicationName: appNameField,
      applicationNamespace: ApplicationNamespaceSchema.optional(),
      kind: z.string().optional().describe('Optional Kubernetes resource kind filter.'),
      namespace: z.string().optional().describe('Optional target namespace filter.'),
      name: z.string().optional().describe('Optional resource name filter.')
    },
    annotations: READ_ONLY_ANNOTATIONS,
    handler: async (args, { client, requestOptions, env }) => {
      const applicationName = args.applicationName as string;
      const applicationNamespace = args.applicationNamespace as string | undefined;
      const kind = args.kind as string | undefined;
      const namespace = args.namespace as string | undefined;
      const name = args.name as string | undefined;

      if (env.scopeFence.hasRestrictions()) {
        const app = await client.getApplication(
          applicationName,
          applicationNamespace,
          undefined,
          requestOptions
        );
        env.scopeFence.assertApplicationAllowed(app);
      }
      if (namespace) env.scopeFence.assertNamespaceAllowed(namespace);

      const filters = {
        ...(kind && { kind }),
        ...(namespace && { namespace }),
        ...(name && { name }),
        ...(applicationNamespace && { appNamespace: applicationNamespace })
      };
      const managed = await client.getApplicationManagedResources(
        applicationName,
        Object.keys(filters).length > 0 ? filters : undefined,
        requestOptions
      );
      return buildApplicationDiff(applicationName, managed);
    }
  },
  {
    name: 'get_application',
    toolset: 'core',
    description:
      'Returns detailed status and spec for a single Argo CD application by name (with managedFields noise stripped). Optionally triggers a normal or hard Git refresh.',
    inputShape: {
      applicationName: appNameField,
      applicationNamespace: ApplicationNamespaceSchema.optional(),
      refresh: z
        .enum(['normal', 'hard'])
        .optional()
        .describe(
          'Optional Argo CD refresh mode ("normal" or "hard") to reconcile latest Git state.'
        )
    },
    annotations: READ_ONLY_ANNOTATIONS,
    handler: async (args, { client, requestOptions, env }) => {
      const app = await client.getApplication(
        args.applicationName as string,
        args.applicationNamespace as string | undefined,
        args.refresh as 'normal' | 'hard' | undefined,
        requestOptions
      );
      env.scopeFence.assertApplicationAllowed(app);
      return app;
    }
  },
  {
    name: 'get_appproject',
    toolset: 'core',
    description:
      'Returns an Argo CD AppProject by name, including allowed source repositories, cluster/namespace destinations, and RBAC metadata.',
    inputShape: {
      projectName: projectField.describe('The name of the Argo CD AppProject to fetch.')
    },
    annotations: READ_ONLY_ANNOTATIONS,
    handler: async (args, { client, requestOptions, env }) => {
      const projectName = args.projectName as string;
      env.scopeFence.assertProjectAllowed(projectName);
      return await client.getAppProject(projectName, requestOptions);
    }
  },
  {
    name: 'list_applications',
    toolset: 'core',
    description:
      'Lists Argo CD applications with compact status summaries. Supports server-side case-insensitive substring search by name, project/healthStatus/syncStatus/appNamespace filtering, and offset/limit pagination.',
    inputShape: {
      search: z
        .string()
        .optional()
        .describe('Case-insensitive substring filter on application name.'),
      project: projectField
        .optional()
        .describe('Filter applications belonging to a specific Argo CD project.'),
      healthStatus: z
        .string()
        .optional()
        .describe(
          'Filter by health status (e.g. "Healthy", "Degraded", "Progressing", "Missing").'
        ),
      syncStatus: z
        .string()
        .optional()
        .describe('Filter by sync status (e.g. "Synced", "OutOfSync", "Unknown").'),
      appNamespace: ApplicationNamespaceSchema.optional(),
      limit: z
        .number()
        .int()
        .positive()
        .max(200)
        .optional()
        .describe('Maximum number of applications to return (default 50, max 200).'),
      offset: z.number().int().min(0).optional().describe('Pagination offset (default 0).')
    },
    annotations: READ_ONLY_ANNOTATIONS,
    handler: async (args, { client, requestOptions, env }) => {
      const project = args.project as string | undefined;
      if (project) env.scopeFence.assertProjectAllowed(project);

      const raw = await client.listApplications(
        {
          search: args.search as string | undefined,
          project,
          healthStatus: args.healthStatus as string | undefined,
          syncStatus: args.syncStatus as string | undefined,
          appNamespace: args.appNamespace as string | undefined,
          // When scope fence is active, paginate after applying scope filtering.
          limit: env.scopeFence.hasRestrictions() ? 10000 : (args.limit as number | undefined),
          offset: env.scopeFence.hasRestrictions() ? 0 : (args.offset as number | undefined)
        },
        requestOptions
      );

      if (!env.scopeFence.hasRestrictions()) {
        return raw;
      }

      const permitted = env.scopeFence.filterApplications(raw.items);
      const start = (args.offset as number | undefined) ?? 0;
      const limit = (args.limit as number | undefined) ?? 50;
      const sliced = permitted.slice(start, start + limit);
      return {
        items: sliced,
        metadata: {
          ...raw.metadata,
          totalItems: permitted.length,
          returnedItems: sliced.length,
          offset: start,
          limit,
          hasMore: start + limit < permitted.length
        }
      };
    }
  },
  {
    name: 'list_clusters',
    toolset: 'core',
    description: 'Lists Kubernetes clusters registered with Argo CD.',
    inputShape: {
      server: z.string().optional().describe('Filter clusters by API server URL.'),
      name: z.string().optional().describe('Filter clusters by cluster name.')
    },
    annotations: READ_ONLY_ANNOTATIONS,
    handler: async (args, { client, requestOptions }) =>
      await client.listClusters(
        {
          server: args.server as string | undefined,
          name: args.name as string | undefined
        },
        requestOptions
      )
  },
  {
    name: 'list_projects',
    toolset: 'core',
    description:
      'Lists Argo CD AppProjects with compact summaries (name, description, sourceRepos, destinations).',
    inputShape: {},
    annotations: READ_ONLY_ANNOTATIONS,
    handler: async (_args, { client, requestOptions, env }) => {
      const result = await client.listProjects(requestOptions);
      if (!env.scopeFence.hasRestrictions()) return result;
      const items = result.items.filter((p) => env.scopeFence.isProjectAllowed(p.name));
      return { items, totalItems: items.length };
    }
  }
];
