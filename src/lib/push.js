// Web Push transport. Encryption and VAPID signing come from webpush-edge —
// Apple accepts only aes128gcm and answers the older coding with 201 and no
// notification, so hand-rolling this fails in a way that looks like success.
import { createPusher, kvStore } from "webpush-edge";

async function endpointKey(endpoint) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return "pushep:" + [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * kvStore plus a reverse index from endpoint to user, so the unauthenticated
 * rotate route can find the owner of an endpoint without scanning every user.
 */
function indexedStore(kv) {
  const base = kvStore(kv);
  return {
    get: base.get,
    async set(userId, subs) {
      const before = await base.get(userId);
      const after = new Set(subs.map(s => s.endpoint));
      await base.set(userId, subs);
      await Promise.all([
        ...before.filter(s => !after.has(s.endpoint))
          .map(async s => kv.delete(await endpointKey(s.endpoint))),
        ...subs.map(async s => kv.put(await endpointKey(s.endpoint), userId)),
      ]);
    },
  };
}

export function pusherFor(env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_JWK) throw new Error("VAPID keys are not configured");
  return createPusher({
    publicKey: env.VAPID_PUBLIC_KEY,
    privateJwk: env.VAPID_PRIVATE_JWK,
    contact: env.PUSH_CONTACT || "mailto:mishabhi@gmail.com",
    store: indexedStore(env.RSI_KV),
  });
}

/**
 * `pushsubscriptionchange` fires in the service worker, which holds no session
 * token. Authorised by possession of the old endpoint — a capability URL only
 * that device and this server ever held — and able to do exactly one thing:
 * swap that endpoint for a new one on the user who already owns it.
 */
export async function rotateEndpoint(env, oldEndpoint, subscription) {
  const userId = await env.RSI_KV.get(await endpointKey(oldEndpoint));
  if (!userId) return false;
  const push = pusherFor(env);
  await push.unsubscribe(userId, oldEndpoint);
  await push.subscribe(userId, subscription);
  return true;
}
