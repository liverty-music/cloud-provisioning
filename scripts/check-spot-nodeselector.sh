#!/usr/bin/env bash
# Check that all Deployments/StatefulSets/DaemonSets/CronJobs in rendered
# K8s manifests have the GKE Spot nodeSelector set.
#
# Accepts either label (cluster type depends on environment):
#   cloud.google.com/gke-spot: "true"          (Standard cluster — dev)
#   cloud.google.com/compute-class: autopilot-spot  (Autopilot — staging/prod)
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
with open(sys.argv[1]) as f:
    for doc in yaml.safe_load_all(f):
        if doc is None:
            continue
        kind = doc.get('kind', '')
        name = doc.get('metadata', {}).get('name', 'unknown')
        # Deployment, StatefulSet, DaemonSet: spec.template.spec.nodeSelector
        if kind in ('Deployment', 'StatefulSet', 'DaemonSet'):
            ns = doc.get('spec', {}).get('template', {}).get('spec', {}).get('nodeSelector', {})
            has_spot = (
                ns.get('cloud.google.com/gke-spot') == 'true' or
                ns.get('cloud.google.com/compute-class') == 'autopilot-spot'
            )
            if not has_spot:
                print(f'{kind}/{name}')
        # CronJob: spec.jobTemplate.spec.template.spec.nodeSelector
        elif kind == 'CronJob':
            ns = doc.get('spec', {}).get('jobTemplate', {}).get('spec', {}).get('template', {}).get('spec', {}).get('nodeSelector', {})
            has_spot = (
                ns.get('cloud.google.com/gke-spot') == 'true' or
                ns.get('cloud.google.com/compute-class') == 'autopilot-spot'
            )
            if not has_spot:
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
  echo "All dev workloads must use Spot VMs. Add to pod template:"
  echo "  nodeSelector:"
  echo "    cloud.google.com/gke-spot: \"true\"          # Standard cluster (dev)"
  echo "  or:"
  echo "    cloud.google.com/compute-class: autopilot-spot  # Autopilot (staging/prod)"
  exit 1
fi

echo "OK: All workloads have Spot VM nodeSelector."
