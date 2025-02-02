/*!
 * Copyright 2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import globals from '../../shared/extensionGlobals'

import {
    AccountInfo,
    GetRoleCredentialsRequest,
    ListAccountRolesRequest,
    ListAccountsRequest,
    LogoutRequest,
    RoleInfo,
    SSO,
    SSOServiceException,
} from '@aws-sdk/client-sso'
import {
    CreateTokenRequest,
    RegisterClientRequest,
    SSOOIDC,
    StartDeviceAuthorizationRequest,
} from '@aws-sdk/client-sso-oidc'
import { AsyncCollection } from '../../shared/utilities/asyncCollection'
import { pageableToCollection } from '../../shared/utilities/collectionUtils'
import { assertHasProps, isNonNullable, RequiredProps, selectFrom } from '../../shared/utilities/tsUtils'
import { getLogger } from '../../shared/logger'
import { SsoAccessTokenProvider } from './ssoAccessTokenProvider'
import { isClientFault } from '../../shared/errors'
import { DevSettings } from '../../shared/settings'

export class OidcClient {
    public constructor(private readonly client: SSOOIDC, private readonly clock: { Date: typeof Date }) {}

    public async registerClient(request: RegisterClientRequest) {
        const response = await this.client.registerClient(request)
        assertHasProps(response, 'clientId', 'clientSecret', 'clientSecretExpiresAt')

        return {
            scopes: request.scopes,
            clientId: response.clientId,
            clientSecret: response.clientSecret,
            expiresAt: new this.clock.Date(response.clientSecretExpiresAt * 1000),
        }
    }

    public async startDeviceAuthorization(request: StartDeviceAuthorizationRequest) {
        const response = await this.client.startDeviceAuthorization(request)
        assertHasProps(response, 'expiresIn', 'deviceCode', 'userCode', 'verificationUri')

        return {
            ...selectFrom(response, 'deviceCode', 'userCode', 'verificationUri'),
            expiresAt: new this.clock.Date(response.expiresIn * 1000 + this.clock.Date.now()),
            interval: response.interval ? response.interval * 1000 : undefined,
        }
    }

    public async createToken(request: CreateTokenRequest) {
        const response = await this.client.createToken(request as CreateTokenRequest)
        assertHasProps(response, 'accessToken', 'expiresIn')

        return {
            ...selectFrom(response, 'accessToken', 'refreshToken', 'tokenType'),
            expiresAt: new this.clock.Date(response.expiresIn * 1000 + this.clock.Date.now()),
        }
    }

    public static create(region: string) {
        return new this(
            new SSOOIDC({
                region,
                endpoint: DevSettings.instance.get('endpoints', {})['ssooidc'],
            }),
            globals.clock
        )
    }
}

type OmittedProps = 'accessToken' | 'nextToken'
type ExtractOverload<T, U> = T extends {
    (...args: infer P1): infer R1
    (...args: infer P2): infer R2
    (...args: infer P3): infer R3
}
    ? (this: U, ...args: P1) => R1
    : never

// Removes all methods that use callbacks instead of promises
type PromisifyClient<T> = {
    [P in keyof T]: T[P] extends (...args: any[]) => any ? ExtractOverload<T[P], PromisifyClient<T>> : T[P]
}

export class SsoClient {
    public constructor(
        private readonly client: PromisifyClient<SSO>,
        private readonly provider: SsoAccessTokenProvider
    ) {}

    public listAccounts(
        request: Omit<ListAccountsRequest, OmittedProps> = {}
    ): AsyncCollection<RequiredProps<AccountInfo, 'accountId'>[]> {
        const requester = (request: Omit<ListAccountsRequest, 'accessToken'>) =>
            this.call(this.client.listAccounts, request)
        const collection = pageableToCollection(requester, request, 'nextToken', 'accountList')

        return collection.filter(isNonNullable).map(accounts => accounts.map(a => (assertHasProps(a, 'accountId'), a)))
    }

    public listAccountRoles(
        request: Omit<ListAccountRolesRequest, OmittedProps>
    ): AsyncCollection<Required<RoleInfo>[]> {
        const requester = (request: Omit<ListAccountRolesRequest, 'accessToken'>) =>
            this.call(this.client.listAccountRoles, request)
        const collection = pageableToCollection(requester, request, 'nextToken', 'roleList')

        return collection
            .filter(isNonNullable)
            .map(roles => roles.map(r => (assertHasProps(r, 'roleName', 'accountId'), r)))
    }

    public async getRoleCredentials(request: Omit<GetRoleCredentialsRequest, OmittedProps>) {
        const response = await this.call(this.client.getRoleCredentials, request)

        assertHasProps(response, 'roleCredentials')
        assertHasProps(response.roleCredentials, 'accessKeyId', 'secretAccessKey')

        const expiration = response.roleCredentials.expiration

        return {
            ...response.roleCredentials,
            expiration: expiration ? new globals.clock.Date(expiration) : undefined,
        }
    }

    public async logout(request: Omit<LogoutRequest, OmittedProps> = {}) {
        await this.call(this.client.logout, request)
    }

    private call<T extends { accessToken: string | undefined }, U>(
        method: (this: typeof this.client, request: T) => Promise<U>,
        request: Omit<T, 'accessToken'>
    ): Promise<U> {
        const requester = async (req: T) => {
            const token = await this.provider.getToken()
            assertHasProps(token, 'accessToken')

            try {
                return await method.call(this.client, { ...req, accessToken: token.accessToken })
            } catch (error) {
                await this.handleError(error)
                throw error
            }
        }

        return requester(request as T)
    }

    private async handleError(error: unknown): Promise<never> {
        if (error instanceof SSOServiceException && isClientFault(error)) {
            getLogger().warn(`credentials (sso): invalidating stored token: ${error.message}`)
            await this.provider.invalidate()
        }

        throw error
    }

    public static create(region: string, provider: SsoAccessTokenProvider) {
        return new this(
            new SSO({
                region,
                endpoint: DevSettings.instance.get('endpoints', {})['sso'],
            }),
            provider
        )
    }
}
