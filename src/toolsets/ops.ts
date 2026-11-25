import { z } from 'zod';
import { computeParamsDigest, evaluateMrtrConfirmation } from '../governance/mrtrGate.js';
import {
  ApplicationNamespaceSchema,
  ResourceRefSchema,
  SyncOperationResourceSchema
} from '../shared/models/schema.js';
import type {
  V1alpha1ResourceResult,
  V1alpha1SyncOperationResource
} from '../types/argocd-types.js';
import { appNameField, type ToolDefinition } from './types.js';

export const opsTools: ToolDefinition[] = [
  {
    name: 'run_resource_action',
    toolset: 'ops',
    description:
      'Runs an Argo CD resource action (such as Deployment restart). Subject to MCP_ALLOWED_RESOURCE_ACTIONS allowlist if configured, and MRTR confirmation on 2026-07-28 clients supporting elicitation.',
    inputShape: {
      applicationName: appNameField,
      applicationNamespace: ApplicationNamespaceSchema.optional().default('argocd'),
      resourceRef: ResourceRefSchema,
      action: z.string().min(1).describe('Action name returned by get_resource_actions.')
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
    },
    handler: async (args, { client, requestOptions, mcpCtx, env }) => {
      const applicationName = args.applicationName as string;
      const applicationNamespace = (args.applicationNamespace as string | undefined) ?? 'argocd';
      const resourceRef = args.resourceRef as V1alpha1ResourceResult;
      const action = args.action as string;

      if (env.allowedResourceActions && !env.allowedResourceActions.has(action)) {
        throw new Error(
          `Resource action "${action}" is not permitted by MCP_ALLOWED_RESOURCE_ACTIONS ` +
            `(allowed: ${[...env.allowedResourceActions].join(', ')}).`
        );
      }

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

      const gate = await evaluateMrtrConfirmation({
        era: env.era,
        toolName: 'run_resource_action',
        target: `${applicationName}:${resourceRef.kind}/${resourceRef.name}:${action}`,
        summary: `Confirm running resource action "${action}" on ${resourceRef.kind}/${resourceRef.name} in application "${applicationName}"?`,
        paramsDigest: computeParamsDigest({
          applicationName,
          applicationNamespace,
          kind: resourceRef.kind,
          name: resourceRef.name,
          namespace: resourceRef.namespace,
          action
        }),
        caller: env.caller,
        ctx: mcpCtx,
        stateCodec: env.stateCodec
      });
      if (gate.kind === 'challenge') {
        return gate.result;
      }

      return await client.runResourceAction(
        applicationName,
        applicationNamespace,
        resourceRef,
        action,
        requestOptions
      );
    }
  },
  {
    name: 'sync_application',
    toolset: 'ops',
    description:
      'Triggers an Argo CD sync operation on an application. Supports partial resource syncing via resources[] and dryRun. By default the server enforces prune=false unless MCP_ALLOW_PRUNE=true is explicitly configured.',
    inputShape: {
      applicationName: appNameField,
      applicationNamespace: ApplicationNamespaceSchema.optional(),
      dryRun: z.boolean().optional().describe('Perform a dry-run sync without applying changes.'),
      prune: z
        .boolean()
        .optional()
        .describe(
          'Request resource pruning (forced to false by server policy unless MCP_ALLOW_PRUNE=true).'
        ),
      confirmPrune: z
        .boolean()
        .optional()
        .describe(
          'Required explicit confirmation flag for legacy 2025 clients when MCP_ALLOW_PRUNE=true and prune=true.'
        ),
      revision: z.string().optional().describe('Specific Git revision to sync to.'),
      syncOptions: z
        .array(z.string())
        .optional()
        .describe('Additional Argo CD sync options (e.g. ["CreateNamespace=true"]).'),
      resources: SyncOperationResourceSchema.array()
        .optional()
        .describe('Optional subset of resources to sync instead of the whole application.')
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    },
    handler: async (args, { client, requestOptions, mcpCtx, env }) => {
      const applicationName = args.applicationName as string;
      const applicationNamespace = args.applicationNamespace as string | undefined;
      const dryRun = args.dryRun as boolean | undefined;
      const requestedPrune = args.prune as boolean | undefined;
      const confirmPrune = args.confirmPrune as boolean | undefined;
      const revision = args.revision as string | undefined;
      const syncOptions = args.syncOptions as string[] | undefined;
      const resources = args.resources as V1alpha1SyncOperationResource[] | undefined;

      if (env.scopeFence.hasRestrictions()) {
        const app = await client.getApplication(
          applicationName,
          applicationNamespace,
          undefined,
          requestOptions
        );
        env.scopeFence.assertApplicationAllowed(app);
      }

      // Enforce prune=false unless explicitly opted-in by operator via MCP_ALLOW_PRUNE=true.
      const effectivePrune = env.allowPrune && requestedPrune === true ? true : false;
      const pruneForcedOff = requestedPrune === true && !env.allowPrune;

      if (!dryRun) {
        const gate = await evaluateMrtrConfirmation({
          era: env.era,
          toolName: 'sync_application',
          target: applicationName,
          summary:
            `Confirm syncing Argo CD application "${applicationName}"` +
            `${revision ? ` to revision ${revision}` : ''}` +
            `${resources?.length ? ` (${resources.length} selected resources)` : ''}` +
            ` with prune=${effectivePrune}?`,
          paramsDigest: computeParamsDigest({
            applicationName,
            applicationNamespace,
            effectivePrune,
            revision,
            resourcesCount: resources?.length ?? 0
          }),
          caller: env.caller,
          ctx: mcpCtx,
          stateCodec: env.stateCodec
        });
        if (gate.kind === 'challenge') {
          return gate.result;
        }
        if (gate.kind === 'unsupported_client' && effectivePrune && confirmPrune !== true) {
          throw new Error(
            `Sync with prune=true on "${applicationName}" requires explicit confirmation: pass confirmPrune=true or retry with prune=false.`
          );
        }
      }

      const syncResult = await client.syncApplication(
        applicationName,
        {
          appNamespace: applicationNamespace,
          dryRun,
          prune: effectivePrune,
          revision,
          syncOptions,
          resources
        },
        requestOptions
      );

      return {
        application: syncResult.metadata?.name ?? applicationName,
        effectivePrune,
        ...(pruneForcedOff
          ? {
              policyNote:
                'Requested prune=true was overridden to prune=false because MCP_ALLOW_PRUNE is not enabled.'
            }
          : {}),
        operationState: syncResult.status?.operationState,
        sync: syncResult.status?.sync,
        health: syncResult.status?.health
      };
    }
  }
];
