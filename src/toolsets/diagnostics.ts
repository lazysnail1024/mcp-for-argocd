import { z } from 'zod';
import { summarizeResourceTree } from '../governance/curation.js';
import { ApplicationNamespaceSchema, ResourceRefSchema } from '../shared/models/schema.js';
import type { V1alpha1ResourceResult } from '../types/argocd-types.js';
import { appNameField, projectField, type ToolDefinition } from './types.js';

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};

const MAX_IMPLICIT_GET_RESOURCES = 20;

export const diagnosticsTools: ToolDefinition[] = [
  {
    name: 'get_application_events',
    toolset: 'diagnostics',
    description: 'Returns Kubernetes events associated with an Argo CD application.',
    inputShape: {
      applicationName: appNameField,
      applicationNamespace: ApplicationNamespaceSchema.optional()
    },
    annotations: READ_ONLY_ANNOTATIONS,
    handler: async (args, { client, requestOptions, env }) => {
      const applicationName = args.applicationName as string;
      const applicationNamespace = args.applicationNamespace as string | undefined;
      if (env.scopeFence.hasRestrictions()) {
        const app = await client.getApplication(
          applicationName,
          applicationNamespace,
          undefined,
          requestOptions
        );
        env.scopeFence.assertApplicationAllowed(app);
      }
      return await client.getApplicationEvents(
        applicationName,
        applicationNamespace,
        requestOptions
      );
    }
  },
  {
    name: 'get_application_managed_resources',
    toolset: 'diagnostics',
    description:
      'Returns managed resources for an application with optional filters (kind, namespace, name, group, version). For concise drift analysis prefer diff_application.',
    inputShape: {
      applicationName: appNameField,
      kind: z.string().optional().describe('Filter by Kubernetes resource kind.'),
      namespace: z.string().optional().describe('Filter by Kubernetes namespace.'),
      name: z.string().optional().describe('Filter by resource name.'),
      version: z.string().optional().describe('Filter by resource API version.'),
      group: z.string().optional().describe('Filter by resource API group.'),
      appNamespace: ApplicationNamespaceSchema.optional(),
      project: projectField.optional().describe('Filter by Argo CD project.')
    },
    annotations: READ_ONLY_ANNOTATIONS,
    handler: async (args, { client, requestOptions, env }) => {
      const applicationName = args.applicationName as string;
      const project = args.project as string | undefined;
      const namespace = args.namespace as string | undefined;
      const appNamespace = args.appNamespace as string | undefined;

      if (project) env.scopeFence.assertProjectAllowed(project);
      if (namespace) env.scopeFence.assertNamespaceAllowed(namespace);
      if (env.scopeFence.hasRestrictions()) {
        const app = await client.getApplication(
          applicationName,
          appNamespace,
          undefined,
          requestOptions
        );
        env.scopeFence.assertApplicationAllowed(app);
      }

      const filters = {
        ...(args.kind ? { kind: args.kind as string } : {}),
        ...(namespace ? { namespace } : {}),
        ...(args.name ? { name: args.name as string } : {}),
        ...(args.version ? { version: args.version as string } : {}),
        ...(args.group ? { group: args.group as string } : {}),
        ...(appNamespace ? { appNamespace } : {}),
        ...(project ? { project } : {})
      };
      return await client.getApplicationManagedResources(
        applicationName,
        Object.keys(filters).length > 0 ? filters : undefined,
        requestOptions
      );
    }
  },
  {
    name: 'get_application_resource_tree',
    toolset: 'diagnostics',
    description:
      'Returns the resource tree for an application. Defaults to detailLevel="summary" (counts by Kind plus unhealthy nodes); pass detailLevel="detailed" for the full cleaned tree.',
    inputShape: {
      applicationName: appNameField,
      applicationNamespace: ApplicationNamespaceSchema.optional(),
      detailLevel: z
        .enum(['summary', 'detailed'])
        .optional()
        .default('summary')
        .describe('Output granularity: "summary" (default) or "detailed".')
    },
    annotations: READ_ONLY_ANNOTATIONS,
    handler: async (args, { client, requestOptions, env }) => {
      const applicationName = args.applicationName as string;
      const applicationNamespace = args.applicationNamespace as string | undefined;
      const detailLevel = (args.detailLevel as 'summary' | 'detailed' | undefined) ?? 'summary';

      if (env.scopeFence.hasRestrictions()) {
        const app = await client.getApplication(
          applicationName,
          applicationNamespace,
          undefined,
          requestOptions
        );
        env.scopeFence.assertApplicationAllowed(app);
      }

      const tree = await client.getApplicationResourceTree(
        applicationName,
        applicationNamespace,
        requestOptions
      );
      return detailLevel === 'detailed' ? tree : summarizeResourceTree(tree);
    }
  },
  {
    name: 'get_application_workload_logs',
    toolset: 'diagnostics',
    description:
      'Fetches container logs for a workload managed by an Argo CD application. container is optional for single-container pods; supports tailLines (default 100, max 500), case-insensitive grep filtering, and a 32KB output cap.',
    inputShape: {
      applicationName: appNameField,
      applicationNamespace: ApplicationNamespaceSchema.optional().default('argocd'),
      resourceRef: ResourceRefSchema,
      container: z
        .string()
        .optional()
        .describe('Optional container name (required only for multi-container pods).'),
      tailLines: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .default(100)
        .describe('Number of trailing log lines to retrieve (default 100, max 500).'),
      grep: z
        .string()
        .optional()
        .describe('Optional case-insensitive substring filter applied to log lines on the server.')
    },
    annotations: READ_ONLY_ANNOTATIONS,
    handler: async (args, { client, requestOptions, env }) => {
      const applicationName = args.applicationName as string;
      const applicationNamespace = (args.applicationNamespace as string | undefined) ?? 'argocd';
      const resourceRef = args.resourceRef as V1alpha1ResourceResult;

      env.scopeFence.assertNamespaceAllowed(resourceRef.namespace);
      if (env.scopeFence.hasRestrictions()) {
        const app = await client.getApplication(
          applicationName,
          applicationNamespace,
          undefined,
          requestOptions
        );
        env.scopeFence.assertApplicationAllowed(app);
      }

      return await client.getWorkloadLogs(
        applicationName,
        applicationNamespace,
        resourceRef,
        {
          container: args.container as string | undefined,
          tailLines: args.tailLines as number | undefined,
          grep: args.grep as string | undefined
        },
        requestOptions
      );
    }
  },
  {
    name: 'get_resource_actions',
    toolset: 'diagnostics',
    description:
      'Lists available custom actions for a Kubernetes resource managed by an application.',
    inputShape: {
      applicationName: appNameField,
      applicationNamespace: ApplicationNamespaceSchema.optional().default('argocd'),
      resourceRef: ResourceRefSchema
    },
    annotations: READ_ONLY_ANNOTATIONS,
    handler: async (args, { client, requestOptions, env }) => {
      const applicationName = args.applicationName as string;
      const applicationNamespace = (args.applicationNamespace as string | undefined) ?? 'argocd';
      const resourceRef = args.resourceRef as V1alpha1ResourceResult;

      env.scopeFence.assertNamespaceAllowed(resourceRef.namespace);
      if (env.scopeFence.hasRestrictions()) {
        const app = await client.getApplication(
          applicationName,
          applicationNamespace,
          undefined,
          requestOptions
        );
        env.scopeFence.assertApplicationAllowed(app);
      }

      return await client.getResourceActions(
        applicationName,
        applicationNamespace,
        resourceRef,
        requestOptions
      );
    }
  },
  {
    name: 'get_resource_events',
    toolset: 'diagnostics',
    description: 'Returns Kubernetes events for a specific resource managed by an application.',
    inputShape: {
      applicationName: appNameField,
      applicationNamespace: ApplicationNamespaceSchema.optional().default('argocd'),
      resourceUID: z.string().min(1),
      resourceNamespace: z.string(),
      resourceName: z.string().min(1)
    },
    annotations: READ_ONLY_ANNOTATIONS,
    handler: async (args, { client, requestOptions, env }) => {
      const applicationName = args.applicationName as string;
      const applicationNamespace = (args.applicationNamespace as string | undefined) ?? 'argocd';
      const resourceNamespace = args.resourceNamespace as string;

      env.scopeFence.assertNamespaceAllowed(resourceNamespace);
      if (env.scopeFence.hasRestrictions()) {
        const app = await client.getApplication(
          applicationName,
          applicationNamespace,
          undefined,
          requestOptions
        );
        env.scopeFence.assertApplicationAllowed(app);
      }

      return await client.getResourceEvents(
        applicationName,
        applicationNamespace,
        args.resourceUID as string,
        resourceNamespace,
        args.resourceName as string,
        requestOptions
      );
    }
  },
  {
    name: 'get_resources',
    toolset: 'diagnostics',
    description:
      'Returns cleaned live manifests for resources specified by resourceRefs (managedFields stripped; Secret values fallback-masked). When resourceRefs is omitted, refuses unbounded fetch if the application has more than 20 nodes.',
    inputShape: {
      applicationName: appNameField,
      applicationNamespace: ApplicationNamespaceSchema.optional().default('argocd'),
      resourceRefs: ResourceRefSchema.array().optional()
    },
    annotations: READ_ONLY_ANNOTATIONS,
    handler: async (args, { client, requestOptions, env }) => {
      const applicationName = args.applicationName as string;
      const applicationNamespace = (args.applicationNamespace as string | undefined) ?? 'argocd';
      let refs = (args.resourceRefs as V1alpha1ResourceResult[] | undefined) ?? [];

      if (env.scopeFence.hasRestrictions()) {
        const app = await client.getApplication(
          applicationName,
          applicationNamespace,
          undefined,
          requestOptions
        );
        env.scopeFence.assertApplicationAllowed(app);
      }

      if (refs.length === 0) {
        const tree = await client.getApplicationResourceTree(
          applicationName,
          applicationNamespace,
          requestOptions
        );
        const nodes = tree.nodes ?? [];
        if (nodes.length > MAX_IMPLICIT_GET_RESOURCES) {
          throw new Error(
            `Application "${applicationName}" contains ${nodes.length} resources (exceeds implicit fetch limit of ${MAX_IMPLICIT_GET_RESOURCES}). ` +
              'Pass explicit resourceRefs or call diagnose_application / get_application_resource_tree(detailLevel="summary") first to pick target resources.'
          );
        }
        refs = nodes.map((node) => ({
          uid: node.uid ?? '',
          version: node.version ?? 'v1',
          group: node.group ?? '',
          kind: node.kind ?? '',
          name: node.name ?? '',
          namespace: node.namespace ?? ''
        }));
      }

      for (const ref of refs) {
        env.scopeFence.assertNamespaceAllowed(ref.namespace);
      }

      const manifests = await Promise.all(
        refs.map((ref) =>
          client.getResource(applicationName, applicationNamespace, ref, requestOptions)
        )
      );

      // Parse manifest JSON strings into objects so sanitizer and callers get clean structured JSON.
      return manifests.map((raw) => {
        if (typeof raw !== 'string') return raw;
        try {
          return JSON.parse(raw) as unknown;
        } catch {
          return raw;
        }
      });
    }
  }
];
