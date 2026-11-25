#!/usr/bin/env bash
set -euo pipefail

KIND_CLUSTER="${KIND_CLUSTER:-kind}"
E2E_NS="mcp-e2e-system"
MCP_AUTH_TOKEN="e2e-inbound-bearer-token-091"
MCP_REQUEST_STATE_SECRET="e2e-shared-mrtr-hmac-secret-across-2-replicas"

echo "==> [Setup 1] Verify Argo CD control plane is ready in kind cluster (${KIND_CLUSTER})"
kubectl rollout status deployment/argocd-server -n argocd --timeout=120s

echo "==> [Setup 2] Apply isolated E2E namespaces, in-cluster Git repo, AppProject, and Applications"
kubectl apply -f deploy/kind/fixtures.yaml
kubectl rollout status deployment/e2e-git-repo -n "${E2E_NS}" --timeout=120s

echo "==> [Setup 3] Export Argo CD TLS cert for NODE_EXTRA_CA_CERTS and mint Argo CD API session token"
TMPDIR_E2E="$(mktemp -d)"
trap 'rm -rf "${TMPDIR_E2E}"' EXIT

kubectl get secret argocd-secret -n argocd -o jsonpath="{.data['tls\.crt']}" | base64 -d > "${TMPDIR_E2E}/tls.crt"
kubectl create secret generic argocd-ca-cert -n "${E2E_NS}" \
  --from-file=tls.crt="${TMPDIR_E2E}/tls.crt" \
  --dry-run=client -o yaml | kubectl apply -f -

ADMIN_PASS="$(kubectl get secret argocd-initial-admin-secret -n argocd -o jsonpath='{.data.password}' | base64 -d)"

# Obtain a live Argo CD JWT token via a short-lived port-forward to argocd-server.
kubectl port-forward -n argocd svc/argocd-server 18443:443 >/dev/null 2>&1 &
PF_ARGO_PID=$!
trap 'kill ${PF_ARGO_PID} >/dev/null 2>&1 || true; rm -rf "${TMPDIR_E2E}"' EXIT

for _ in $(seq 1 30); do
  if curl -sS --cacert "${TMPDIR_E2E}/tls.crt" https://localhost:18443/healthz >/dev/null 2>&1; then
    break
  fi
  sleep 0.3
done

ARGOCD_API_TOKEN="$(
  curl -fsS --cacert "${TMPDIR_E2E}/tls.crt" \
    -X POST https://localhost:18443/api/v1/session \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"admin\",\"password\":\"${ADMIN_PASS}\"}" \
  | node -e "const d = JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.token);"
)"

if [[ -z "${ARGOCD_API_TOKEN}" ]]; then
  echo "FAIL: could not obtain Argo CD API session token" >&2
  exit 1
fi

echo "==> [Setup 4] Hard-refresh apps against live e2e-git-repo, trigger initial sync, and wait for target states"
for APP in e2e-healthy-app e2e-broken-app e2e-denied-app; do
  kubectl annotate application "${APP}" -n argocd argocd.argoproj.io/refresh=hard --overwrite >/dev/null
done

# Wait until e2e-healthy-app is synced & healthy and healthy-large-cm exists
for i in $(seq 1 30); do
  HS="$(kubectl get application e2e-healthy-app -n argocd -o jsonpath='{.status.health.status}/{.status.sync.status}' 2>/dev/null || true)"
  echo "  [wait healthy-app #${i}] status=${HS}"
  if [[ "${HS}" == "Healthy/Synced" ]] && kubectl get configmap healthy-large-cm -n mcp-e2e-ok >/dev/null 2>&1; then
    break
  fi
  kubectl annotate application e2e-healthy-app -n argocd argocd.argoproj.io/refresh=hard --overwrite >/dev/null || true
  sleep 2
done

# Wait until e2e-broken-app is no longer Unknown before syncing
for i in $(seq 1 15); do
  BS="$(kubectl get application e2e-broken-app -n argocd -o jsonpath='{.status.sync.status}' 2>/dev/null || true)"
  echo "  [wait broken-app ready #${i}] sync=${BS}"
  if [[ "${BS}" == "OutOfSync" || "${BS}" == "Synced" ]]; then
    break
  fi
  kubectl annotate application e2e-broken-app -n argocd argocd.argoproj.io/refresh=hard --overwrite >/dev/null || true
  sleep 2
done

# Trigger initial sync on e2e-broken-app so all resources (ConfigMap, Secrets, Services, Deployments) exist in cluster
PREV_SYNC_FINISHED="$(kubectl get application e2e-broken-app -n argocd -o jsonpath='{.status.operationState.finishedAt}' 2>/dev/null || true)"
curl -fsS --max-time 30 --cacert "${TMPDIR_E2E}/tls.crt" \
  -X POST https://localhost:18443/api/v1/applications/e2e-broken-app/sync \
  -H "Authorization: Bearer ${ARGOCD_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"prune":false}' >/dev/null

