// Check rendered custom resources against the CRDs rendered alongside them.
//
// Usage: node scripts/check-crd-versions.ts <rendered-dir> <schema-out-dir>
//
// For every CustomResourceDefinition found in <rendered-dir> (the charts that
// ship CRDs with `includeCRDs: true`), this:
//
// 1. Fails if any rendered resource of that group/kind uses an API version the
//    CRD does not *serve*. This is the check that matters: external-secrets
//    0.20 stopped serving v1beta1 while every manifest here still used it, and
//    nothing in CI noticed. Public schema catalogs keep schemas for unserved
//    versions, so kubeconform alone cannot catch this.
// 2. Writes the openAPIV3Schema of every served version to
//    <schema-out-dir>/<group>/<kind>_<version>.json, the layout kubeconform's
//    `{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json` template
//    expects, so field validation uses exactly the schema that will be
//    installed rather than a catalog's copy.
//
// Kinds whose CRDs are not rendered here (Gateway API, NACK, GKE-managed CRDs)
// are left to kubeconform's catalog fallback.
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
	asArray,
	get,
	loadRendered,
	type RenderedFile,
} from './rendered-manifests.ts'

export interface ServedSchema {
	group: string
	kind: string
	version: string
	schema: unknown
}

export interface CrdCheckResult {
	// `<group>/<kind>` → served versions, for every rendered CRD.
	served: Map<string, Set<string>>
	schemas: ServedSchema[]
	failures: string[]
}

export function checkCrdVersions(files: RenderedFile[]): CrdCheckResult {
	const served = new Map<string, Set<string>>()
	const schemas: ServedSchema[] = []
	for (const { docs } of files) {
		for (const doc of docs) {
			if (doc.kind !== 'CustomResourceDefinition') {
				continue
			}
			const group = String(get(doc, 'spec', 'group'))
			const kind = String(get(doc, 'spec', 'names', 'kind'))
			for (const version of asArray(get(doc, 'spec', 'versions'))) {
				if (!get(version, 'served')) {
					continue
				}
				const name = String(get(version, 'name'))
				const key = `${group}/${kind}`
				const versions = served.get(key) ?? new Set<string>()
				versions.add(name)
				served.set(key, versions)
				const schema = get(version, 'schema', 'openAPIV3Schema')
				if (schema) {
					schemas.push({ group, kind, version: name, schema })
				}
			}
		}
	}

	const failures: string[] = []
	for (const { path, docs } of files) {
		for (const doc of docs) {
			const apiVersion =
				typeof doc.apiVersion === 'string' ? doc.apiVersion : ''
			const slash = apiVersion.lastIndexOf('/')
			if (slash < 0) {
				continue
			}
			const group = apiVersion.slice(0, slash)
			const version = apiVersion.slice(slash + 1)
			const versions = served.get(`${group}/${String(doc.kind)}`)
			if (versions && !versions.has(version)) {
				failures.push(
					`${basename(path)}: ${String(doc.kind)} ` +
						`${String(get(doc, 'metadata', 'name'))} uses ${apiVersion}, ` +
						`but its rendered CRD serves only ${JSON.stringify([...versions].sort())}`,
				)
			}
		}
	}
	return { served, schemas, failures }
}

function main(rendered: string | undefined, out: string | undefined): number {
	if (!rendered || !out) {
		console.error(
			'Usage: check-crd-versions.ts <rendered-dir> <schema-out-dir>',
		)
		return 2
	}
	const { served, schemas, failures } = checkCrdVersions(
		loadRendered(rendered),
	)
	for (const { group, kind, version, schema } of schemas) {
		mkdirSync(join(out, group), { recursive: true })
		writeFileSync(
			join(out, group, `${kind.toLowerCase()}_${version}.json`),
			JSON.stringify(schema),
		)
	}
	for (const failure of failures) {
		console.log(`FAIL ${failure}`)
	}
	console.log(
		`${served.size} rendered CRDs; ` +
			`${failures.length} resource(s) on an unserved API version`,
	)
	return failures.length > 0 ? 1 : 0
}

if (import.meta.main) {
	process.exitCode = main(process.argv[2], process.argv[3])
}
