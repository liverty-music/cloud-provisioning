import * as pulumi from '@pulumi/pulumi'
import { type JwtProfile, zitadelApiCall } from './api-client.js'

export interface ZitadelUserIdpLinkArgs {
	/** Zitadel domain, e.g. `auth.dev.liverty-music.app`. */
	domain: pulumi.Input<string>
	/** Admin machine user JWT profile JSON (stringified) for Management API auth. */
	jwtProfileJson: pulumi.Input<string>
	/** Zitadel-side local user id to attach the external identity to. */
	userId: pulumi.Input<string>
	/** Zitadel IdP id (instance- or org-level) the link references. */
	idpId: pulumi.Input<string>
	/**
	 * External identity provider's stable user id. For Google OIDC this is
	 * the `sub` claim — a numeric string immutable for the lifetime of the
	 * Google account. Stored in Pulumi state and ESC; not a secret but
	 * still the join key, so changes here trigger a `replace`.
	 */
	externalUserId: pulumi.Input<string>
	/**
	 * Optional display label for the IdP entry in Zitadel's user profile.
	 * Pure presentation, never used for matching. Defaults to
	 * `externalUserId` when omitted.
	 */
	displayName?: pulumi.Input<string>
}

interface UserIdpLinkInputs {
	domain: string
	jwtProfileJson: string
	userId: string
	idpId: string
	externalUserId: string
	displayName?: string
}

/**
 * Provider for `ZitadelUserIdpLink`. Pre-creates the binding between a
 * Pulumi-managed local Zitadel user and the external identity that user
 * will sign in with — so the very first IdP login lands directly on the
 * existing local user instead of hitting the Login V2
 * `account-not-found` page.
 *
 * ## Why this resource exists
 *
 * Without a pre-created link, Login V2's first-sign-in flow needs *one
 * of* the following to succeed:
 *   1. `LoginPolicy.userLogin = true` so the user can authenticate with
 *      a local password and confirm "yes, this Google account is mine"
 *      via Zitadel's autoLink prompt.
 *   2. `IdpGoogle.isAutoCreation = true` so a brand-new local user is
 *      created from the Google profile.
 *
 * The `admin` role org explicitly forbids both: it disables
 * username/password (`LoginPolicy.userLogin = false`) to enforce
 * IdP-only Console access, and forbids auto-creation
 * (`IdpGoogle.isCreationAllowed = false`) to prevent anyone with a
 * matching email domain from implicitly becoming an instance-level
 * admin. That combination leaves no native path to bootstrap the first
 * sign-in — Login V2 has nothing to match against and gives up.
 *
 * Pre-creating the link via the v2 user service breaks the deadlock:
 * the `(idpId, externalUserId)` tuple is already in Zitadel by the time
 * the admin clicks "Sign in with Google", so the IdP callback resolves
 * straight to the local `IAM_OWNER` and the Console loads.
 *
 * ## Why the Zitadel v2 user service (`/v2/users/{userId}/links`)
 *
 * - Stable, GA, documented for first-class IdP-link management.
 * - Single endpoint covers add (POST) and remove (DELETE), keeping
 *   create/delete symmetric.
 * - Same JWT-bearer auth as the rest of the dynamic resources here, so
 *   no new auth scaffolding is needed.
 *
 * The legacy v1 management API
 * (`/management/v1/users/{userId}/idps`) would also work but is a
 * separate code path Zitadel may eventually deprecate; v2 is preferred.
 *
 * ## CRUD shape
 *
 * - `create()` POSTs the link. A 409/AlreadyExists from Zitadel is
 *   treated as success so the resource is idempotent across re-applies
 *   and partial-failure recoveries (matches the same pattern used in
 *   `smtp-activation.ts`).
 * - `update()` is a no-op by design. The `(userId, idpId,
 *   externalUserId)` tuple IS the resource identity — changes there
 *   produce a Pulumi `replace`, not an `update`. The only soft field
 *   (`displayName`) has no Zitadel "update existing link" endpoint, so
 *   there is nothing to push.
 * - `delete()` DELETEs the link. 404 is treated as success (the link
 *   is already gone — idempotent removal). Other non-2xx errors throw
 *   so a real Zitadel-side failure surfaces in the deployment log
 *   instead of silently leaving stale Pulumi state.
 * - `read()` is a no-op returning current outputs. A live `GET` is not
 *   exposed by Zitadel's v2 user service for individual links, and
 *   list+filter would add cost without helping the typical
 *   import/refresh flow that this resource is part of.
 */
