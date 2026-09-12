#!/usr/bin/env bash
# Check that all Deployments/StatefulSets/DaemonSets/CronJobs in rendered
# K8s manifests express a Spot-VM scheduling intent.
#
# Accepts, on the pod template spec, EITHER:
#   - a hard nodeSelector (Spot-only):
#       cloud.google.com/gke-spot: "true"            (Standard cluster — dev)
#       cloud.google.com/compute-class: autopilot-spot  (Autopilot — staging/prod)
#   - OR a soft "prefer Spot, fall back to on-demand" nodeAffinity
#     (preferredDuringSchedulingIgnoredDuringExecution on the same key) — the
#     prod availability pattern, where a hard nodeSelector would leave pods
#     Pending during a Spot shortage.
#
# Usage:
#   ./scripts/check-spot-nodeselector.sh /tmp/rendered
#   ./scripts/check-spot-nodeselector.sh /tmp/rendered/nats.yaml
set -euo pipefail

target="${1:?Usage: $0 <directory-or-file>}"

if [ -d "$target" ]; then
  files=("$target"/*.yaml)
else
  files=("$target")
fi

failed=0
for file in "${files[@]}"; do
  [ -f "$file" ] || continue
  namespace=$(basename "$file" .yaml)

  if ! missing=$(python3 - "$file" 2>&1 <<'PYEOF'
import yaml, sys


def _selector_spot(pod):
    ns = pod.get('nodeSelector', {}) or {}
    return (
        ns.get('cloud.google.com/gke-spot') == 'true' or
        ns.get('cloud.google.com/compute-class') == 'autopilot-spot'
    )


def _affinity_spot(pod):
    # Accept a soft "prefer Spot, fall back to on-demand" nodeAffinity as also
    # satisfying the Spot-cost intent — the prod availability pattern, where a
    # hard nodeSelector would strand pods Pending during a Spot shortage.
    terms = (
        (pod.get('affinity', {}) or {})
        .get('nodeAffinity', {})
        .get('preferredDuringSchedulingIgnoredDuringExecution', []) or []
    )
    for t in terms:
        for expr in (t.get('preference', {}) or {}).get('matchExpressions', []) or []:
            key, vals = expr.get('key'), (expr.get('values') or [])
            if key == 'cloud.google.com/gke-spot' and 'true' in vals:
                return True
            if key == 'cloud.google.com/compute-class' and 'autopilot-spot' in vals:
                return True
    return False


def pod_is_spot(pod):
    return _selector_spot(pod) or _affinity_spot(pod)


with open(sys.argv[1]) as f:
    for doc in yaml.safe_load_all(f):
        if doc is None:
            continue
        kind = doc.get('kind', '')
        name = doc.get('metadata', {}).get('name', 'unknown')
        # Deployment, StatefulSet, DaemonSet: spec.template.spec
        if kind in ('Deployment', 'StatefulSet', 'DaemonSet'):
            pod = doc.get('spec', {}).get('template', {}).get('spec', {})
            if not pod_is_spot(pod):
                print(f'{kind}/{name}')
        # CronJob: spec.jobTemplate.spec.template.spec
        elif kind == 'CronJob':
            pod = (
                doc.get('spec', {}).get('jobTemplate', {})
                .get('spec', {}).get('template', {}).get('spec', {})
            )
            if not pod_is_spot(pod):
                print(f'{kind}/{name}')
PYEOF
  ); then
    echo "ERROR: Python check failed for $file: $missing"
    failed=1
    continue
  fi

  if [ -n "$missing" ]; then
    for resource in $missing; do
      echo "ERROR: [${namespace}] ${resource} is missing Spot VM nodeSelector"
    done
    failed=1
  fi
done

if [ "$failed" -eq 1 ]; then
  echo ""
  echo "All workloads must express a Spot intent. Add to the pod template a"
  echo "hard nodeSelector:"
  echo "  nodeSelector:"
  echo "    cloud.google.com/gke-spot: \"true\"          # Standard cluster (dev)"
  echo "    cloud.google.com/compute-class: autopilot-spot  # Autopilot (staging/prod)"
  echo "or, for prod availability, a soft prefer-Spot-with-on-demand-fallback:"
  echo "  affinity:"
  echo "    nodeAffinity:"
  echo "      preferredDuringSchedulingIgnoredDuringExecution:"
  echo "        - weight: 100"
  echo "          preference:"
  echo "            matchExpressions:"
  echo "              - {key: cloud.google.com/gke-spot, operator: In, values: [\"true\"]}"
  exit 1
fi

echo "OK: All workloads have Spot VM nodeSelector."
