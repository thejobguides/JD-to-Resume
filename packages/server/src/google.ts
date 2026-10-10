import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose';

// "Sign in with Google" (OpenID Connect ID tokens). The extension gets the token through
// chrome.identity.launchWebAuthFlow and the website through Google Identity Services; both send it to
// POST /v1/auth/google. Only the token's signature, issuer, audience, expiry and nonce are trusted.

export interface GoogleIdentity {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  nonce?: string;
}

export interface GoogleVerifier {
  verify(idToken: string): Promise<GoogleIdentity>;
}

export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

export function googleVerifier(opts: { clientIds: string[]; jwks?: JWTVerifyGetKey; jwksUrl?: string; issuers?: string[] }): GoogleVerifier {
  const keys = opts.jwks ?? createRemoteJWKSet(new URL(opts.jwksUrl ?? GOOGLE_JWKS_URL));
  return {
    async verify(idToken) {
      const { payload } = await jwtVerify(idToken, keys, {
        issuer: opts.issuers ?? GOOGLE_ISSUERS,
        audience: opts.clientIds,
        algorithms: ['RS256'],
        clockTolerance: 60,
      });
      if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') throw new Error('ID token without subject or email');
      return {
        sub: payload.sub,
        email: payload.email,
        email_verified: payload.email_verified === true || payload.email_verified === 'true',
        ...(typeof payload.name === 'string' ? { name: payload.name } : {}),
        ...(typeof payload.nonce === 'string' ? { nonce: payload.nonce } : {}),
      };
    },
  };
}
