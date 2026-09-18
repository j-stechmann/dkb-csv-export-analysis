import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  buildEndSessionUrl,
  calculatePKCECodeChallenge,
  discovery,
  randomPKCECodeVerifier,
  randomState,
} from "openid-client"
import type { Configuration } from "openid-client"
import { getConfig } from "@/lib/config"

/**
 * Generic OIDC provider client: issuer discovery (well-known), PKCE
 * authorization redirect, code exchange with state/nonce checks. Any
 * compliant provider works (Keycloak, Authentik, Authelia, Pocket ID, …).
 */

export interface OidcConfig {
  configuration: Configuration
  redirectUri: string
  scopes: string
}

let cachedConfig: OidcConfig | null = null

/** app origin: APP_ORIGIN override or derived from the incoming request. */
export function appOrigin(requestUrl: string): string {
  const cfg = getConfig()
  if (cfg.APP_ORIGIN) return cfg.APP_ORIGIN.replace(/\/$/, "")
  const url = new URL(requestUrl)
  return url.origin
}

export async function getOidcConfig(requestUrl: string): Promise<OidcConfig> {
  if (cachedConfig) {
    return { ...cachedConfig, redirectUri: redirectUriFor(requestUrl) }
  }
  const cfg = getConfig()
  const configuration = await discovery(
    new URL(cfg.OIDC_ISSUER_URL),
    cfg.OIDC_CLIENT_ID,
    { client_secret: cfg.OIDC_CLIENT_SECRET }
  )
  cachedConfig = { configuration, redirectUri: "", scopes: cfg.OIDC_SCOPES }
  return { ...cachedConfig, redirectUri: redirectUriFor(requestUrl) }
}

function redirectUriFor(requestUrl: string): string {
  return `${appOrigin(requestUrl)}/auth/callback`
}

/** For tests: drop the memoized discovery configuration. */
export function resetOidcConfigCache() {
  cachedConfig = null
}

export interface AuthorizationRequest {
  redirectUrl: URL
  state: string
  codeVerifier: string
  nonce: string
}

export async function buildLoginRedirect(
  requestUrl: string
): Promise<AuthorizationRequest> {
  const oidc = await getOidcConfig(requestUrl)
  const state = randomState()
  const codeVerifier = randomPKCECodeVerifier()
  const nonce = randomState()
  const codeChallenge = await calculatePKCECodeChallenge(codeVerifier)
  const redirectUrl = buildAuthorizationUrl(oidc.configuration, {
    redirect_uri: oidc.redirectUri,
    scope: oidc.scopes,
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  })
  return { redirectUrl, state, codeVerifier, nonce }
}

export interface TokenResult {
  claims: {
    subject: string
    issuer: string
    name: string
    email: string
  }
  idToken: string
}

/**
 * Exchanges the authorization code and validates state/nonce/PKCE.
 * Throws when the provider rejected the exchange or a check failed.
 */
export async function exchangeAuthorizationCode(
  callbackUrl: string,
  expectedState: string,
  expectedNonce: string,
  codeVerifier: string
): Promise<TokenResult> {
  const oidc = await getOidcConfig(callbackUrl)
  const currentUrl = new URL(callbackUrl)
  const tokens = await authorizationCodeGrant(oidc.configuration, currentUrl, {
    expectedState,
    expectedNonce,
    pkceCodeVerifier: codeVerifier,
  })
  const claims = tokens.claims?.()
  if (!claims) {
    throw new Error("provider returned no id_token claims")
  }
  const subject = claims.sub
  return {
    claims: {
      subject,
      issuer: claims.iss,
      name:
        typeof claims.name === "string"
          ? claims.name
          : typeof claims.preferred_username === "string"
            ? claims.preferred_username
            : subject,
      email: typeof claims.email === "string" ? claims.email : "",
    },
    idToken: tokens.id_token ?? "",
  }
}

/** Provider logout URL when the discovery document advertises one. */
export async function buildLogoutRedirect(
  requestUrl: string,
  idTokenHint: string | null
): Promise<URL | null> {
  try {
    const oidc = await getOidcConfig(requestUrl)
    const params: Record<string, string> = {
      post_logout_redirect_uri: `${appOrigin(requestUrl)}/`,
    }
    if (idTokenHint) params.id_token_hint = idTokenHint
    return buildEndSessionUrl(oidc.configuration, params)
  } catch {
    return null
  }
}
