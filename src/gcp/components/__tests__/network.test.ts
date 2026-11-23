import { describe, expect, it } from 'vitest'
import { buildHostname, servicesFor, tld } from '../network.js'

const hostnames = (environment: 'dev' | 'prod') =>
	servicesFor(environment).map((svc) =>
		buildHostname(environment, svc.subdomain, tld),
	)

describe('service catalog', () => {
	it('gives production the preview hostnames of the fan app', () => {
		expect(hostnames('prod')).toContain('preview.liverty-music.app')
		expect(hostnames('prod')).toContain('api.preview.liverty-music.app')
	})

	it('gives dev no preview hostname', () => {
		expect(
			hostnames('dev').filter((host) => host.includes('preview')),
		).toEqual([])
	})

	it('keeps the names of the existing services, which are part of the stack URN', () => {
		const dev = servicesFor('dev').map((svc) => svc.name)
		const prod = servicesFor('prod').map((svc) => svc.name)
		expect(prod.slice(0, dev.length)).toEqual(dev)
		expect(prod.slice(dev.length)).toEqual([
			'fan-preview-web',
			'fan-preview-api',
		])
	})
})
