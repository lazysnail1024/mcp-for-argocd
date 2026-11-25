export class PathValidationError extends Error {
  public readonly fieldName: string;

  constructor(fieldName: string, message: string) {
    super(message);
    this.name = 'PathValidationError';
    this.fieldName = fieldName;
  }
}

export class ArgoCDApiError extends Error {
  public readonly status: number;
  public readonly argoCode?: number;
  public readonly details?: string;

  constructor(status: number, message: string, argoCode?: number, details?: string) {
    super(message);
    this.name = 'ArgoCDApiError';
    this.status = status;
    this.argoCode = argoCode;
    this.details = details;
  }
}

export class ResponseSizeLimitError extends Error {
  public readonly actualBytes: number;
  public readonly limitBytes: number;
  public readonly toolName: string;

  constructor(toolName: string, actualBytes: number, limitBytes: number) {
    super(
      `Response from "${toolName}" (${actualBytes} bytes) exceeded the ${limitBytes}-byte safety limit.`
    );
    this.name = 'ResponseSizeLimitError';
    this.toolName = toolName;
    this.actualBytes = actualBytes;
    this.limitBytes = limitBytes;
  }
}

export class ScopeViolationError extends Error {
  public readonly dimension: 'project' | 'namespace';
  public readonly value: string;

  constructor(dimension: 'project' | 'namespace', value: string, message: string) {
    super(message);
    this.name = 'ScopeViolationError';
    this.dimension = dimension;
    this.value = value;
  }
}

export type ErrorTranslationContext = {
  toolName?: string;
  applicationName?: string;
  projectName?: string;
};

// Rewrite backend and governance errors into actionable instructions that guide
// the Agent to recover using currently registered MCP tools instead of halting.
export const translateErrorForAgent = (
  error: unknown,
  context: ErrorTranslationContext = {}
): string => {
  if (error instanceof PathValidationError) {
    return (
      `Invalid parameter "${error.fieldName}": ${error.message} ` +
      'Call list_applications or list_projects to obtain valid resource identifiers and retry.'
    );
  }

  if (error instanceof ScopeViolationError) {
    return (
      `Access blocked by server scope policy (${error.dimension}="${error.value}"): ${error.message} ` +
      'Call list_projects or list_applications to inspect resources within the allowed scope.'
    );
  }

  if (error instanceof ResponseSizeLimitError) {
    return (
      `Response from ${error.toolName} (${error.actualBytes} bytes) exceeded the ${error.limitBytes}-byte limit and was blocked to protect context stability. ` +
      'Do not retry with the same unbounded query. Instead: ' +
      'call diagnose_application for an unhealthy-only summary, ' +
      'call diff_application for compact configuration diffs, ' +
      'pass detailLevel="summary" to get_application_resource_tree, ' +
      'or narrow filters using kind, name, resourceRefs, tailLines, or grep.'
    );
  }

  if (error instanceof ArgoCDApiError) {
    const appHint = context.applicationName ? ` "${context.applicationName}"` : '';
    const searchHint = context.applicationName
      ? `list_applications(search="${context.applicationName}")`
      : 'list_applications';

    if (error.status === 404) {
      return (
        `Argo CD returned HTTP 404 (not found)${appHint}: ${error.message}. ` +
        `Do not guess resource names; call ${searchHint} or list_projects to verify the exact name and applicationNamespace, then retry.`
      );
    }

    if (error.status === 401) {
      return (
        `Argo CD rejected authentication (HTTP 401): ${error.message}. ` +
        'The configured outbound Argo CD credential is invalid or expired for this target instance.'
      );
    }

    if (error.status === 403) {
      return (
        `Argo CD RBAC denied this operation (HTTP 403)${appHint}: ${error.message}. ` +
        'Call list_projects or list_applications to check which projects and applications are permitted for this credential.'
      );
    }

    if (error.status === 400 || error.status === 422) {
      return (
        `Argo CD rejected the request parameters (HTTP ${error.status}): ${error.message}. ` +
        'Check required fields such as applicationNamespace, resourceRef (group/version/kind/namespace/name), or container name and retry.'
      );
    }

    if (error.status >= 500) {
      return (
        `Argo CD API server returned HTTP ${error.status}: ${error.message}. ` +
        'Retry the read-only query or call list_applications(limit=1) to verify Argo CD API availability.'
      );
    }

    return `Argo CD API error (HTTP ${error.status}): ${error.message}`;
  }

  return error instanceof Error ? error.message : String(error);
};
