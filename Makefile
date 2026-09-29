.PHONY: lint lint-ts lint-k8s fix test check

## lint: all linters — TypeScript (biome + tsc) and K8s manifests (kustomize + kube-linter + spot check)
lint: lint-ts lint-k8s

## lint-ts: biome check + typecheck for Pulumi code
lint-ts:
	npx biome check src
	npx tsc --noEmit

## lint-k8s: render + kube-linter + spot nodeSelector check + CRD version/schema validation for K8s manifests
## Renders all four overlay groups (11 namespaces × 2 envs + 1 cluster × 2 envs = 24 overlays).
## NOTE: explicit listing of the four globs rather than `{dev,prod}` brace expansion.
## Make's default SHELL=/bin/sh is `dash` on Debian-family runners; dash does not
## expand `{dev,prod}`, the literal token would iterate once over a non-existent
## path and the loop would silently lint nothing.
## The output filename includes both namespace and env (`<ns>-<env>.yaml`) so that
## dev and prod rendered files don't collide.
# Schema validation (kubeconform) inputs.
# KUBERNETES_VERSION: the minor both GKE clusters run; bump with the clusters.
# CRDS_CATALOG_REF: datreeio/CRDs-catalog pinned to a commit, used only for
# kinds whose CRDs are not rendered here (Gateway API, NACK, GKE-managed).
# Rendered CRDs are checked against their own served versions first by
# scripts/check-crd-versions.py, which is what catches an unserved apiVersion.
KUBERNETES_VERSION ?= 1.35.0
CRDS_CATALOG_REF ?= ad3b08c5045129d7bb1eeffd8e61719b2c8dd1e2

lint-k8s:
	mkdir -p /tmp/rendered
	@for overlay in k8s/namespaces/*/overlays/dev k8s/namespaces/*/overlays/prod k8s/cluster/overlays/dev k8s/cluster/overlays/prod; do \
		namespace=$$(echo "$$overlay" | cut -d'/' -f3); \
		env=$$(basename "$$overlay"); \
		echo "==> Rendering $$namespace ($$env)"; \
		kustomize build --enable-helm --load-restrictor=LoadRestrictionsNone "$$overlay" > "/tmp/rendered/$${namespace}-$${env}.yaml" || exit 1; \
	done
	kube-linter lint /tmp/rendered --config .kube-linter.yaml
	./scripts/check-spot-nodeselector.sh /tmp/rendered
	rm -rf /tmp/crd-schemas
	./scripts/check-crd-versions.py /tmp/rendered /tmp/crd-schemas
	kubeconform -summary -strict \
		-kubernetes-version $(KUBERNETES_VERSION) \
		-skip CustomResourceDefinition \
		-schema-location default \
		-schema-location '/tmp/crd-schemas/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
		-schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/$(CRDS_CATALOG_REF)/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
		/tmp/rendered

## fix: auto-fix formatting (biome)
fix:
	npx biome check --write src

## test: vitest unit tests
test:
	npm test

## check: full pre-commit check (lint-ts + test; lint-k8s requires kustomize/kube-linter)
check: lint-ts test
