import {
  allowInsecureRequests,
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
  if (cfg.APP_ORIGIN) return cfg.APP_ORIGIN.replace(/\/+$/, "")
  const url = new URL(requestUrl)
  return url.origin
}

/**
 * Browser-facing URL for an app-relative path (leading slash required).
 * Preserves a sub-path APP_ORIGIN (…/base) — `new URL(path, origin)` would
 * discard it. Without APP_ORIGIN, the request's own origin is used (no base
 * path to preserve; Next cannot know the public mount point then).
 */
export function appUrl(requestUrl: string, pathWithSlash: string): URL {
  const base = appOrigin(requestUrl)
  const basePath = new URL(base).pathname.replace(/\/+$/, "")
  return new URL(`${basePath}${pathWithSlash}`, base)
}

export async function getOidcConfig(requestUrl: string): Promise<OidcConfig> {
  if (cachedConfig) {
    return { ...cachedConfig, redirectUri: redirectUriFor(requestUrl) }
  }
  const cfg = getConfig()
  // openid-client refuses plain-HTTP issuers by default; opt out only when
  // the issuer itself is HTTP (dev Authentik / homelab without TLS yet).
  // HTTPS-only by default stays the fail-fast for misconfigured prod envs.
  const issuerUrl = new URL(cfg.OIDC_ISSUER_URL)
  const insecure = !issuerUrl.protocol.includes("https")
  if (insecure) {
    console.warn(
      `[auth/oidc] WARNING: OIDC_ISSUER_URL is not HTTPS (${issuerUrl.origin}) — ` +
        "discovery/token traffic to it will be plaintext"
    )
  }
  const configuration = await discovery(
    new URL(cfg.OIDC_ISSUER_URL),
    cfg.OIDC_CLIENT_ID,
    { client_secret: cfg.OIDC_CLIENT_SECRET },
    undefined,
    insecure ? { execute: [allowInsecureRequests] } : undefined
  )
  cachedConfig = { configuration, redirectUri: "", scopes: cfg.OIDC_SCOPES }
  return { ...cachedConfig, redirectUri: redirectUriFor(requestUrl) }
}

function redirectUriFor(requestUrl: string): string {
  return appUrl(requestUrl, "/auth/callback").toString()
}

/**
 * The token-exchange redirect_uri must byte-match the authorize-request one
 * (OIDC spec §3.1.2.2), but openid-client derives it from the callback URL
 * itself — which behind a reverse proxy carries the internal origin. Rebuild
 * the incoming callback onto the same appOrigin + path template both legs
 * share, keeping query params (code/state) intact.
 */
/** Exported for tests: pins the authorize↔token redirect_uri contract. */
export function callbackUrlFor(callbackUrl: string): URL {
  const incoming = new URL(callbackUrl)
  // sub-path APP_ORIGIN (…/base): the public path comes from the template —
  // the internal request path must not leak into the redirect_uri
  return new URL(`${redirectUriFor(callbackUrl)}${incoming.search}`)
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
  const currentUrl = callbackUrlFor(callbackUrl)
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
      post_logout_redirect_uri: appUrl(requestUrl, "/").toString(),
    }
    if (idTokenHint) params.id_token_hint = idTokenHint
    return buildEndSessionUrl(oidc.configuration, params)
  } catch {
    return null
  }
}