# Wait for THIS sync operation to complete (new finishedAt timestamp) before applying live drift patches
for i in $(seq 1 30); do
  PHASE="$(kubectl get application e2e-broken-app -n argocd -o jsonpath='{.status.operationState.phase}' 2>/dev/null || true)"
  FINISHED="$(kubectl get application e2e-broken-app -n argocd -o jsonpath='{.status.operationState.finishedAt}' 2>/dev/null || true)"
  echo "  [wait broken-app sync op #${i}] phase=${PHASE} finishedAt=${FINISHED}"
  if [[ -n "${FINISHED}" && "${FINISHED}" != "${PREV_SYNC_FINISHED}" && ( "${PHASE}" == "Succeeded" || "${PHASE}" == "Failed" || "${PHASE}" == "Error" ) ]]; then
    break
  fi
  sleep 1
done

# Wait for sync to create broken-logger Deployment & broken-drift-cm ConfigMap, then wait for Running
for _ in $(seq 1 30); do
  if kubectl get deployment broken-logger -n mcp-e2e-broken >/dev/null 2>&1 && \
     kubectl get configmap broken-drift-cm -n mcp-e2e-broken >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
kubectl rollout status deployment/broken-logger -n mcp-e2e-broken --timeout=90s

# Wait briefly for broken-bad-image to generate a real ImagePullBackOff Warning event
for i in $(seq 1 20); do
  EV="$(kubectl get events -n mcp-e2e-broken --field-selector type=Warning -o name 2>/dev/null || true)"
  if [[ -n "${EV}" ]]; then
    echo "  Observed real Warning event in mcp-e2e-broken"
    break
  fi
  sleep 2
done

# Create genuine live-vs-target OutOfSync drift on broken-drift-cm
kubectl patch configmap broken-drift-cm -n mcp-e2e-broken --type=merge -p '{"data":{"mode":"manual-hotfix"}}'

# Create an unmanaged orphan ConfigMap to verify forced prune=false never deletes unmanaged/extra resources
kubectl create configmap e2e-orphan-cm -n mcp-e2e-broken --from-literal=keep=yes --dry-run=client -o yaml | kubectl apply -f -

# Force hard refresh on e2e-broken-app and wait for Degraded/OutOfSync (progressDeadlineSeconds=10 on broken-bad-image)
for i in $(seq 1 25); do
  kubectl annotate application e2e-broken-app -n argocd argocd.argoproj.io/refresh=hard --overwrite >/dev/null || true
  BHS="$(kubectl get application e2e-broken-app -n argocd -o jsonpath='{.status.health.status}/{.status.sync.status}' 2>/dev/null || true)"
  echo "  [wait broken-app Degraded/OutOfSync #${i}] status=${BHS}"
  if [[ "${BHS}" == "Degraded/OutOfSync" ]]; then
    break
  fi
  sleep 2
done

kill ${PF_ARGO_PID} >/dev/null 2>&1 || true

echo "==> [Setup 5] Deploy 2-replica ghcr.io/lazysnail1024/mcp-for-argocd:0.9.1 into ${E2E_NS} (default read-only core,diagnostics)"
# Clean up legacy argocd-mcp-plus deployment/service if present from earlier runs (same NodePort 30901)
kubectl delete deployment/argocd-mcp-plus service/argocd-mcp-plus -n "${E2E_NS}" --ignore-not-found >/dev/null 2>&1 || true

kubectl create secret generic argocd-mcp-secrets -n "${E2E_NS}" \
  --from-literal=mcp-auth-token="${MCP_AUTH_TOKEN}" \
  --from-literal=mcp-request-state-secret="${MCP_REQUEST_STATE_SECRET}" \
  --from-literal=argocd-api-token="${ARGOCD_API_TOKEN}" \
  --dry-run=client -o yaml | kubectl apply -f -

cat <<EOF > "${TMPDIR_E2E}/registry.json"
[
  { "baseUrl": "https://argocd-server.argocd.svc", "token": "${ARGOCD_API_TOKEN}" }
]
EOF
kubectl create secret generic argocd-mcp-registry -n "${E2E_NS}" \
  --from-file=registry.json="${TMPDIR_E2E}/registry.json" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl apply -f deploy/kind/deployment.yaml
# Ensure default read-only posture even if a prior interrupted run left MCP_TOOLSETS injected
kubectl set env -n "${E2E_NS}" deployment/argocd-mcp MCP_TOOLSETS- >/dev/null 2>&1 || true
# Force rollout restart so pods pick up any freshly loaded local image under the same tag
kubectl rollout restart deployment/argocd-mcp -n "${E2E_NS}"
kubectl rollout status deployment/argocd-mcp -n "${E2E_NS}" --timeout=120s
# Wait briefly so kube-proxy syncs both ready Pod endpoints into iptables/nftables
sleep 3

KIND_NODE_IP="$(docker inspect -f '{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "${KIND_CLUSTER}-control-plane")"
E2E_BASE_URL="http://${KIND_NODE_IP}:30901"
echo "==> [Run E2E] Target NodePort Service URL: ${E2E_BASE_URL}"

E2E_BASE_URL="${E2E_BASE_URL}" \
E2E_MCP_AUTH_TOKEN="${MCP_AUTH_TOKEN}" \
E2E_ARGOCD_TOKEN="${ARGOCD_API_TOKEN}" \
E2E_NAMESPACE="${E2E_NS}" \
node --import ./node_modules/tsx/dist/loader.mjs --test tests/e2e/kind-e2e.test.ts
