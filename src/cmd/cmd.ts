import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import {
  connectStdioTransport,
  connectHttpTransport,
  type CommonServerOptions,
  type LegacyMode,
  type TransportOptions
} from '../server/transport.js';
import { DEFAULT_BIND_ADDRESS } from '../server/security.js';
import { logger } from '../logging/logging.js';

const serverOptions = <T>(y: Argv<T>) =>
  y
    .option('toolsets', {
      type: 'string',
      default: process.env.MCP_TOOLSETS || 'core,diagnostics',
      description:
        'Comma-separated list of enabled toolsets (core, diagnostics, ops, admin, or all). Defaults to read-only "core,diagnostics".'
    })
    .option('tools', {
      type: 'string',
      default: process.env.MCP_TOOLS || '',
      description: 'Optional comma-separated allowlist of specific tool names to expose.'
    })
    .option('legacy-mode', {
      type: 'string',
      choices: ['stateless', 'reject'] as const,
      default: (process.env.MCP_LEGACY_MODE || 'stateless') as LegacyMode,
      description:
        'How to handle pre-2026-07-28 MCP clients: "stateless" (default, dual-era compatible) or "reject" (strict 2026-07-28 only).'
    });

// Options shared by the HTTP network listener. The inbound token is env-only:
// argv is readable by every user on the machine via `ps`.
const listenerOptions = <T>(y: Argv<T>) =>
  serverOptions(y)
    .option('port', {
      type: 'number',
      default: 3000
    })
    .option('bind-address', {
      type: 'string',
      default: process.env.MCP_BIND_ADDRESS || DEFAULT_BIND_ADDRESS,
      description:
        'Address to listen on. Defaults to loopback; widening it exposes ArgoCD tools to the network and requires MCP_AUTH_TOKEN or --allow-unauthenticated.'
    })
    .option('allowed-host-header', {
      type: 'array',
      string: true,
      default: [] as string[],
      description:
        'Additional hostname accepted in a request Host header. Repeatable. Loopback names are always accepted.'
    })
    .option('allowed-origin', {
      type: 'array',
      string: true,
      default: [] as string[],
      description:
        'Additional browser origin accepted in the Origin header, e.g. https://ide.example. Repeatable.'
    })
    .nargs('allowed-host-header', 1)
    .nargs('allowed-origin', 1)
    .option('allow-unauthenticated', {
      type: 'boolean',
      default: false,
      description:
        'Permit a non-loopback bind without MCP_AUTH_TOKEN. Only use when protected by an external proxy or mesh.'
    })
    // Retained as default=true for smooth CLI compatibility with existing `http --stateless` deployments.
    .option('stateless', {
      type: 'boolean',
      default: true,
      description:
        'HTTP transport is always stateless. Retained (default: true) for backwards CLI compatibility.'
    })
    .check(({ port }) => {
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        const shown = Number.isNaN(port) ? 'not a number' : port;
        throw new Error(`Invalid --port value: ${shown}. Expected an integer between 1 and 65535.`);
      }
      return true;
    });

type ServerArgv = {
  toolsets: string;
  tools: string;
  legacyMode: LegacyMode;
};

type ListenerArgv = ServerArgv & {
  port: number;
  bindAddress: string;
  allowedHostHeader: string[];
  allowedOrigin: string[];
  allowUnauthenticated: boolean;
  stateless: boolean;
};

const commonServerOptions = (argv: ServerArgv): CommonServerOptions => ({
  toolsets: argv.toolsets,
  tools: argv.tools,
  legacyMode: argv.legacyMode
});

const transportOptions = (argv: ListenerArgv): TransportOptions => ({
  ...commonServerOptions(argv),
  port: argv.port,
  bindAddress: argv.bindAddress,
  allowedHostHeaders: argv.allowedHostHeader,
  allowedOrigins: argv.allowedOrigin,
  authToken: process.env.MCP_AUTH_TOKEN,
  allowUnauthenticated: argv.allowUnauthenticated,
  stateless: argv.stateless
});

const start = (run: () => void) => {
  try {
    run();
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
};

export const cmd = () => {
  const exe = yargs(hideBin(process.argv));

  exe.command('stdio', 'Start argocd-mcp-plus server using stdio.', serverOptions, (argv) =>
    start(() => connectStdioTransport(commonServerOptions(argv as ServerArgv)))
  );

  exe.command(
    'http',
    'Start argocd-mcp-plus server using stateless Streamable HTTP (/mcp).',
    listenerOptions,
    (argv) => start(() => connectHttpTransport(transportOptions(argv as ListenerArgv)))
  );

  // Strict parsing ensures misspelled security flags or removed commands (like `sse`)
  // fail loudly at startup rather than being silently ignored.
  exe.strict().demandCommand().parseSync();
};
