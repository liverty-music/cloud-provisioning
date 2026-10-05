// Check that all Deployments/StatefulSets/DaemonSets/CronJobs in rendered
// K8s manifests express a Spot-VM scheduling intent.
//
// Accepts, on the pod template spec, EITHER:
//   - a hard nodeSelector (Spot-only):
//       cloud.google.com/gke-spot: "true"            (Standard cluster — dev)
//       cloud.google.com/compute-class: autopilot-spot  (Autopilot — staging/prod)
//   - OR a soft "prefer Spot, fall back to on-demand" nodeAffinity
//     (preferredDuringSchedulingIgnoredDuringExecution on the same key) — the
//     prod availability pattern, where a hard nodeSelector would leave pods
//     Pending during a Spot shortage.
//
// Usage:
//   node scripts/check-spot-nodeselector.ts /tmp/rendered
//   node scripts/check-spot-nodeselector.ts /tmp/rendered/nats.yaml
import { basename } from 'node:path'
import {
	asArray,
	get,
	loadRendered,
	type Manifest,
} from './rendered-manifests.ts'

// Label key → value that marks a node as Spot.
const SPOT_LABELS: Record<string, string> = {
	'cloud.google.com/gke-spot': 'true',
	'cloud.google.com/compute-class': 'autopilot-spot',
}

function selectorIsSpot(pod: unknown): boolean {
	const selector = get(pod, 'nodeSelector')
	return Object.entries(SPOT_LABELS).some(
		([key, value]) => get(selector, key) === value,
	)
}

function affinityIsSpot(pod: unknown): boolean {
	const terms = asArray(
		get(
			pod,
			'affinity',
			'nodeAffinity',
			'preferredDuringSchedulingIgnoredDuringExecution',
		),
	)
	return terms.some((term) =>
		asArray(get(term, 'preference', 'matchExpressions')).some((expr) => {
			const key = get(expr, 'key')
			return (
				typeof key === 'string' &&
				key in SPOT_LABELS &&
				asArray(get(expr, 'values')).includes(SPOT_LABELS[key])
			)
		}),
	)
}

export function podIsSpot(pod: unknown): boolean {
	return selectorIsSpot(pod) || affinityIsSpot(pod)
}

// Returns `<Kind>/<name>` for every workload whose pod template has no Spot
// intent.
export function findNonSpotWorkloads(docs: Manifest[]): string[] {
	const missing: string[] = []
	for (const doc of docs) {
		const kind = doc.kind
		let pod: unknown
		if (
			kind === 'Deployment' ||
			kind === 'StatefulSet' ||
			kind === 'DaemonSet'
		) {
			pod = get(doc, 'spec', 'template', 'spec')
		} else if (kind === 'CronJob') {
			pod = get(doc, 'spec', 'jobTemplate', 'spec', 'template', 'spec')
		} else {
			continue
		}
		if (!podIsSpot(pod)) {
			missing.push(`${kind}/${get(doc, 'metadata', 'name') ?? 'unknown'}`)
		}
	}
	return missing
}

const HINT = `
All workloads must express a Spot intent. Add to the pod template a
hard nodeSelector:
  nodeSelector:
    cloud.google.com/gke-spot: "true"          # Standard cluster (dev)
    cloud.google.com/compute-class: autopilot-spot  # Autopilot (staging/prod)
or, for prod availability, a soft prefer-Spot-with-on-demand-fallback:
  affinity:
    nodeAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          preference:
            matchExpressions:
              - {key: cloud.google.com/gke-spot, operator: In, values: ["true"]}`

function main(target: string | undefined): number {
	if (!target) {
		console.error('Usage: check-spot-nodeselector.ts <directory-or-file>')
		return 2
	}
	let failed = false
	for (const { path, docs } of loadRendered(target)) {
		const namespace = basename(path, '.yaml')
		for (const resource of findNonSpotWorkloads(docs)) {
			console.log(
				`ERROR: [${namespace}] ${resource} is missing Spot VM nodeSelector`,
			)
			failed = true
		}
	}
	if (failed) {
		console.log(HINT)
		return 1
	}
	console.log('OK: All workloads have Spot VM nodeSelector.')
	return 0
}

if (import.meta.main) {
	process.exitCode = main(process.argv[2])
}
