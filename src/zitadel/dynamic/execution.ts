import * as pulumi from '@pulumi/pulumi'
import { type JwtProfile, zitadelApiCall } from './api-client.js'

export interface ZitadelExecutionFunctionArgs {
	domain: pulumi.Input<string>
	jwtProfileJson: pulumi.Input<string>
	/** Function name — e.g. `preaccesstoken`, `preuserinfo`. */
	functionName: pulumi.Input<string>
	/** Target IDs invoked in order when the function executes. */
	targetIds: pulumi.Input<pulumi.Input<string>[]>
}

export interface ZitadelExecutionRequestArgs {
	domain: pulumi.Input<string>
	jwtProfileJson: pulumi.Input<string>
	/** gRPC method name, e.g. `/zitadel.user.v2.UserService/AddHumanUser`. */
	method: pulumi.Input<string>
	/** Target IDs invoked in order when the request is received. */
	targetIds: pulumi.Input<pulumi.Input<string>[]>
}

interface FunctionInputs {
	domain: string
	jwtProfileJson: string
	functionName: string
	targetIds: string[]
}

interface RequestInputs {
	domain: string
	jwtProfileJson: string
	method: string
	targetIds: string[]
}

async function setExecution(opts: {
	inputs: { domain: string; jwtProfileJson: string }
	condition: Record<string, unknown>
	targetIds: string[]
}): Promise<void> {
	const profile = JSON.parse(opts.inputs.jwtProfileJson) as JwtProfile
	const res = await zitadelApiCall({
		domain: opts.inputs.domain,
		profile,
		method: 'PUT',
		path: '/v2/actions/executions',
		body: {
			condition: opts.condition,
			targets: opts.targetIds,
		},
	})
	if (res.statusCode < 200 || res.statusCode >= 300) {
		throw new Error(
			`Zitadel SetExecution failed (${res.statusCode}): ${res.body}`,
		)
	}
}

export const executionFunctionProvider: pulumi.dynamic.ResourceProvider = {
	async create(
		inputs: FunctionInputs,
	): Promise<pulumi.dynamic.CreateResult<FunctionInputs>> {
		await setExecution({
			inputs,
			condition: { function: { name: inputs.functionName } },
			targetIds: inputs.targetIds,
		})
		return {
			id: `function:${inputs.functionName}`,
			outs: inputs,
		}
	},

	async update(
		_id: string,
		_olds: FunctionInputs,
		news: FunctionInputs,
	): Promise<pulumi.dynamic.UpdateResult<FunctionInputs>> {
		await setExecution({
			inputs: news,
			condition: { function: { name: news.functionName } },
			targetIds: news.targetIds,
		})
		return { outs: news }
	},

	async delete(_id: string, state: FunctionInputs): Promise<void> {
		// Remove the execution binding by sending an empty targets list.
		await setExecution({
			inputs: state,
			condition: { function: { name: state.functionName } },
			targetIds: [],
		})
	},
}

export const executionRequestProvider: pulumi.dynamic.ResourceProvider = {
	async create(
		inputs: RequestInputs,
	): Promise<pulumi.dynamic.CreateResult<RequestInputs>> {
		await setExecution({
			inputs,
			condition: { request: { method: inputs.method } },
			targetIds: inputs.targetIds,
		})
		return {
			id: `request:${inputs.method}`,
			outs: inputs,
		}
	},

	async update(
		_id: string,
		_olds: RequestInputs,
		news: RequestInputs,
	): Promise<pulumi.dynamic.UpdateResult<RequestInputs>> {
		await setExecution({
			inputs: news,
			condition: { request: { method: news.method } },
			targetIds: news.targetIds,
		})
		return { outs: news }
	},

	async delete(_id: string, state: RequestInputs): Promise<void> {
		await setExecution({
			inputs: state,
			condition: { request: { method: state.method } },
			targetIds: [],
		})
	},
}

/**
 * ZitadelExecutionFunction binds a Zitadel Actions v2 function (e.g.
 * `preaccesstoken`) to one or more Targets, via the Management REST API.
 */
export class ZitadelExecutionFunction extends pulumi.dynamic.Resource {
	constructor(
		name: string,
		args: ZitadelExecutionFunctionArgs,
		opts?: pulumi.CustomResourceOptions,
	) {
		super(executionFunctionProvider, name, args, opts)
	}
}

/**
 * ZitadelExecutionRequest binds a Zitadel Actions v2 request hook (identified
 * by gRPC method, e.g. `/zitadel.user.v2.UserService/AddHumanUser`) to one or
 * more Targets, via the Management REST API.
 */
export class ZitadelExecutionRequest extends pulumi.dynamic.Resource {
	constructor(
		name: string,
		args: ZitadelExecutionRequestArgs,
		opts?: pulumi.CustomResourceOptions,
	) {
		super(executionRequestProvider, name, args, opts)
	}
}
