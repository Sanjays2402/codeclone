# CodeClone makefile. Thin wrappers; the source of truth is the CLI.

.PHONY: help install dev test lint typecheck fmt clean run-serve docker-cpu docker-cuda compose-up helm-lint security

help:
	@grep -E '^[a-zA-Z_-]+:.*?##' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?##"}; {printf "  %-18s %s\n", $$1, $$2}'

install: ## Install runtime deps with uv
	uv pip install -e .

dev: ## Install dev deps with uv
	uv pip install -e ".[dev]"

test: ## Run pytest
	pytest -q

lint: ## Run ruff
	ruff check .

typecheck: ## Run mypy
	mypy

fmt: ## Format with ruff
	ruff format .

clean: ## Remove build + cache artifacts
	rm -rf .pytest_cache .ruff_cache .mypy_cache build dist *.egg-info

run-serve: ## Start serve on :7461 with default mock handle
	codeclone serve --port 7461

docker-cpu: ## Build CPU image
	docker build -t codeclone:cpu -f infra/docker/Dockerfile .

docker-cuda: ## Build CUDA image
	docker build -t codeclone:cuda -f infra/docker/Dockerfile.cuda .

compose-up: ## docker-compose dev stack
	docker compose -f infra/docker/docker-compose.dev.yml up --build

helm-lint: ## Lint the Helm chart
	helm lint infra/helm/codeclone
	helm template codeclone infra/helm/codeclone > /dev/null

security: ## Run the local supply-chain security scan (pip-audit, SBOM, trivy, gitleaks)
	bash scripts/security_scan.sh
