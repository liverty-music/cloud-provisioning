import * as gcp from '@pulumi/gcp'
import * as pulumi from '@pulumi/pulumi'
import type { Environment } from '../../config.js'
import { ApiService } from '../services/api.js'

export interface PostgresComponentArgs {
	project: gcp.organizations.Project
	region: pulumi.Input<string>
	regionName: pulumi.Input<string>
	environment: Environment
	/**
	 * Workload tier gate. When `false` (dev shutdown mode), the Cloud SQL
	 * instance is set to `activationPolicy: NEVER` (stopped — CPU/RAM
	 * billing halts, disk + backup retained, data preserved) and the
	 * cluster-coupled satellites (PSC consumer endpoint, IAM SQL users
	 * for in-cluster SAs) are not provisioned because the cluster + its
	 * subnet are gone. The Cloud SQL instance itself, default databases,
	 * DNS record, and human IAM users always persist. See
	 * `docs/runbooks/dev-shutdown-restart.md`.
	 */
	workloadEnabled: boolean
	/**
	 * The ID of the subnet where the PSC Endpoint (IP) will be placed.
	 * Required when `workloadEnabled` is true; the PSC consumer endpoint
	 * is co-destroyed with the cluster subnet when the workload tier is
	 * down.
	 */
	subnetId?: pulumi.Input<string>
	/**
	 * The network self link or ID, required for DNS Private Zone.
	 */
	networkId: pulumi.Input<string>
	/**
	 * Centralized PSC Endpoint IP.
	 */
	pscEndpointIp: pulumi.Input<string>
	/**
	 * Common DNS Zone name for PSC.
	 */
	dnsZoneName: pulumi.Input<string>
	/**
	 * GCP Service Account email for the backend application.
	 * Required when `workloadEnabled` is true (the matching IAM SQL user is
	 * created only when the in-cluster SA exists).
	 */
	appServiceAccountEmail?: pulumi.Input<string>
	/**
	 * GCP Service Account email for self-hosted Zitadel. When provided, a
	 * dedicated `zitadel` database and matching IAM SQL user are created so
	 * Zitadel can connect through Cloud SQL Auth Proxy with IAM authentication.
	 */
	zitadelServiceAccountEmail?: pulumi.Input<string>
	/**
	 * Human user emails that require IAM database authentication access.
	 */
	iamDatabaseUsers?: string[]
	/**
	 * Password for the Cloud SQL built-in postgres admin user.
	 * Used by Atlas Operator for schema management and migrations.
	 */
	postgresAdminPassword?: pulumi.Input<string>
}

/**
 * PostgresDatabase provisions a PostgreSQL instance on Google Cloud SQL.
 * It follows 2026 best practices:
 * - PostgreSQL 18
 * - Enterprise edition (Standard)
 * - Private Service Connect (PSC)
 * - IAM Database Authentication
 * - High Availability (Regional)
 * - Integrated PSC Endpoint & Cloud DNS Record
 */
export class PostgresComponent extends pulumi.ComponentResource {
	// public readonly instance: gcp.sql.DatabaseInstance
	// public readonly database: gcp.sql.Database
	// public readonly pscAddress: gcp.compute.Address
	// public readonly pscForwardingRule: gcp.compute.ForwardingRule
	// public readonly dnsRecord: gcp.dns.RecordSet

