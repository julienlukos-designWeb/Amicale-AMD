// @ts-nocheck
// A.M.D — Fonction Supabase « envoyer-notification » (copier-coller tel quel dans l’éditeur Supabase)
import { createClient } from "npm:@supabase/supabase-js@2";

// ---------------------------------------------------------------------
// Envoi Web Push sans bibliothèque externe (RFC 8291 aes128gcm + VAPID RFC 8292)
// Utilise uniquement WebCrypto : fonctionne dans Supabase Edge Functions (Deno).
// ---------------------------------------------------------------------
const enc = new TextEncoder();
const b64uToBytes = (s) => {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const bytesToB64u = (b) => {
  let s = "";
  for (const x of new Uint8Array(b)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const concat = (...parts) => {
  const n = parts.reduce((a, p) => a + p.length, 0), out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const hmac = async (key, data) => {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
};
// HKDF en une étape (longueur <= 32)
const hkdf = async (salt, ikm, info, len) => {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, len);
};

let vapidKey = null;
async function vapidSigningKey(pub, priv) {
  if (vapidKey) return vapidKey;
  const p = b64uToBytes(pub);
  vapidKey = await crypto.subtle.importKey("jwk", {
    kty: "EC", crv: "P-256", d: priv,
    x: bytesToB64u(p.slice(1, 33)), y: bytesToB64u(p.slice(33, 65)), ext: true,
  }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return vapidKey;
}

async function vapidHeader(endpoint, vapid) {
  const aud = new URL(endpoint).origin;
  const head = bytesToB64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = bytesToB64u(enc.encode(JSON.stringify({
    aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: vapid.subject,
  })));
  const key = await vapidSigningKey(vapid.publicKey, vapid.privateKey);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(head + "." + body));
  return `vapid t=${head}.${body}.${bytesToB64u(sig)}, k=${vapid.publicKey}`;
}

async function encryptPayload(sub, payload) {
  const uaPub = b64uToBytes(sub.p256dh), authSecret = b64uToBytes(sub.auth);
  const as = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode("WebPush: info\0"), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const plain = concat(enc.encode(payload), new Uint8Array([2]));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plain));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = 65;
  return concat(header, asPub, ct);
}

// Envoie une notification. Retourne le code HTTP du service de push.
async function sendPush(sub, payload, vapid, ttl = 86400) {
  const body = await encryptPayload(sub, payload);
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "Authorization": await vapidHeader(sub.endpoint, vapid),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": String(ttl),
      "Urgency": "high",
    },
    body,
  });
  try { await res.arrayBuffer(); } catch (_) { /* corps ignoré */ }
  return res.status;
}

// ---------------------------------------------------------------------
// Fonction serveur « envoyer-notification »
// - action "test"  : n'importe quel membre actif reçoit un test sur SES téléphones
// - sinon           : réservé aux administrateurs ; envoie à tous / aux admins / à une sélection
// ---------------------------------------------------------------------
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);
  try {
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await db.auth.getUser(token);
    if (!u?.user) return json({ error: "Session expirée. Reconnecte-toi." }, 401);
    const { data: me } = await db.from("profiles").select("id,first_name,last_name,role,status")
      .eq("id", u.user.id).maybeSingle();
    if (!me || me.status !== "active") return json({ error: "Compte non actif." }, 403);

    const vapid = {
      publicKey: Deno.env.get("VAPID_PUBLIC_KEY") || "",
      privateKey: Deno.env.get("VAPID_PRIVATE_KEY") || "",
      subject: Deno.env.get("VAPID_SUBJECT") || "mailto:admin@amicale-c17.com",
    };
    if (!vapid.publicKey || !vapid.privateKey) return json({ error: "Clés VAPID manquantes dans les secrets." }, 500);

    const b = await req.json().catch(() => ({}));
    const isAdm = ["admin", "owner"].includes(me.role);
    let ids: string[] = [], titre = "", message = "", cible = "test";
    const url = typeof b.page === "string" && /^[a-z_]{1,20}$/.test(b.page) ? "./?p=" + b.page : "./";

    if (b.action === "test") {
      ids = [me.id];
      titre = "Test A.M.D";
      message = "Les notifications fonctionnent sur ce téléphone ✅";
    } else {
      if (!isAdm) return json({ error: "Réservé aux administrateurs." }, 403);
      titre = String(b.titre || "").trim().slice(0, 80);
      message = String(b.message || "").trim().slice(0, 500);
      cible = ["tous", "admins", "selection"].includes(b.cible) ? b.cible : "";
      if (!titre || !message || !cible) return json({ error: "Titre, message et destinataires obligatoires." }, 400);
      let q = db.from("profiles").select("id").eq("status", "active");
      if (cible === "admins") q = q.in("role", ["admin", "owner"]);
      const { data: ps, error } = await q.limit(5000);
      if (error) throw error;
      ids = (ps || []).map((p) => p.id);
      if (cible === "selection") {
        const pick = new Set((Array.isArray(b.ids) ? b.ids : []).map(String));
        ids = ids.filter((id) => pick.has(id));
        if (!ids.length) return json({ error: "Choisis au moins un membre." }, 400);
      }
    }

    const set = new Set(ids);
    const { data: all, error: e2 } = await db.from("push_abonnements").select("id,user_id,endpoint,p256dh,auth").limit(10000);
    if (e2) throw e2;
    const subs = (all || []).filter((s) => set.has(s.user_id));
    const payload = JSON.stringify({ title: titre, body: message, url, tag: "amd-" + Date.now() });

    let ok = 0, ko = 0;
    const morts: number[] = [];
    for (let i = 0; i < subs.length; i += 25) {
      const lot = subs.slice(i, i + 25);
      const res = await Promise.allSettled(lot.map((s) => sendPush(s, payload, vapid)));
      res.forEach((r, j) => {
        const st = r.status === "fulfilled" ? r.value : 0;
        if (st >= 200 && st < 300) ok++;
        else { ko++; if (st === 404 || st === 410) morts.push(lot[j].id); }
      });
    }
    // Téléphones qui ont retiré l'autorisation ou désinstallé : on les oublie
    if (morts.length) await db.from("push_abonnements").delete().in("id", morts);

    const touches = new Set(subs.map((s) => s.user_id)).size;
    if (b.action !== "test") {
      await db.from("push_envois").insert({
        envoye_par: me.id, envoye_par_nom: `${me.first_name || ""} ${me.last_name || ""}`.trim(),
        titre, message, cible, nb_membres: ids.length, nb_appareils: subs.length, nb_ok: ok,
      });
    }
    return json({ ok: true, membres: ids.length, membres_joignables: touches, appareils: subs.length, envoyes: ok, echecs: ko });
  } catch (e) {
    console.error(e);
    return json({ error: "Erreur du serveur : " + (e instanceof Error ? e.message : String(e)) }, 500);
  }
});
