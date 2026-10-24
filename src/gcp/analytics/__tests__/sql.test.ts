import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sqlDir = new URL('../sql/', import.meta.url)
const files = readdirSync(sqlDir).filter((f) => f.endsWith('.sql'))
const views = new Set(files.map((f) => f.replace(/\.sql$/, '')))

describe('analytics view SQL', () => {
	it('holds the six staging and six mart views', () => {
		expect([...views].filter((v) => v.startsWith('stg_'))).toHaveLength(6)
		expect([...views].filter((v) => v.startsWith('mart_'))).toHaveLength(6)
	})

	for (const file of files) {
		const sql = readFileSync(new URL(file, sqlDir), 'utf8')

		it(`${file} uses only the placeholders the component fills`, () => {
			const placeholders = new Set(sql.match(/{{\w+}}/g) ?? [])
			for (const p of placeholders) {
				expect(['{{project}}', '{{billing_account}}']).toContain(p)
			}
		})

		it(`${file} reads only views that exist, in the dataset of their layer`, () => {
			for (const [, dataset, name] of sql.matchAll(
				/`{{project}}\.(analytics_staging|analytics_marts)\.(\w+)`/g,
			)) {
				expect(views).toContain(name)
				expect(dataset).toBe(
					name.startsWith('stg_')
						? 'analytics_staging'
						: 'analytics_marts',
				)
			}
		})
	}
})
