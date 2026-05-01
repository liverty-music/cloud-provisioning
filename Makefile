.PHONY: lint lint-ts lint-k8s fix test check

## lint: all linters — TypeScript (biome + tsc) and K8s manifests (kustomize + kube-linter + spot check)
lint: lint-ts lint-k8s

## lint-ts: biome check + typecheck for Pulumi code
lint-ts:
	npx biome check src
	npx tsc --noEmit

## lint-k8s: render + kube-linter + spot nodeSelector check for K8s manifests
lint-k8s:
	mkdir -p /tmp/rendered
	@for overlay in k8s/namespaces/*/overlays/dev; do \
		namespace=$$(echo "$$overlay" | cut -d'/' -f3); \
		echo "==> Rendering $$namespace"; \
		kustomize build --enable-helm "$$overlay" > "/tmp/rendered/$${namespace}.yaml" || exit 1; \
	done
	kube-linter lint /tmp/rendered --config .kube-linter.yaml
	./scripts/check-spot-nodeselector.sh /tmp/rendered

## fix: auto-fix formatting (biome)
fix:
	npx biome check --write src

## test: vitest unit tests
test:
	npm test

## check: full pre-commit check (lint-ts + test; lint-k8s requires kustomize/kube-linter)
check: lint-ts test
