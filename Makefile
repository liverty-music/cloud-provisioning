.PHONY: lint lint-ts lint-k8s fix test check

## lint: all linters — TypeScript (biome + tsc) and K8s manifests (kustomize + kube-linter + spot check)
lint: lint-ts lint-k8s

## lint-ts: biome check + typecheck for Pulumi code
lint-ts:
	npx biome check src
	npx tsc --noEmit

## lint-k8s: render + kube-linter + spot nodeSelector check for K8s manifests
## Renders all four overlay groups (11 namespaces × 2 envs + 1 cluster × 2 envs = 24 overlays).
## NOTE: explicit listing of the four globs rather than `{dev,prod}` brace expansion.
## Make's default SHELL=/bin/sh is `dash` on Debian-family runners; dash does not
## expand `{dev,prod}`, the literal token would iterate once over a non-existent
## path and the loop would silently lint nothing.
## The output filename includes both namespace and env (`<ns>-<env>.yaml`) so that
## dev and prod rendered files don't collide.
lint-k8s:
	mkdir -p /tmp/rendered
	@for overlay in k8s/namespaces/*/overlays/dev k8s/namespaces/*/overlays/prod k8s/cluster/overlays/dev k8s/cluster/overlays/prod; do \
		namespace=$$(echo "$$overlay" | cut -d'/' -f3); \
		env=$$(basename "$$overlay"); \
		echo "==> Rendering $$namespace ($$env)"; \
		kustomize build --enable-helm "$$overlay" > "/tmp/rendered/$${namespace}-$${env}.yaml" || exit 1; \
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
