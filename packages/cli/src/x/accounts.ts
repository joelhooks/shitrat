export interface OAuth2SecretNames {
  readonly accessToken: string
  readonly refreshToken: string
  readonly clientId: string
  readonly clientSecret: string
}

export const normalizeAccount = (account: string): string =>
  account.replace(/^@/, "").toLowerCase().replace(/[^a-z0-9]+/g, "")

export const oauth2SecretNames = (account: string): OAuth2SecretNames => {
  const slug = normalizeAccount(account)
  return {
    accessToken: `x_${slug}_oauth2_access_token`,
    refreshToken: `x_${slug}_oauth2_refresh_token`,
    clientId: `x_${slug}_oauth2_client_id`,
    clientSecret: `x_${slug}_oauth2_client_secret`,
  }
}

export const DEFAULT_X_ACCOUNT = "joelhooks"
