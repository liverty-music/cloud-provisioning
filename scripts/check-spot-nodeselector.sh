#!/usr/bin/env bash
# Check that all Deployments/StatefulSets/DaemonSets in rendered K8s manifests
# have the autopilot-spot nodeSelector set.
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

  missing=$(python3 -c "
import yaml, sys
with open('$file') as f:
    for doc in yaml.safe_load_all(f):
        if doc is None:
            continue
        kind = doc.get('kind', '')
        if kind not in ('Deployment', 'StatefulSet', 'DaemonSet'):
            continue
        name = doc.get('metadata', {}).get('name', 'unknown')
        ns = doc.get('spec', {}).get('template', {}).get('spec', {}).get('nodeSelector', {})
        if ns.get('cloud.google.com/compute-class') != 'autopilot-spot':
            print(f'{kind}/{name}')
" 2>/dev/null || true)

  if [ -n "$missing" ]; then
    for resource in $missing; do
      echo "ERROR: [${namespace}] ${resource} is missing nodeSelector 'cloud.google.com/compute-class: autopilot-spot'"
    done
    failed=1
  fi
done

if [ "$failed" -eq 1 ]; then
  echo ""
  echo "All dev workloads must use Spot VMs. Add to pod template:"
  echo "  nodeSelector:"
  echo "    cloud.google.com/compute-class: autopilot-spot"
  exit 1
fi

echo "OK: All workloads have autopilot-spot nodeSelector."
