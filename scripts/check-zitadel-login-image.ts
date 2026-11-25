// Check that production runs the patched Zitadel Login V2 image built from the
// checked-out zitadel-login/ (OpenSpec change
// remove-password-setup-from-hosted-login, design D6). Fails unless:
//   - zitadel-login/UPSTREAM_TAG equals `image.tag` in the zitadel base values
//     (the Login V2 patch is applied to the same tag as the API image);
//   - the prod overlay sets `login.image.repository` to the zitadel-login
//     Artifact Registry repository and `login.image.tag` to
//     `<UPSTREAM_TAG>-lm.<tree>`, where <tree> is the first 12 characters of
//     the git tree of zitadel-login/, the tag the zitadel-login workflow pushes.
// A prod overlay without that override fails too, so an override lost in a
// chart upgrade cannot silently put the password pages back. The one
// exception is an emergency rollback: while zitadel-login/ROLLBACK exists
// (one line stating why), the overlay must NOT override `login.image`.
//
// Usage:
//   node scripts/check-zitadel-login-image.ts
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { get } from './rendered-manifests.ts'

export const LOGIN_DIR = 'zitadel-login'
export const LOGIN_REPOSITORY =
	'asia-northeast2-docker.pkg.dev/liverty-music-prod/zitadel-login/zitadel-login'
const BASE_VALUES = 'k8s/namespaces/zitadel/base/values.yaml'
const PROD_VALUES = 'k8s/namespaces/zitadel/overlays/prod/values.yaml'

export interface LoginImageInputs {
	upstreamTag: string
	/** The git tree id of zitadel-login/. */
	tree: string
	/** The contents of zitadel-login/ROLLBACK, or undefined when absent. */
	rollback: string | undefined
	baseValues: unknown
	prodValues: unknown
}

/** The image tag the zitadel-login workflow pushes for this content. */
export function expectedTag(upstreamTag: string, tree: string): string {
	return `${upstreamTag}-lm.${tree.slice(0, 12)}`
}

/** Every inconsistency found; empty when production is wired correctly. */
export function checkLoginImage(inputs: LoginImageInputs): string[] {
	const { upstreamTag, tree, rollback, baseValues, prodValues } = inputs
	const errors: string[] = []

	const apiTag = get(baseValues, 'image', 'tag')
	if (apiTag !== upstreamTag) {
		errors.push(
			`${LOGIN_DIR}/UPSTREAM_TAG is ${upstreamTag} but ${BASE_VALUES} image.tag is ${String(apiTag)}; bump them together`,
		)
	}

	const override = get(prodValues, 'login', 'image')
	if (rollback !== undefined) {
		if (rollback.trim() === '') {
			errors.push(
				`${LOGIN_DIR}/ROLLBACK must state why the rollback is in place`,
			)
		}
		if (override !== undefined) {
			errors.push(
				`${LOGIN_DIR}/ROLLBACK exists but ${PROD_VALUES} overrides login.image; delete ROLLBACK when restoring the patched image`,
			)
		}
		return errors
	}

	if (override === undefined) {
		errors.push(
			`${PROD_VALUES} has no login.image override, so prod would run the upstream Login V2 image; set it, or add ${LOGIN_DIR}/ROLLBACK for an emergency rollback`,
		)
		return errors
	}
	const repository = get(override, 'repository')
	if (repository !== LOGIN_REPOSITORY) {
		errors.push(
			`${PROD_VALUES} login.image.repository is ${String(repository)}, want ${LOGIN_REPOSITORY}`,
		)
	}
	const want = expectedTag(upstreamTag, tree)
	const tag = get(override, 'tag')
	if (tag !== want) {
		errors.push(
			`${PROD_VALUES} login.image.tag is ${String(tag)}, want ${want} (built from the current ${LOGIN_DIR}/)`,
		)
	}
	return errors
}

/**
 * The git tree id of `dir` as it is in the working tree, committed or not, so
 * the check gives the same answer before a commit (the pre-commit hook) as on
 * the checked-out commit in CI, where it equals `git rev-parse HEAD:<dir>`.
 */
export function workingTreeId(dir: string): string {
	const tmp = mkdtempSync(join(tmpdir(), 'zitadel-login-tree-'))
	try {
		const env = { ...process.env, GIT_INDEX_FILE: join(tmp, 'index') }
		execFileSync('git', ['add', '--all', '--', dir], { env })
		return execFileSync('git', ['write-tree', `--prefix=${dir}/`], {
			env,
			encoding: 'utf8',
		}).trim()
	} finally {
		rmSync(tmp, { recursive: true, force: true })
	}
}

function main(): number {
	const rollbackPath = join(LOGIN_DIR, 'ROLLBACK')
	const errors = checkLoginImage({
		upstreamTag: readFileSync(
			join(LOGIN_DIR, 'UPSTREAM_TAG'),
			'utf8',
		).trim(),
		tree: workingTreeId(LOGIN_DIR),
		rollback: existsSync(rollbackPath)
			? readFileSync(rollbackPath, 'utf8')
			: undefined,
		baseValues: parse(readFileSync(BASE_VALUES, 'utf8')),
		prodValues: parse(readFileSync(PROD_VALUES, 'utf8')),
	})
	for (const error of errors) {
		console.error(`zitadel-login: ${error}`)
	}
	if (errors.length === 0) {
		console.log(
			'zitadel-login: prod runs the image built from zitadel-login/',
		)
	}
	return errors.length === 0 ? 0 : 1
}

if (import.meta.main) {
	process.exitCode = main()
}
