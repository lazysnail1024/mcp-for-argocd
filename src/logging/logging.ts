import { pino } from 'pino';
import { stderr } from 'process';

export const logger = pino(pino.destination(stderr));

export type ToolAuditEntry = {
  caller?: string;
  tool: string;
  argocdBaseUrl?: string;
  applicationName?: string;
  project?: string;
  protocolVersion?: string;
  durationMs: number;
  isError: boolean;
  errorType?: string;
};

// Emit a single-line sanitized structured JSON audit record on stderr.
// Tokens and credentials are never accepted or logged here.
export const logToolAudit = (entry: ToolAuditEntry): void => {
  logger.info({ event: 'mcp_tool_call', ...entry });
};
