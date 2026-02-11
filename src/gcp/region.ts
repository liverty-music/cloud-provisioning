import type { ValueOf } from '../lib/lib.js'

export const Regions = {
	Asia: 'asia',
	Tokyo: 'asia-northeast1',
	Osaka: 'asia-northeast2',
} as const

export type Region = ValueOf<typeof Regions>

export const RegionNames = {
	Tokyo: 'tokyo',
	Osaka: 'osaka',
} as const

export type RegionName = ValueOf<typeof RegionNames>

export const Zones = {
	Tokyo: 'asia-northeast1-a',
	Osaka: 'asia-northeast2-a',
} as const

export type Zone = ValueOf<typeof Zones>
