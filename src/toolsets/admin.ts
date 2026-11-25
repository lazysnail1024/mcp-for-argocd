import { z } from 'zod';
import { computeParamsDigest, evaluateMrtrConfirmation } from '../governance/mrtrGate.js';
import { ApplicationNamespaceSchema, ApplicationSchema } from '../shared/models/schema.js';
import type { V1alpha1Application } from '../types/argocd-types.js';
import { appNameField, type ToolDefinition } from './types.js';

export const adminTools: ToolDefinition[] = [
  {
    name: 'create_application',
    toolset: 'admin',
    description: 'Creates a new Argo CD Application resource.',
    inputShape: {
      application: ApplicationSchema
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    },
    handler: async (args, { client, requestOptions, env }) => {
      const application = args.application as V1alpha1Application;
      env.scopeFence.assertApplicationAllowed(application);
      return await client.createApplication(application, requestOptions);
    }
  },
  {
    name: 'delete_application',
    toolset: 'admin',
    description:
      'Deletes an Argo CD Application. On 2026-07-28 clients supporting elicitation this triggers an MRTR confirmation prompt; on legacy 2025 clients confirmApplicationName must exactly match applicationName.',
    inputShape: {
      applicationName: appNameField,
      applicationNamespace: ApplicationNamespaceSchema.optional(),
      cascade: z
        .boolean()
        .optional()
        .describe('Whether to cascade deletion to managed Kubernetes child resources.'),
      propagationPolicy: z
        .string()
        .optional()
        .describe('Deletion propagation policy ("Foreground", "Background", or "Orphan").'),
      confirmApplicationName: z
        .string()
        .optional()
        .describe(
          'Explicit confirmation parameter required on non-elicitation / legacy 2025 clients: must exactly equal applicationName.'
        )
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
    },
    handler: async (args, { client, requestOptions, mcpCtx, env }) => {
      const applicationName = args.applicationName as string;
      const applicationNamespace = args.applicationNamespace as string | undefined;
      const cascade = args.cascade as boolean | undefined;
      const propagationPolicy = args.propagationPolicy as string | undefined;
      const confirmApplicationName = args.confirmApplicationName as string | undefined;

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
        toolName: 'delete_application',
        target: applicationName,
        summary:
          `DESTRUCTIVE ACTION: Confirm deleting Argo CD application "${applicationName}"` +
          `${cascade !== undefined ? ` (cascade=${cascade})` : ''}?`,
        paramsDigest: computeParamsDigest({
          applicationName,
          applicationNamespace,
          cascade,
          propagationPolicy
        }),
        caller: env.caller,
        ctx: mcpCtx,
        stateCodec: env.stateCodec
      });

      if (gate.kind === 'challenge') {
        return gate.result;
      }

      if (gate.kind === 'unsupported_client' && confirmApplicationName !== applicationName) {
        throw new Error(
          `Destructive guard: deleting "${applicationName}" without interactive confirmation requires ` +
            `passing confirmApplicationName="${applicationName}" to verify intent.`
        );
      }

      return await client.deleteApplication(
        applicationName,
        {
          appNamespace: applicationNamespace,
          cascade,
          propagationPolicy
        },
        requestOptions
      );
    }
  },
  {
    name: 'update_application',
    toolset: 'admin',
    description: 'Updates an existing Argo CD Application definition.',
    inputShape: {
      applicationName: appNameField,
      application: ApplicationSchema
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    },
    handler: async (args, { client, requestOptions, env }) => {
      const applicationName = args.applicationName as string;
      const application = args.application as V1alpha1Application;
      env.scopeFence.assertApplicationAllowed(application);
      return await client.updateApplication(applicationName, application, requestOptions);
    }
  }
];
