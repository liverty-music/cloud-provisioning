// Shared loader for the rendered Kubernetes manifests checked by
// `make lint-k8s` (one multi-document YAML file per overlay in
// /tmp/rendered). Runs directly on Node 24 (type stripping), no build step.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseAllDocuments } from 'yaml'

// A Kubernetes object as parsed from YAML. Fields are read defensively, so
// the type stays loose.
export type Manifest = Record<string, unknown>

export interface RenderedFile {
	path: string
	docs: Manifest[]
}

// Parses every document in a multi-document YAML string, skipping empty
// documents. Throws on a YAML syntax error.
export function parseManifests(text: string): Manifest[] {
	const docs: Manifest[] = []
	for (const doc of parseAllDocuments(text)) {
		if (doc.errors.length > 0) {
			throw new Error(doc.errors.map((e) => e.message).join('; '))
		}
		const value = doc.toJS()
		if (value !== null && typeof value === 'object') {
			docs.push(value as Manifest)
		}
	}
	return docs
}

// Lists the rendered files for a directory (its `*.yaml` files, sorted) or a
// single file path.
export function renderedPaths(target: string): string[] {
	if (!statSync(target).isDirectory()) {
		return [target]
	}
	return readdirSync(target)
		.filter((name) => name.endsWith('.yaml'))
		.sort()
		.map((name) => join(target, name))
}

export function loadRendered(target: string): RenderedFile[] {
	return renderedPaths(target).map((path) => ({
		path,
		docs: parseManifests(readFileSync(path, 'utf8')),
	}))
}

// Reads a nested field, returning undefined when any step is missing or not
// an object.
export function get(value: unknown, ...keys: string[]): unknown {
	let current = value
	for (const key of keys) {
		if (current === null || typeof current !== 'object') {
			return undefined
		}
		current = (current as Record<string, unknown>)[key]
	}
	return current
}

export function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : []
}
