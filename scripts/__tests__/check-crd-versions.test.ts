import { describe, expect, it } from 'vitest'
import { checkCrdVersions } from '../check-crd-versions.ts'
import { parseManifests } from '../rendered-manifests.ts'

const CRD = `
kind: CustomResourceDefinition
spec:
  group: external-secrets.io
  names: {kind: ExternalSecret}
  versions:
  - name: v1
    served: true
    schema: {openAPIV3Schema: {type: object}}
  - name: v1beta1
    served: false
    schema: {openAPIV3Schema: {type: object}}
`

describe('checkCrdVersions', () => {
	it('passes resources on a served version and exports served schemas', () => {
		const result = checkCrdVersions([
			{ path: '/r/crds.yaml', docs: parseManifests(CRD) },
			{
				path: '/r/argocd-prod.yaml',
				docs: parseManifests(`
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata: {name: ok}
`),
			},
		])
		expect(result.failures).toEqual([])
		expect(result.served.size).toBe(1)
		expect(result.schemas).toEqual([
			{
				group: 'external-secrets.io',
				kind: 'ExternalSecret',
				version: 'v1',
				schema: { type: 'object' },
			},
		])
	})

	it('fails a resource on an unserved version', () => {
		const result = checkCrdVersions([
			{ path: '/r/crds.yaml', docs: parseManifests(CRD) },
			{
				path: '/r/backend-prod.yaml',
				docs: parseManifests(`
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata: {name: stale}
`),
			},
		])
		expect(result.failures).toEqual([
			'backend-prod.yaml: ExternalSecret stale uses external-secrets.io/v1beta1, but its rendered CRD serves only ["v1"]',
		])
	})

	it('ignores core resources and kinds without a rendered CRD', () => {
		const result = checkCrdVersions([
			{
				path: '/r/gateway-prod.yaml',
				docs: parseManifests(`
apiVersion: v1
kind: Service
metadata: {name: core}
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: {name: catalog}
`),
			},
		])
		expect(result.failures).toEqual([])
		expect(result.served.size).toBe(0)
	})
})
