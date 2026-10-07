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
//   - OR no class selection at all, when the same environment's renders
//     declare a cluster default ComputeClass (`default`) whose first priority
//     rule is Spot. GKE then applies that class to the Pod: Spot first,
//     on-demand fallback, active migration back (optimize-prod-gke-cost D1).
//     The environment is the rendered file name's last `-` segment
//     (`frontend-prod.yaml` -> `prod`), as `make lint-k8s` names them.
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

// True when the pod template selects no ComputeClass, directly or through the
// gke-spot label (which selects the built-in autopilot-spot class).
function selectsNoClass(pod: unknown): boolean {
	const selector = get(pod, 'nodeSelector')
	return (
		get(selector, 'cloud.google.com/compute-class') === undefined &&
		get(selector, 'cloud.google.com/gke-spot') === undefined
	)
}

export function podIsSpot(pod: unknown, defaultClassIsSpot = false): boolean {
	return (
		selectorIsSpot(pod) ||
		affinityIsSpot(pod) ||
		(defaultClassIsSpot && selectsNoClass(pod))
	)
}

// True when the docs declare the cluster default ComputeClass and its first
// priority rule is Spot.
export function defaultComputeClassIsSpot(docs: Manifest[]): boolean {
	return docs.some(
		(doc) =>
			doc.kind === 'ComputeClass' &&
			get(doc, 'metadata', 'name') === 'default' &&
			get(asArray(get(doc, 'spec', 'priorities'))[0], 'spot') === true,
	)
}

// Returns `<Kind>/<name>` for every workload whose pod template has no Spot
// intent. `defaultClassIsSpot` says whether the environment's cluster default
// ComputeClass puts unselected Pods on Spot.
export function findNonSpotWorkloads(
	docs: Manifest[],
	defaultClassIsSpot = false,
): string[] {
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
		if (!podIsSpot(pod, defaultClassIsSpot)) {
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
or, for prod availability, rely on the cluster default ComputeClass (select no
class; k8s/cluster/overlays/prod/compute-class-default.yaml), or a soft
prefer-Spot-with-on-demand-fallback:
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
	const files = loadRendered(target)
	const envOf = (path: string) => basename(path, '.yaml').split('-').pop()
	const spotDefaultEnvs = new Set(
		files
			.filter(({ docs }) => defaultComputeClassIsSpot(docs))
			.map(({ path }) => envOf(path)),
	)
	let failed = false
	for (const { path, docs } of files) {
		const namespace = basename(path, '.yaml')
		const defaultClassIsSpot = spotDefaultEnvs.has(envOf(path))
		for (const resource of findNonSpotWorkloads(docs, defaultClassIsSpot)) {
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
