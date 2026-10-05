import { describe, expect, it } from 'vitest'
import { findNonSpotWorkloads } from '../check-spot-nodeselector.ts'
import { parseManifests } from '../rendered-manifests.ts'

describe('findNonSpotWorkloads', () => {
	it('accepts a gke-spot or autopilot-spot nodeSelector', () => {
		const docs = parseManifests(`
kind: Deployment
metadata: {name: dev}
spec: {template: {spec: {nodeSelector: {cloud.google.com/gke-spot: "true"}}}}
---
kind: StatefulSet
metadata: {name: prod}
spec: {template: {spec: {nodeSelector: {cloud.google.com/compute-class: autopilot-spot}}}}
`)
		expect(findNonSpotWorkloads(docs)).toEqual([])
	})

	it('accepts a preferred Spot nodeAffinity', () => {
		const docs = parseManifests(`
kind: DaemonSet
metadata: {name: soft}
spec:
  template:
    spec:
      affinity:
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            preference:
              matchExpressions:
              - {key: cloud.google.com/gke-spot, operator: In, values: ["true"]}
`)
		expect(findNonSpotWorkloads(docs)).toEqual([])
	})

	it('reports workloads and CronJobs without Spot intent', () => {
		const docs = parseManifests(`
kind: Deployment
metadata: {name: plain}
spec: {template: {spec: {}}}
---
kind: CronJob
metadata: {name: nightly}
spec: {jobTemplate: {spec: {template: {spec: {nodeSelector: {cloud.google.com/gke-spot: "false"}}}}}}
---
kind: CronJob
metadata: {name: ok}
spec: {jobTemplate: {spec: {template: {spec: {nodeSelector: {cloud.google.com/gke-spot: "true"}}}}}}
`)
		expect(findNonSpotWorkloads(docs)).toEqual([
			'Deployment/plain',
			'CronJob/nightly',
		])
	})

	it('ignores non-workload kinds and empty documents', () => {
		const docs = parseManifests(`
---
kind: Service
metadata: {name: svc}
---
`)
		expect(findNonSpotWorkloads(docs)).toEqual([])
	})

	it('treats an unquoted boolean selector value as not Spot', () => {
		const docs = parseManifests(`
kind: Deployment
metadata: {name: unquoted}
spec: {template: {spec: {nodeSelector: {cloud.google.com/gke-spot: true}}}}
`)
		expect(findNonSpotWorkloads(docs)).toEqual(['Deployment/unquoted'])
	})
})