export const userIdpLinkProvider: pulumi.dynamic.ResourceProvider = {
	async create(
		inputs: UserIdpLinkInputs,
	): Promise<pulumi.dynamic.CreateResult<UserIdpLinkInputs>> {
		const profile = JSON.parse(inputs.jwtProfileJson) as JwtProfile
		const res = await zitadelApiCall({
			domain: inputs.domain,
			profile,
			method: 'POST',
			path: `/v2/users/${inputs.userId}/links`,
			body: {
				idpLink: {
					idpId: inputs.idpId,
					userId: inputs.externalUserId,
					userName: inputs.displayName ?? inputs.externalUserId,
				},
			},
		})
		if (
			(res.statusCode < 200 || res.statusCode >= 300) &&
			!isAlreadyExists(res.statusCode, res.body)
		) {
			throw new Error(
				`Zitadel AddIDPLink failed (${res.statusCode}): ${res.body}`,
			)
		}
		return {
			id: `user-idp-link:${inputs.userId}:${inputs.idpId}:${inputs.externalUserId}`,
			outs: inputs,
		}
	},

	async update(
		_id: string,
		_olds: UserIdpLinkInputs,
		news: UserIdpLinkInputs,
	): Promise<pulumi.dynamic.UpdateResult<UserIdpLinkInputs>> {
		// No-op by design — see provider doc comment above. The identity
		// tuple is immutable from Pulumi's perspective (changes trigger
		// `replace`), and Zitadel exposes no "update existing link"
		// endpoint for the soft `displayName` field.
		return { outs: news }
	},

	async delete(_id: string, state: UserIdpLinkInputs): Promise<void> {
		const profile = JSON.parse(state.jwtProfileJson) as JwtProfile
		const res = await zitadelApiCall({
			domain: state.domain,
			profile,
			method: 'DELETE',
			path: `/v2/users/${state.userId}/links/${state.idpId}/${state.externalUserId}`,
		})
		// 2xx = removed, 404 = already gone. Both are success on delete.
		if (res.statusCode === 404) return
		if (res.statusCode >= 200 && res.statusCode < 300) return
		throw new Error(
			`Zitadel RemoveIDPLink failed (${res.statusCode}): ${res.body}`,
		)
	},

	async read(
		id: string,
		state: UserIdpLinkInputs,
	): Promise<pulumi.dynamic.ReadResult<UserIdpLinkInputs>> {
		// No-op: see provider doc comment above for why a live GET is not
		// performed against Zitadel's v2 user service for this resource.
		return { id, props: state }
	},
}

function isAlreadyExists(statusCode: number, body: string): boolean {
	// Zitadel surfaces "already exists" as a 409 with a recognizable
	// code/message envelope. Match conservatively to avoid swallowing
	// unrelated 409s (none observed today, but cheap insurance).
	if (statusCode !== 409) return false
	return /already.?exists/i.test(body) || /AlreadyExists/i.test(body)
}

/**
 * `ZitadelUserIdpLink` declares a binding between a Pulumi-managed
 * local Zitadel user and the external identity that user signs in
 * with. Required for the `admin` role org because that org's
 * `LoginPolicy` and `IdpGoogle` config disable both
 * username/password fallback and IdP auto-creation, leaving no
 * native first-sign-in path. Pre-creating the link makes the very
 * first Google sign-in resolve straight to the local `IAM_OWNER`.
 *
 * For end-user (product) sign-in flows that allow either userLogin
 * or auto-creation, this resource is unnecessary — Zitadel handles
 * the first-link prompt natively there.
 */
export class ZitadelUserIdpLink extends pulumi.dynamic.Resource {
	constructor(
		name: string,
		args: ZitadelUserIdpLinkArgs,
		opts?: pulumi.CustomResourceOptions,
	) {
		super(userIdpLinkProvider, name, args, opts)
	}
}
