// Sign-in and session tokens.
//
// Google's ID-token flow: the browser gets a signed JWT from Google Identity
// Services, the Worker verifies it (lib/oidc.js — including the `aud` check that
// scopes a valid Google signature to *this* app), then issues its own HMAC token
// so every later request is one HMAC rather than a JWKS fetch. No client secret.
import { verifyIdToken, GOOGLE } from "./oidc.js";

const SESSION_TTL_S = 60 * 60 * 24 * 180; // an installed app shouldn't nag for sign-in

const enc = new TextEncoder();

function b64urlEncode(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
  );
}

export async function issueSession(sub, secret, now = Date.now()) {
  const payload = b64urlEncode(enc.encode(JSON.stringify({
    sub, exp: Math.floor(now / 1000) + SESSION_TTL_S,
  })));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(payload));
  return `${payload}.${b64urlEncode(new Uint8Array(sig))}`;
}

/** The Google `sub` for a valid token, or null for absent/malformed/forged/expired alike. */
export async function verifySession(token, secret, now = Date.now()) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;

  // crypto.subtle.verify is constant-time; never compare signatures with ===.
  let ok;
  try {
    ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), b64urlDecode(sig), enc.encode(payload));
  } catch {
    return null;
  }
  if (!ok) return null;

  try {
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
    if (!claims.sub || !claims.exp || claims.exp * 1000 <= now) return null;
    return claims.sub;
  } catch {
    return null;
  }
}

export async function userFromRequest(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  return verifySession(token, env.TOKEN_SECRET);
}

/**
 * Exchange a Google ID token for a session token. Throws on any failure; the
 * caller answers every failure with the same generic "sign-in failed".
 */
export async function signInWithGoogle(idToken, env) {
  if (!env.GOOGLE_CLIENT_ID) throw new Error("GOOGLE_CLIENT_ID is not configured");
  if (!env.TOKEN_SECRET) throw new Error("TOKEN_SECRET is not configured");

  const claims = await verifyIdToken(idToken, { ...GOOGLE, audience: env.GOOGLE_CLIENT_ID });

  return {
    token: await issueSession(claims.sub, env.TOKEN_SECRET),
    // Keyed on `sub`, never email: emails get changed and recycled.
    user: {
      id: claims.sub,
      name: claims.given_name || claims.name || null,
      email: claims.email || null,
      // `=s96-c` asks for a 96px square crop.
      picture: claims.picture ? `${claims.picture.split("=")[0]}=s96-c` : null,
    },
  };
}
