import { readFileSync, statSync } from 'node:fs';
import { logger } from '../logging/logging.js';

// A registry that maps an ArgoCD base URL to the API token that should be used
// for it. It lets a single server target multiple ArgoCD instances — each with
// its own token — without the token ever being passed in a tool-call payload.
//
// When backed by a file (ARGOCD_TOKEN_REGISTRY_PATH), startup is fail-closed
// and subsequent lookups lazily reload the file whenever its mtime changes
// (e.g. Kubernetes Secret volume rotation).
export type TokenRegistryEntry = {
  baseUrl: string;
  token: string;
};

export type TokenRegistryOptions = {
  sourcePath?: string;
  initialMtimeMs?: number;
  reloadCheckIntervalMs?: number;
};

const DEFAULT_RELOAD_CHECK_INTERVAL_MS = 2000;

export class TokenRegistry {
  private tokensByBaseUrl = new Map<string, string>();
  private readonly sourcePath?: string;
  private lastMtimeMs?: number;
  private lastCheckedAt = 0;
  private readonly reloadCheckIntervalMs: number;

  constructor(entries: TokenRegistryEntry[] = [], options: TokenRegistryOptions = {}) {
    this.tokensByBaseUrl = TokenRegistry.buildMap(entries);
    this.sourcePath = options.sourcePath;
    this.lastMtimeMs = options.initialMtimeMs;
    this.reloadCheckIntervalMs = options.reloadCheckIntervalMs ?? DEFAULT_RELOAD_CHECK_INTERVAL_MS;
    this.lastCheckedAt = Date.now();
  }

  private static buildMap(entries: TokenRegistryEntry[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const entry of entries) {
      if (!entry.baseUrl || !entry.token) {
        // Fail closed: a missing baseUrl/token is a misconfigured credential.
        // Never include the token in the error message.
        throw new Error('ArgoCD token registry entry is missing baseUrl or token');
      }
      map.set(TokenRegistry.normalize(entry.baseUrl), entry.token);
    }
    return map;
  }

  // Reload from disk when the backing file's mtime changes. On transient read
  // or parse errors during rotation, preserve the last valid registry state.
  private maybeReload(): void {
    if (!this.sourcePath) return;
    const now = Date.now();
    if (this.reloadCheckIntervalMs > 0 && now - this.lastCheckedAt < this.reloadCheckIntervalMs) {
      return;
    }
    this.lastCheckedAt = now;
    try {
      const stat = statSync(this.sourcePath);
      if (this.lastMtimeMs !== undefined && stat.mtimeMs === this.lastMtimeMs) {
        return;
      }
      const raw = readFileSync(this.sourcePath, 'utf8');
      const parsed = parseRawEntries(raw);
      this.tokensByBaseUrl = TokenRegistry.buildMap(parsed);
      this.lastMtimeMs = stat.mtimeMs;
      logger.info(
        `Reloaded ArgoCD token registry from "${this.sourcePath}" with ${this.tokensByBaseUrl.size} entr${
          this.tokensByBaseUrl.size === 1 ? 'y' : 'ies'
        }`
      );
    } catch (error) {
      logger.warn(
        `Failed to hot-reload ArgoCD token registry from "${this.sourcePath}" (keeping previous entries): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  public getToken(baseUrl: string): string | undefined {
    this.maybeReload();
    if (!baseUrl) return undefined;
    return this.tokensByBaseUrl.get(TokenRegistry.normalize(baseUrl));
  }

  public getSize(): number {
    this.maybeReload();
    return this.tokensByBaseUrl.size;
  }

  public static normalize(baseUrl: string): string {
    const trimmed = baseUrl.trim();
    try {
      const url = new URL(trimmed);
      const origin = url.origin.toLowerCase();
      const path = url.pathname.replace(/\/+$/, '');
      return `${origin}${path}`;
    } catch {
      return trimmed.replace(/\/+$/, '');
    }
  }
}

const parseRawEntries = (raw: string): TokenRegistryEntry[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `ArgoCD token registry file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error('ArgoCD token registry file must contain a JSON array');
  }
  return parsed as TokenRegistryEntry[];
};

export const parseTokenRegistry = (raw: string): TokenRegistry => {
  return new TokenRegistry(parseRawEntries(raw));
};

export const tokenRegistryFromEnv = (
  registryPath: string | undefined = process.env.ARGOCD_TOKEN_REGISTRY_PATH,
  options?: { reloadCheckIntervalMs?: number }
): TokenRegistry => {
  if (!registryPath || !registryPath.trim()) {
    return new TokenRegistry();
  }
  const resolvedPath = registryPath.trim();
  let raw: string;
  let initialMtimeMs: number;
  try {
    initialMtimeMs = statSync(resolvedPath).mtimeMs;
    raw = readFileSync(resolvedPath, 'utf8');
  } catch (error) {
    throw new Error(
      `Failed to read ArgoCD token registry file at "${registryPath}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const entries = parseRawEntries(raw);
  const registry = new TokenRegistry(entries, {
    sourcePath: resolvedPath,
    initialMtimeMs,
    reloadCheckIntervalMs: options?.reloadCheckIntervalMs
  });
  logger.info(
    `Loaded ArgoCD token registry from "${registryPath}" with ${registry.getSize()} entr${
      registry.getSize() === 1 ? 'y' : 'ies'
    }`
  );
  return registry;
};
