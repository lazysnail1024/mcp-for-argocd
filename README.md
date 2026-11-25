# argocd-mcp (`0.9.1`)

A stateless, dual-era ([MCP `2026-07-28`](https://modelcontextprotocol.io) + `2025-11-25` compatible) Model Context Protocol server for [Argo CD](https://argo-cd.readthedocs.io/en/stable/), hardened for production GitOps diagnostics and multi-replica Kubernetes deployments.

## Highlights

- **Dual-Era Stateless Transport (`stdio` + `/mcp`)**: Built on `@modelcontextprotocol/server` v2. Serves both `2026-07-28` (`server/discover`, per-request `_meta`, `Mcp-Method`/`Mcp-Name`/`Mcp-Param-*` headers, MRTR confirmations) and `2025-xx` (`initialize`) clients without in-memory session maps. Legacy `/sse` transport has been removed.
- **Read-Only by Default (`--toolsets=core,diagnostics`)**: Exposes 14 read-only inspection and SRE triage tools out of the box. Operational (`ops`) and lifecycle (`admin`) tools must be explicitly enabled.
- **High-Signal SRE Curation**:
  - `diagnose_application`: Concurrently fetches Application status, Resource Tree, Application events, and top abnormal child workload `Warning` events; strips `Synced + Healthy` nodes; and adds Argo Rollouts pause hints.
  - `diff_application`: Computes field-level `liveState` vs `targetState` diffs for out-of-sync resources without dumping raw controller metadata.
- **Defense-in-Depth & Payload Governance**:
  - Controlled Argo CD URL builder preventing path traversal and preserving reverse-proxy subpaths (e.g. `https://host/argocd`).
  - Host-bound outbound Token Registry (`ARGOCD_TOKEN_REGISTRY_PATH`) with `mtime` hot-reload for Secret rotation.
  - Strips `metadata.managedFields` and `last-applied-configuration`, fallback-masks `v1/Secret` values (even with `show-secret-value: "true"`), and enforces a 64KB response byte breaker with actionable Agent recovery hints.
  - `sync_application` enforces `prune=false` by default (unless `MCP_ALLOW_PRUNE=true`), with cross-replica HMAC-SHA256 MRTR confirmation on `2026-07-28` clients and explicit parameter guards on legacy `2025` clients.

## Toolsets & Available Tools

Control active toolsets via `--toolsets` / `MCP_TOOLSETS` (default: `core,diagnostics`) and optional `--tools` / `MCP_TOOLS`. Setting `MCP_READ_ONLY=true` always strips `ops` and `admin`.

| Toolset | Default | Tools |
| :--- | :--- | :--- |
| **`core`** | Enabled | `diagnose_application`, `diff_application`, `get_application`, `get_appproject`, `list_applications`, `list_clusters`, `list_projects` |
| **`diagnostics`** | Enabled | `get_application_events`, `get_application_managed_resources`, `get_application_resource_tree`, `get_application_workload_logs`, `get_resource_actions`, `get_resource_events`, `get_resources` |
| **`ops`** | Disabled | `run_resource_action`, `sync_application` |
| **`admin`** | Disabled | `create_application`, `delete_application`, `update_application` |

## Running

### Stdio (Local IDE / CLI)

```json
{
  "mcpServers": {
    "argocd-mcp": {
      "command": "node",
      "args": ["dist/index.js", "stdio"],
      "env": {
        "ARGOCD_BASE_URL": "https://argocd.example.com",
        "ARGOCD_API_TOKEN": "<token>"
      }
    }
  }
}
```

### Stateless HTTP (`/mcp`) & Container Image

Default image repository is configured for personal GHCR publishing (`ghcr.io/lazysnail1024/mcp-for-argocd`, override via `IMAGE_NAME` / `IMAGE_TAG` in `Makefile`):

```bash
# Build slim container image (node:24-slim, UID 1000)
make docker-build

# Run with network exposure + inbound auth + multi-replica MRTR secret
docker run -p 3000:3000 \
  -e MCP_BIND_ADDRESS=0.0.0.0 \
  -e MCP_AUTH_TOKEN="<inbound-token>" \
  -e MCP_REQUEST_STATE_SECRET="<shared-32byte-secret>" \
  -e ARGOCD_BASE_URL="https://argocd.example.com" \
  -e ARGOCD_API_TOKEN="<argocd-token>" \
  ghcr.io/lazysnail1024/mcp-for-argocd:0.9.1 http --stateless --json-response
```

- `--stateless` defaults to `true` and is retained for backwards CLI compatibility with existing deployments.
- `--json-response` defaults to `true`, replying with a single `application/json` body instead of an SSE frame (avoiding the 1 MiB single-event SSE cap in clients such as Python MCP SDK v2). Pass `--no-json-response` to emit legacy SSE streams on 2025-era requests.

### Key Configuration Variables

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `ARGOCD_BASE_URL` | unset | Default Argo CD URL (subpaths like `https://host/argocd` are preserved). |
| `ARGOCD_API_TOKEN` | unset | Outbound Argo CD token bound strictly to `ARGOCD_BASE_URL`. |
| `ARGOCD_TOKEN_REGISTRY_PATH` | unset | JSON file mapping additional `baseUrl` entries to tokens (hot-reloads on `mtime` change). |
| `MCP_BIND_ADDRESS` | `127.0.0.1` | Listener bind address (widening requires `MCP_AUTH_TOKEN` or `--allow-unauthenticated`). |
| `MCP_AUTH_TOKEN` | unset | Inbound bearer token (`Authorization: Bearer <token>`). |
| `MCP_TOOLSETS` | `core,diagnostics` | Enabled static toolsets (`core`, `diagnostics`, `ops`, `admin`, `all`). |
| `MCP_TOOLS` | unset | Optional comma-separated allowlist of specific tool names. |
| `MCP_READ_ONLY` | `false` | When `true`, unconditionally strips `ops` and `admin` toolsets. |
| `MCP_LEGACY_MODE` | `stateless` | `stateless` (Dual-Era compatible) or `reject` (strict `2026-07-28` only). |
| `MCP_ALLOWED_PROJECTS` | unset | Comma-separated Argo CD project allowlist fence. |
| `MCP_DENIED_NAMESPACES` | unset | Comma-separated Kubernetes namespace denylist fence. |
| `MCP_MAX_RESPONSE_BYTES` | `65536` | Hard JSON response size limit (64KB). |
| `MCP_ALLOW_PRUNE` | `false` | Must be `true` to allow `sync_application(prune=true)`. |
| `MCP_ALLOWED_RESOURCE_ACTIONS` | unset | Optional allowlist for `run_resource_action` (e.g. `restart`). |
| `MCP_REQUEST_STATE_SECRET` | ephemeral | Shared HMAC secret across replicas for `2026-07-28` MRTR approvals. |
| `NODE_EXTRA_CA_CERTS` | unset | Path to custom/cluster CA bundle for trusting internal Argo CD TLS certs. |

## Verification & Testing

```bash
# Tier 1 Unit + Tier 2 Dual-Era Protocol Integration Tests
pnpm run lint && pnpm run build && pnpm test

# Tier 3 Black-Box Slim Container Smoke Tests
make test-image

# Tier 4 Live kind Cluster (2 Replicas + Real Argo CD) E2E Acceptance
make test-e2e-kind
```

## Credits

The project was initially created and donated by [@jiachengxu](https://github.com/jiachengxu), [@imwithye](https://github.com/imwithye), [@hwwn](https://github.com/hwwn), and [@alexmt](https://github.com/alexmt) from [Akuity](https://akuity.io/).
