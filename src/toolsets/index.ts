import type { McpServer } from '@modelcontextprotocol/server';
import { adminTools } from './admin.js';
import { coreTools } from './core.js';
import { diagnosticsTools } from './diagnostics.js';
import { opsTools } from './ops.js';
import {
  ALL_TOOLSETS,
  DEFAULT_TOOLSETS,
  registerToolDefinition,
  WRITE_TOOLSETS,
  type ToolDefinition,
  type ToolExecutionEnv,
  type ToolsetName
} from './types.js';

export type ToolSelectionConfig = {
  toolsets?: string | ToolsetName[];
  tools?: string | string[];
  readOnly?: boolean;
};

const ALL_DEFINITIONS: readonly ToolDefinition[] = [
  ...coreTools,
  ...diagnosticsTools,
  ...opsTools,
  ...adminTools
].sort((a, b) => a.name.localeCompare(b.name));

const VALID_TOOLSET_SET = new Set<string>(ALL_TOOLSETS);

const splitCsv = (raw: string | string[] | undefined): string[] => {
  if (!raw) return [];
  const items = Array.isArray(raw) ? raw : raw.split(',');
  return items.map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
};

export const resolveEnabledToolsets = (
  config: ToolSelectionConfig = {},
  env: NodeJS.ProcessEnv = process.env
): Set<ToolsetName> => {
  const readOnly =
    config.readOnly !== undefined
      ? config.readOnly
      : String(env.MCP_READ_ONLY ?? '')
          .trim()
          .toLowerCase() === 'true';

  const rawList = splitCsv(config.toolsets ?? env.MCP_TOOLSETS);
  const selected = new Set<ToolsetName>();

  if (rawList.length === 0) {
    for (const ts of DEFAULT_TOOLSETS) selected.add(ts);
  } else {
    for (const entry of rawList) {
      if (entry === 'all') {
        for (const ts of ALL_TOOLSETS) selected.add(ts);
      } else if (VALID_TOOLSET_SET.has(entry)) {
        selected.add(entry as ToolsetName);
      } else {
        throw new Error(
          `Unknown toolset "${entry}". Valid toolsets: ${ALL_TOOLSETS.join(', ')}, all.`
        );
      }
    }
  }

  // MCP_READ_ONLY=true has the highest precedence and always strips write toolsets.
  if (readOnly) {
    for (const writeTs of WRITE_TOOLSETS) {
      selected.delete(writeTs);
    }
  }

  return selected;
};

export const resolveSelectedTools = (
  config: ToolSelectionConfig = {},
  env: NodeJS.ProcessEnv = process.env
): ToolDefinition[] => {
  const enabledToolsets = resolveEnabledToolsets(config, env);
  const explicitToolAllowlist = new Set(splitCsv(config.tools ?? env.MCP_TOOLS));

  if (explicitToolAllowlist.size > 0) {
    const knownNames = new Set(ALL_DEFINITIONS.map((t) => t.name));
    for (const requested of explicitToolAllowlist) {
      if (!knownNames.has(requested)) {
        throw new Error(`Unknown tool "${requested}" in --tools / MCP_TOOLS.`);
      }
    }
  }

  return ALL_DEFINITIONS.filter((def) => {
    if (!enabledToolsets.has(def.toolset)) return false;
    if (explicitToolAllowlist.size > 0 && !explicitToolAllowlist.has(def.name)) return false;
    return true;
  });
};

export const registerEnabledToolsets = (
  server: McpServer,
  env: ToolExecutionEnv,
  selection?: ToolSelectionConfig
): ToolDefinition[] => {
  const selected = resolveSelectedTools(selection);
  for (const def of selected) {
    registerToolDefinition(server, def, env);
  }
  return selected;
};

export { ALL_DEFINITIONS, ALL_TOOLSETS, DEFAULT_TOOLSETS };
export type { ToolDefinition, ToolExecutionEnv, ToolsetName };
