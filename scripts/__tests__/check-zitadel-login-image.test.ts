import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
	checkLoginImage,
	expectedTag,
	LOGIN_REPOSITORY,
	type LoginImageInputs,
	workingTreeId,
} from '../check-zitadel-login-image.ts'

const TREE = '0123456789abcdef0123456789abcdef01234567'

function inputs(overrides: Partial<LoginImageInputs> = {}): LoginImageInputs {
	return {
		upstreamTag: 'v4.20.0',
		tree: TREE,
		rollback: undefined,
		baseValues: { image: { tag: 'v4.20.0' } },
		prodValues: {
			login: {
				nodeSelector: null,
				image: {
					repository: LOGIN_REPOSITORY,
					tag: 'v4.20.0-lm.0123456789ab',
				},
			},
		},
		...overrides,
	}
}

describe('checkLoginImage', () => {
	it('passes when prod runs the image built from zitadel-login/', () => {
		expect(expectedTag('v4.20.0', TREE)).toBe('v4.20.0-lm.0123456789ab')
		expect(checkLoginImage(inputs())).toEqual([])
	})

	it('fails when the tag pin changes without the prod tag', () => {
		const errors = checkLoginImage(
			inputs({
				upstreamTag: 'v4.21.0',
				baseValues: { image: { tag: 'v4.21.0' } },
			}),
		)
		expect(errors).toEqual([
			expect.stringContaining('want v4.21.0-lm.0123456789ab'),
		])
	})

	it('fails when the base image tag differs from the tag pin', () => {
		const errors = checkLoginImage(
			inputs({ baseValues: { image: { tag: 'v4.21.0' } } }),
		)
		expect(errors).toEqual([
			expect.stringContaining('image.tag is v4.21.0'),
		])
	})

	it('fails when a patch changes without the prod tag', () => {
		const errors = checkLoginImage(inputs({ tree: 'fedcba9876543210' }))
		expect(errors).toEqual([
			expect.stringContaining('want v4.20.0-lm.fedcba987654'),
		])
	})

	it('fails when prod pulls from another repository', () => {
		const errors = checkLoginImage(
			inputs({
				prodValues: {
					login: {
						image: {
							repository: 'ghcr.io/zitadel/zitadel-login',
							tag: 'v4.20.0-lm.0123456789ab',
						},
					},
				},
			}),
		)
		expect(errors).toEqual([
			expect.stringContaining('login.image.repository'),
		])
	})

	it('fails when the prod overlay has no login.image override', () => {
		const errors = checkLoginImage(
			inputs({ prodValues: { login: { nodeSelector: null } } }),
		)
		expect(errors).toEqual([
			expect.stringContaining('no login.image override'),
		])
	})

	it('passes with no override only while ROLLBACK exists', () => {
		expect(
			checkLoginImage(
				inputs({
					rollback:
						'Login V2 crash-loops on the patched image (#123)\n',
					prodValues: { login: { nodeSelector: null } },
				}),
			),
		).toEqual([])
	})

	it('fails when ROLLBACK states no reason', () => {
		const errors = checkLoginImage(
			inputs({ rollback: '\n', prodValues: { login: {} } }),
		)
		expect(errors).toEqual([expect.stringContaining('must state why')])
	})

	it('fails when ROLLBACK and an override exist together', () => {
		const errors = checkLoginImage(inputs({ rollback: 'reason\n' }))
		expect(errors).toEqual([expect.stringContaining('delete ROLLBACK')])
	})
})

describe('workingTreeId', () => {
	const cwd = process.cwd()
	let repo = ''

	afterEach(() => {
		process.chdir(cwd)
		if (repo) rmSync(repo, { recursive: true, force: true })
	})

	function git(...args: string[]): string {
		return execFileSync('git', args, { encoding: 'utf8' }).trim()
	}

	it('equals the committed tree, and follows uncommitted edits', () => {
		repo = mkdtempSync(join(tmpdir(), 'zitadel-login-repo-'))
		process.chdir(repo)
		git('init', '--quiet')
		mkdirSync('zitadel-login/patches', { recursive: true })
		writeFileSync('zitadel-login/UPSTREAM_TAG', 'v4.20.0\n')
		writeFileSync('zitadel-login/patches/0001-a.patch', 'a\n')
		git('add', '.')
		git(
			'-c',
			'user.name=t',
			'-c',
			'user.email=t@example.com',
			'commit',
			'--quiet',
			'-m',
			'init',
		)

		expect(workingTreeId('zitadel-login')).toBe(
			git('rev-parse', 'HEAD:zitadel-login'),
		)

		writeFileSync('zitadel-login/patches/0001-a.patch', 'b\n')
		expect(workingTreeId('zitadel-login')).not.toBe(
			git('rev-parse', 'HEAD:zitadel-login'),
		)
		// The real index is untouched.
		expect(git('diff', '--cached', '--name-only')).toBe('')
	})
})
