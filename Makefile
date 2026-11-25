PNPM ?= $(shell command -v pnpm 2>/dev/null || echo "npx -y pnpm@10.34.1")
PORT ?= 3000
IMAGE_NAME ?= argocd-mcp-plus
IMAGE_TAG ?= 0.9.1
IMAGE := $(IMAGE_NAME):$(IMAGE_TAG)
DOCKER_BUILD_FLAGS ?= --network=host
KIND_CLUSTER ?= kind

.DEFAULT_GOAL := help
.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| sort \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

node_modules: pnpm-lock.yaml package.json
	$(PNPM) install
	@touch node_modules

.PHONY: install
install: node_modules ## Install dependencies

.PHONY: lint
lint: node_modules ## Run the linter
	$(PNPM) run lint

.PHONY: test
test: node_modules ## Run Tier 1 unit & Tier 2 protocol integration tests
	$(PNPM) test

.PHONY: build
build: node_modules ## Build the distribution bundle
	$(PNPM) run build

.PHONY: run
run: build ## Build and run stateless HTTP server locally
	node dist/index.js http --port $(PORT)

.PHONY: dev
dev: node_modules ## Run the server from source with live reload (HTTP)
	$(PNPM) run dev -- --port $(PORT)

.PHONY: docker-build
docker-build: ## Build production slim container image ($(IMAGE))
	docker build $(DOCKER_BUILD_FLAGS) -t $(IMAGE) .

.PHONY: test-image
test-image: docker-build ## Run Tier 3 black-box container smoke tests against $(IMAGE)
	IMAGE=$(IMAGE) bash scripts/test-image.sh

.PHONY: kind-load
kind-load: docker-build ## Load $(IMAGE) into local kind cluster ($(KIND_CLUSTER))
	kind load docker-image $(IMAGE) --name $(KIND_CLUSTER)

.PHONY: test-e2e-kind
test-e2e-kind: kind-load ## Run Tier 4 live kind cluster + real Argo CD E2E acceptance suite
	IMAGE=$(IMAGE) KIND_CLUSTER=$(KIND_CLUSTER) bash scripts/run-e2e-kind.sh

.PHONY: clean-e2e-kind
clean-e2e-kind: ## Remove isolated E2E namespaces and target apps from kind cluster
	kubectl delete -f deploy/kind/deployment.yaml --ignore-not-found
	kubectl delete -f deploy/kind/fixtures.yaml --ignore-not-found
