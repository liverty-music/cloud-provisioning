import { describe, expect, it } from 'vitest'
import { fanSignInUris } from '../frontend.js'

describe('fan application sign-in addresses', () => {
	it('accepts the preview address in prod', () => {
		const { redirectUris, postLogoutRedirectUris } = fanSignInUris('prod')
		expect(redirectUris).toEqual([
			'https://liverty-music.app/auth/callback',
			'https://liverty-music.app/auth/passkeys-callback',
			'https://preview.liverty-music.app/auth/callback',
			'https://preview.liverty-music.app/auth/passkeys-callback',
		])
		expect(postLogoutRedirectUris).toEqual([
			'https://liverty-music.app/',
			'https://preview.liverty-music.app/',
		])
	})

	it('accepts no preview address in dev', () => {
		const { redirectUris, postLogoutRedirectUris } = fanSignInUris('dev')
		expect(
			[...redirectUris, ...postLogoutRedirectUris].filter((uri) =>
				uri.includes('preview'),
			),
		).toEqual([])
		expect(redirectUris).toContain('http://localhost:9000/auth/callback')
		expect(postLogoutRedirectUris).toContain('http://localhost:9000/')
	})
})
