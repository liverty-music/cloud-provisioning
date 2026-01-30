import * as pulumi from '@pulumi/pulumi'
import * as gcp from '@pulumi/gcp'

export interface CloudSqlInstanceArgs {
  projectId: pulumi.Input<string>
  region: pulumi.Input<string>
  environment: 'dev' | 'staging' | 'prod'
  enabledServices: pulumi.Input<gcp.projects.Service>[]
}

/**
 * CloudSqlInstance provisions a PostgreSQL instance on Google Cloud SQL.
 * It follows 2026 best practices:
 * - PostgreSQL 18
 * - Enterprise edition (Standard)
 * - Private Service Connect (PSC)
 * - IAM Database Authentication
 * - High Availability (Regional)
 */
export class CloudSqlInstance extends pulumi.ComponentResource {
  public readonly instance: gcp.sql.DatabaseInstance
  public readonly database: gcp.sql.Database
  public readonly appServiceAccount: gcp.serviceaccount.Account

  constructor(name: string, args: CloudSqlInstanceArgs, opts?: pulumi.ComponentResourceOptions) {
    super('gcp:liverty-music:CloudSqlInstance', name, args, opts)

    const { projectId, region, environment, enabledServices } = args

    // 1. Create a service account for the backend application
    this.appServiceAccount = new gcp.serviceaccount.Account(
      `${name}-app`,
      {
        accountId: 'backend-app',
        displayName: 'Backend Application Service Account',
        project: projectId,
      },
      { parent: this }
    )

    // 2. Grant necessary roles to the service account
    new gcp.projects.IAMMember(
      `${name}-sql-user`,
      {
        project: projectId,
        role: 'roles/cloudsql.instanceUser',
        member: pulumi.interpolate`serviceAccount:${this.appServiceAccount.email}`,
      },
      { parent: this }
    )

    // Cloud SQL API is required
    // NOTE: 'sqladmin.googleapis.com' should be in REQUIRED_APIS in index.ts

    // 3. Provision Cloud SQL Instance
    this.instance = new gcp.sql.DatabaseInstance(
      name,
      {
        project: projectId,
        region: region,
        databaseVersion: 'POSTGRES_18',
        settings: {
          tier: 'db-f1-micro', // Small Start (Shared CPU)
          edition: 'ENTERPRISE', // Standard Edition
          availabilityType: 'REGIONAL', // High Availability
          diskSize: 10,
          diskType: 'PD_SSD',
          deletionProtectionEnabled: environment !== 'dev',
          backupConfiguration: {
            enabled: true,
            startTime: '03:00', // 18:00 UTC = 03:00 JST
            pointInTimeRecoveryEnabled: true,
            transactionLogRetentionDays: 7,
          },
          maintenanceWindow: {
            day: 7, // Sunday
            hour: 4, // 04:00 JST
          },
          ipConfiguration: {
            ipv4Enabled: false, // Private only
            pscConfig: {
              pscEnabled: true,
              allowedConsumerProjects: [projectId],
            },
          },
          insightsConfig: {
            queryInsightsEnabled: true,
          },
          databaseFlags: [{ name: 'cloudsql.iam_authentication', value: 'on' }],
        },
      },
      { dependsOn: enabledServices, parent: this }
    )

    // 4. Create default database
    this.database = new gcp.sql.Database(
      `${name}-db`,
      {
        project: projectId,
        instance: this.instance.name,
        name: 'liverty-music',
        charset: 'UTF8',
        collation: 'en_US.UTF8',
      },
      { parent: this }
    )

    // 5. Create Cloud IAM SQL User
    // The name for a CLOUD_IAM_SERVICE_ACCOUNT user is the email address without the .gserviceaccount.com suffix.
    const iamUserName = this.appServiceAccount.email.apply(email =>
      email.replace('.gserviceaccount.com', '')
    )

    new gcp.sql.User(
      `${name}-iam-user`,
      {
        project: projectId,
        instance: this.instance.name,
        name: iamUserName,
        type: 'CLOUD_IAM_SERVICE_ACCOUNT',
      },
      { parent: this, dependsOn: [this.instance] }
    )

    this.registerOutputs({
      instanceConnectionName: this.instance.connectionName,
      pscServiceAttachment: this.instance.pscServiceAttachmentLink,
      appServiceAccountEmail: this.appServiceAccount.email,
    })
  }
}
