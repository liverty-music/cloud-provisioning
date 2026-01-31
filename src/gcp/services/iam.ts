import * as gcp from '@pulumi/gcp'
import * as pulumi from '@pulumi/pulumi'
import { toKebabCase, ValueOf } from '../../lib/lib.js'

export const Roles = {
  CloudSql: {
    InstanceUser: 'roles/cloudsql.instanceUser',
  },
} as const

export type IamRole = ValueOf<ValueOf<typeof Roles>>

export class IamService {
  constructor(private projectId: pulumi.Input<string>) {}

  createServiceAccount(
    name: string,
    saName: string,
    displayName: string,
    parent?: pulumi.Resource
  ) {
    return new gcp.serviceaccount.Account(
      name,
      {
        accountId: saName,
        displayName,
        project: this.projectId,
      },
      { parent }
    )
  }

  bindRoles(
    roles: IamRole[],
    saName: string,
    saEmail: pulumi.Input<string>,
    parent?: pulumi.Resource
  ): gcp.projects.IAMMember[] {
    return roles.map(role => {
      return new gcp.projects.IAMMember(
        `${saName}-x-${toKebabCase(role.split('/').pop()!)}`,
        {
          project: this.projectId,
          role,
          member: pulumi.interpolate`serviceAccount:${saEmail}`,
        },
        { parent }
      )
    })
  }
}
