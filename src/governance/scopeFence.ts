import { ScopeViolationError } from '../argocd/errors.js';

export type ScopeFenceConfig = {
  allowedProjects?: string[];
  deniedNamespaces?: string[];
};

const parseCsvEnv = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

export class ScopeFence {
  private readonly allowedProjects: Set<string>;
  private readonly deniedNamespaces: Set<string>;

  constructor(config: ScopeFenceConfig = {}) {
    this.allowedProjects = new Set(config.allowedProjects ?? []);
    this.deniedNamespaces = new Set(config.deniedNamespaces ?? []);
  }

  public static fromEnv(env: NodeJS.ProcessEnv = process.env): ScopeFence {
    return new ScopeFence({
      allowedProjects: parseCsvEnv(env.MCP_ALLOWED_PROJECTS),
      deniedNamespaces: parseCsvEnv(env.MCP_DENIED_NAMESPACES)
    });
  }

  public hasRestrictions(): boolean {
    return this.allowedProjects.size > 0 || this.deniedNamespaces.size > 0;
  }

  public isProjectAllowed(project: string | undefined): boolean {
    if (this.allowedProjects.size === 0) return true;
    return typeof project === 'string' && this.allowedProjects.has(project);
  }

  public isNamespaceAllowed(namespace: string | undefined): boolean {
    if (this.deniedNamespaces.size === 0) return true;
    if (!namespace) return true;
    return !this.deniedNamespaces.has(namespace);
  }

  public assertProjectAllowed(project: string | undefined): void {
    if (!this.isProjectAllowed(project)) {
      throw new ScopeViolationError(
        'project',
        project ?? '<unset>',
        `Project "${project ?? '<unset>'}" is not in MCP_ALLOWED_PROJECTS.`
      );
    }
  }

  public assertNamespaceAllowed(namespace: string | undefined): void {
    if (!this.isNamespaceAllowed(namespace)) {
      throw new ScopeViolationError(
        'namespace',
        namespace ?? '<unset>',
        `Namespace "${namespace}" is blocked by MCP_DENIED_NAMESPACES.`
      );
    }
  }

  public assertApplicationAllowed(app: {
    spec?: { project?: string; destination?: { namespace?: string } };
    metadata?: { namespace?: string };
  }): void {
    this.assertProjectAllowed(app.spec?.project);
    this.assertNamespaceAllowed(app.spec?.destination?.namespace);
    this.assertNamespaceAllowed(app.metadata?.namespace);
  }

  public filterApplications<
    T extends {
      spec?: { project?: string; destination?: { namespace?: string } };
      metadata?: { namespace?: string };
    }
  >(apps: T[]): T[] {
    if (!this.hasRestrictions()) return apps;
    return apps.filter(
      (app) =>
        this.isProjectAllowed(app.spec?.project) &&
        this.isNamespaceAllowed(app.spec?.destination?.namespace) &&
        this.isNamespaceAllowed(app.metadata?.namespace)
    );
  }
}