	constructor(
		name: string,
		args: PostgresComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('gcp:liverty-music:PostgresComponent', name, args, opts)

		const {
			project,
			region,
			regionName,
			environment,
			workloadEnabled,
			subnetId,
			networkId,
			pscEndpointIp,
			dnsZoneName,
			appServiceAccountEmail,
			zitadelServiceAccountEmail,
			iamDatabaseUsers = [],
			postgresAdminPassword,
		} = args

		const apiService = new ApiService(project)
		const enabledApis = apiService.enableApis([
			'sqladmin.googleapis.com', // Required for Cloud SQL
			'servicenetworking.googleapis.com', // Required for PSC
		])

		// 2. Provision Cloud SQL Instance (Producer).
		// `activationPolicy` flips to `NEVER` (stopped) when `workloadEnabled`
		// is false so CPU/RAM billing halts; disk + PITR backup retention
		// continues so the dev database survives the shutdown window. Both
		// `deletionProtection` (Pulumi side) and `deletionProtectionEnabled`
		// (Cloud SQL side) are hard-coded to `true` — dev shutdown is meant
		// to be reversible, not destructive, so accidentally calling
		// `pulumi destroy` on this instance should error rather than wipe
		// data. To genuinely delete the instance (e.g., long-term
		// decommission), edit both flags to `false` in a deliberate PR.
		const postgresDbName = `postgres-${regionName}`
		const instance = new gcp.sql.DatabaseInstance(
			postgresDbName,
			{
				name: postgresDbName,
				project: project.projectId,
				region: region,
				databaseVersion: 'POSTGRES_18',
				deletionProtection: true,
				settings: {
					tier: 'db-f1-micro', // Small Start (Shared CPU)
					edition: 'ENTERPRISE', // Standard Edition
					availabilityType:
						environment === 'dev' ? 'ZONAL' : 'REGIONAL',
					activationPolicy: workloadEnabled ? 'ALWAYS' : 'NEVER',
					diskSize: 10,
					diskType: 'PD_SSD',
					diskAutoresize: true,
					deletionProtectionEnabled: true,
					backupConfiguration: {
						enabled: true,
						startTime: '18:00', // 18:00 UTC = 03:00 JST (next day)
						pointInTimeRecoveryEnabled: true,
						transactionLogRetentionDays: 7,
					},
					maintenanceWindow: {
						day: 7, // Sunday
						hour: 4, // 04:00 JST
					},
					ipConfiguration: {
						ipv4Enabled: false, // Private only
						sslMode: 'ENCRYPTED_ONLY',
						enablePrivatePathForGoogleCloudServices: true, // Optional but good for BQ etc.
						pscConfigs: [
							{
								pscEnabled: true,
								allowedConsumerProjects: [project.projectId],
							},
						],
					},
					insightsConfig: {
						queryInsightsEnabled: true,
						recordApplicationTags: true,
						recordClientAddress: false,
					},
					databaseFlags: [
						{ name: 'cloudsql.iam_authentication', value: 'on' },
						{ name: 'log_checkpoints', value: 'on' },
						{ name: 'log_connections', value: 'on' },
						{ name: 'log_disconnections', value: 'on' },
						{ name: 'log_lock_waits', value: 'on' },
						{ name: 'log_min_duration_statement', value: '1000' },
					],
				},
			},
			{ dependsOn: enabledApis, parent: this },
		)

		// 4 + 5. PSC consumer endpoint and DNS A-record — gated on
		// `workloadEnabled`. The PSC Address is bound to the cluster
		// subnet (created inside `KubernetesComponent`), so when the
		// workload tier is destroyed the subnet goes with it; recreating
		// the same `10.10.10.10` address + forwarding rule on restart
		// reattaches to the same provider-side Cloud SQL service
		// attachment, and the same hashed `.sql.goog` DNS A-record
		// points at it. Cloud SQL itself never moves between cycles.
		if (workloadEnabled) {
			if (!subnetId) {
				throw new Error(
					'PostgresComponent: `subnetId` is required when ' +
						'`workloadEnabled` is true (the PSC consumer endpoint ' +
						'is bound to the cluster subnet).',
				)
			}
			// 4a. Static Internal IP Reservation
			const pscAddress = new gcp.compute.Address(
				`psc-endpoint-ip-${postgresDbName}`,
				{
					name: `psc-endpoint-ip-${postgresDbName}`,
					region: region,
					subnetwork: subnetId,
					addressType: 'INTERNAL',
					address: pscEndpointIp,
				},
				{ parent: this, deleteBeforeReplace: true }, // Static IPs can be finicky
			)

			// 4b. Forwarding Rule (The Endpoint)
			new gcp.compute.ForwardingRule(
				`psc-endpoint-${postgresDbName}`,
				{
					name: `psc-endpoint-${postgresDbName}`,
					region: region,
					network: networkId,
					subnetwork: subnetId,
					ipAddress: pscAddress.id,
					target: instance.pscServiceAttachmentLink, // Connect to SQL
					loadBalancingScheme: '', // Must be empty for PSC
				},
				{ parent: this },
			)

			// 5. DNS Record (Hashed .sql.goog domain required for Cloud SQL Connector)
			// The SDK/Auth Proxy internally resolves the instance connection name to this specific
			// hashed domain for TLS handshake and certificate validation.
			new gcp.dns.RecordSet(
				`private-db-a-record-${postgresDbName}`,
				{
					name: instance.dnsName,
					managedZone: dnsZoneName,
					type: 'A',
					ttl: 300,
					rrdatas: [pscAddress.address],
				},
				{ parent: this },
			)
		}

		const livertyMusicDbName = 'liverty-music'

		// 6. Create default database
		new gcp.sql.Database(
			livertyMusicDbName,
			{
				name: livertyMusicDbName,
				project: project.projectId,
				instance: instance.name,
				charset: 'UTF8',
				collation: 'en_US.UTF8',
			},
			{ parent: this },
		)

		// 7 + 7b. Cluster-SA IAM SQL users — gated on `workloadEnabled`.
		// `backend-app` and `zitadel` GCP SAs are created by
		// `KubernetesComponent` (Workload Identity bindings), so they only
		// exist while the workload tier is up. The Cloud SQL IAM users
		// referencing those SA emails are co-destroyed with the SAs on
		// shutdown and re-created on restart. The `zitadel` database
		// itself is created always (lives inside the preserved Cloud SQL
		// instance), so Zitadel's `Database.postgres.Admin.ExistingDatabase=true`
		// path keeps working through cycles.
		const zitadelDbName = 'zitadel'
		const zitadelDb = new gcp.sql.Database(
			zitadelDbName,
			{
				name: zitadelDbName,
				project: project.projectId,
				instance: instance.name,
				charset: 'UTF8',
				collation: 'en_US.UTF8',
			},
			{ parent: this },
		)
		if (workloadEnabled) {
			if (!appServiceAccountEmail) {
				throw new Error(
					'PostgresComponent: `appServiceAccountEmail` is required ' +
						'when `workloadEnabled` is true.',
				)
			}
			const backendApp = 'backend-app'
			const iamUserName = pulumi
				.output(appServiceAccountEmail)
				.apply((email) => email.replace('.gserviceaccount.com', ''))

			new gcp.sql.User(
				backendApp,
				{
					name: iamUserName,
					project: project.projectId,
					instance: instance.name,
					type: 'CLOUD_IAM_SERVICE_ACCOUNT',
				},
				{ parent: this, dependsOn: [instance] },
			)

			// Zitadel IAM SQL user — only when the Zitadel SA exists.
			// Self-hosted Zitadel connects via Cloud SQL Auth Proxy with
			// --auto-iam-authn, so no password is ever held. Ownership of the
			// `zitadel` database is granted by a separate Atlas/SQL task
			// because Cloud SQL IAM users cannot be made OWNER via
			// gcp.sql.User directly.
			if (zitadelServiceAccountEmail) {
				const zitadelIamUserName = pulumi
					.output(zitadelServiceAccountEmail)
					.apply((email) => email.replace('.gserviceaccount.com', ''))

				new gcp.sql.User(
					zitadelDbName,
					{
						name: zitadelIamUserName,
						project: project.projectId,
						instance: instance.name,
						type: 'CLOUD_IAM_SERVICE_ACCOUNT',
					},
					{
						parent: this,
						dependsOn: [instance, zitadelDb],
					},
				)
			}
		}

		// 8. Create Cloud IAM SQL Users for human access (e.g., Cloud SQL Studio)
		for (const email of iamDatabaseUsers) {
			const sanitizedName = email.replace(/[@.]/g, '-')
			new gcp.sql.User(
				`iam-user-${sanitizedName}`,
				{
					name: email,
					project: project.projectId,
					instance: instance.name,
					type: 'CLOUD_IAM_USER',
				},
				{ parent: this, dependsOn: [instance] },
			)

			new gcp.projects.IAMMember(
				`iam-user-${sanitizedName}-x-cloudsql-instance-user`,
				{
					project: project.projectId,
					role: 'roles/cloudsql.instanceUser',
					member: `user:${email}`,
				},
				{ parent: this },
			)
		}

		// 9. Set password on built-in postgres admin user
		// Atlas Operator connects as postgres (cloudsqlsuperuser) to run migrations
		// that create schemas and grant permissions to the IAM SA user.
		if (postgresAdminPassword) {
			new gcp.sql.User(
				'postgres-admin',
				{
					name: 'postgres',
					project: project.projectId,
					instance: instance.name,
					password: postgresAdminPassword,
					type: 'BUILT_IN',
				},
				{ parent: this, dependsOn: [instance] },
			)
		}

		this.registerOutputs({
			instanceConnectionName: instance.connectionName,
			pscServiceAttachment: instance.pscServiceAttachmentLink,
		})
	}
}
