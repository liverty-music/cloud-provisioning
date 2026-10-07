import { describe, expect, it } from 'vitest'
import {
	defaultComputeClassIsSpot,
	findNonSpotWorkloads,
} from '../check-spot-nodeselector.ts'
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

	it('accepts a Pod that selects no class when the default class is Spot', () => {
		const docs = parseManifests(`
kind: Deployment
metadata: {name: unselected}
spec: {template: {spec: {}}}
---
kind: Deployment
metadata: {name: on-demand}
spec: {template: {spec: {nodeSelector: {cloud.google.com/gke-spot: "false"}}}}
---
kind: Deployment
metadata: {name: other-class}
spec: {template: {spec: {nodeSelector: {cloud.google.com/compute-class: autopilot}}}}
`)
		expect(findNonSpotWorkloads(docs, true)).toEqual([
			'Deployment/on-demand',
			'Deployment/other-class',
		])
		expect(findNonSpotWorkloads(docs)).toContain('Deployment/unselected')
	})
})

describe('defaultComputeClassIsSpot', () => {
	it('is true only for a `default` class whose first rule is Spot', () => {
		const spotFirst = parseManifests(`
kind: ComputeClass
metadata: {name: default}
spec: {priorities: [{podFamily: general-purpose, spot: true}, {podFamily: general-purpose}]}
`)
		const onDemandFirst = parseManifests(`
kind: ComputeClass
metadata: {name: default}
spec: {priorities: [{podFamily: general-purpose}, {podFamily: general-purpose, spot: true}]}
`)
		const named = parseManifests(`
kind: ComputeClass
metadata: {name: batch}
spec: {priorities: [{podFamily: general-purpose, spot: true}]}
`)
		expect(defaultComputeClassIsSpot(spotFirst)).toBe(true)
		expect(defaultComputeClassIsSpot(onDemandFirst)).toBe(false)
		expect(defaultComputeClassIsSpot(named)).toBe(false)
	})
})
