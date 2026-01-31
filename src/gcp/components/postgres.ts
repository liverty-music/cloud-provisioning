import * as pulumi from '@pulumi/pulumi'
import * as gcp from '@pulumi/gcp'
import { Roles, IamService } from '../services/iam.js'
import { ApiService } from '../services/api.js'

export interface PostgresComponentArgs {
  projectId: pulumi.Input<string>
  region: pulumi.Input<string>
  regionName: pulumi.Input<string>
  environment: 'dev' | 'staging' | 'prod'
  /**
   * The ID of the subnet where the PSC Endpoint (IP) will be placed.
   */
  subnetId: pulumi.Input<string>
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
   */
  appServiceAccountEmail: pulumi.Input<string>
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
  public readonly instance: gcp.sql.DatabaseInstance
  public readonly database: gcp.sql.Database
  public readonly pscAddress: gcp.compute.Address
  public readonly pscForwardingRule: gcp.compute.ForwardingRule
  public readonly dnsRecord: gcp.dns.RecordSet

  constructor(name: string, args: PostgresComponentArgs, opts?: pulumi.ComponentResourceOptions) {
    super('gcp:liverty-music:PostgresComponent', name, args, opts)

    const {
      projectId,
      region,
      regionName,
      environment,
      subnetId,
      networkId,
      pscEndpointIp,
      dnsZoneName,
      appServiceAccountEmail,
    } = args

    const backendApp = 'backend-app'

    const apiService = new ApiService(projectId)
    const enabledApis = apiService.enableApis([
      'sqladmin.googleapis.com', // Required for Cloud SQL
      'servicenetworking.googleapis.com', // Required for PSC
    ])

    const iamSvc = new IamService(projectId)

    // 1. Grant necessary roles to the provided service account
    iamSvc.bindRoles([Roles.CloudSql.InstanceUser], backendApp, appServiceAccountEmail, this)

    // 2. Provision Cloud SQL Instance (Producer)
    const postgresDbName = `postgres-${regionName}`
    this.instance = new gcp.sql.DatabaseInstance(
      postgresDbName,
      {
        name: postgresDbName,
        project: projectId,
        region: region,
        databaseVersion: 'POSTGRES_18',
        deletionProtection: environment !== 'dev',
        settings: {
          tier: 'db-f1-micro', // Small Start (Shared CPU)
          edition: 'ENTERPRISE', // Standard Edition
          availabilityType: environment === 'dev' ? 'ZONAL' : 'REGIONAL',
          diskSize: 10,
          diskType: 'PD_SSD',
          diskAutoresize: true,
          deletionProtectionEnabled: environment !== 'dev',
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
                allowedConsumerProjects: [projectId],
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
      { dependsOn: enabledApis, parent: this }
    )

    // 4. Create PSC Endpoint (Consumer Side)
    // 4a. Static Internal IP Reservation
    this.pscAddress = new gcp.compute.Address(
      `psc-endpoint-ip-${postgresDbName}`,
      {
        name: `psc-endpoint-ip-${postgresDbName}`,
        region: region,
        subnetwork: subnetId,
        addressType: 'INTERNAL',
        address: pscEndpointIp,
      },
      { parent: this, deleteBeforeReplace: true } // Static IPs can be finicky
    )

    // 4b. Forwarding Rule (The Endpoint)
    this.pscForwardingRule = new gcp.compute.ForwardingRule(
      `psc-endpoint-${postgresDbName}`,
      {
        name: `psc-endpoint-${postgresDbName}`,
        region: region,
        network: networkId,
        subnetwork: subnetId,
        ipAddress: this.pscAddress.id,
        target: this.instance.pscServiceAttachmentLink, // Connect to SQL
        loadBalancingScheme: '', // Must be empty for PSC
      },
      { parent: this }
    )

    // 5. DNS Record (postgres.osaka.psc.internal)
    this.dnsRecord = new gcp.dns.RecordSet(
      `private-db-a-record-${postgresDbName}`,
      {
        name: `postgres.${regionName}.psc.internal.`,
        managedZone: dnsZoneName,
        type: 'A',
        ttl: 300,
        rrdatas: [this.pscAddress.address],
      },
      { parent: this }
    )

    // 6. Create default database
    this.database = new gcp.sql.Database(
      backendApp,
      {
        name: backendApp,
        project: projectId,
        instance: this.instance.name,
        charset: 'UTF8',
        collation: 'en_US.UTF8',
      },
      { parent: this }
    )

    // 7. Create Cloud IAM SQL User
    const iamUserName = pulumi
      .output(appServiceAccountEmail)
      .apply(email => email.replace('.gserviceaccount.com', ''))

    new gcp.sql.User(
      backendApp,
      {
        name: iamUserName,
        project: projectId,
        instance: this.instance.name,
        type: 'CLOUD_IAM_SERVICE_ACCOUNT',
      },
      { parent: this, dependsOn: [this.instance] }
    )

    this.registerOutputs({
      instanceConnectionName: this.instance.connectionName,
      pscServiceAttachment: this.instance.pscServiceAttachmentLink,
      pscEndpointIp: this.pscAddress.address,
      dnsRecord: this.dnsRecord.name,
    })
  }
}
