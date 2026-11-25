import { z } from 'zod';

// Reserved top-level MRTR field names in MCP 2026-07-28.
// Tool input schemas must never declare these keys, or legacy 2025-era inputs
// would be stripped by the dual-era protocol layer.
export const RESERVED_PROTOCOL_PARAM_NAMES = new Set(['inputResponses', 'requestState']);

export const assertNoReservedParamNames = (
  toolName: string,
  shape: Record<string, unknown>
): void => {
  for (const key of Object.keys(shape)) {
    if (RESERVED_PROTOCOL_PARAM_NAMES.has(key)) {
      throw new Error(
        `Tool "${toolName}" declares reserved protocol parameter name "${key}". Rename this parameter.`
      );
    }
  }
};

export const ApplicationNamespaceSchema = z
  .string()
  .min(1)
  .describe(
    'The namespace where the ArgoCD Application resource resides (e.g. "argocd"). ' +
      'This is the namespace of the Application CR itself, not the destination workload namespace.'
  );

export const ResourceRefSchema = z.object({
  uid: z.string().optional().default(''),
  kind: z.string().min(1),
  namespace: z.string().optional().default(''),
  name: z.string().min(1),
  version: z.string().min(1),
  group: z.string().optional().default('')
});

export const SyncOperationResourceSchema = z.object({
  group: z
    .string()
    .optional()
    .describe('Kubernetes API group (empty string for core v1 resources)'),
  kind: z.string().min(1).describe('Kubernetes resource kind (e.g. "Deployment", "ConfigMap")'),
  name: z.string().min(1).describe('Kubernetes resource name'),
  namespace: z.string().optional().describe('Target resource namespace')
});

export const ApplicationSchema = z.object({
  metadata: z.object({
    name: z.string().min(1),
    namespace: ApplicationNamespaceSchema.optional().default('argocd'),
    labels: z.record(z.string(), z.string()).optional(),
    annotations: z.record(z.string(), z.string()).optional()
  }),
  spec: z.object({
    project: z.string().min(1).default('default'),
    source: z.object({
      repoURL: z.string().min(1),
      path: z.string().optional(),
      chart: z.string().optional(),
      targetRevision: z.string().min(1)
    }),
    syncPolicy: z
      .object({
        syncOptions: z.array(z.string()).optional(),
        automated: z
          .object({
            prune: z.boolean().optional(),
            selfHeal: z.boolean().optional()
          })
          .optional(),
        retry: z
          .object({
            limit: z.number().optional(),
            backoff: z
              .object({
                duration: z.string().optional(),
                maxDuration: z.string().optional(),
                factor: z.number().optional()
              })
              .optional()
          })
          .optional()
      })
      .optional(),
    destination: z
      .object({
        server: z.string().optional(),
        namespace: z.string().optional(),
        name: z.string().optional()
      })
      .refine(
        (data: { server?: string; name?: string }) =>
          (!data.server && !!data.name) || (!!data.server && !data.name),
        {
          message: 'Only one of server or name must be specified in destination'
        }
      )
      .describe('Target cluster and namespace. Specify exactly one of server or name.')
  })
});
