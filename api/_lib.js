// Shared helpers for the API routes (files starting with "_" are not routes on Vercel).
import crypto from "node:crypto";

export const TABLES = ["devis", "offres", "evenements"];
export const BUCKET = "devis";

const env = (k) => {
  // trim: values pasted into Vercel often carry a trailing newline or space
  const v = (process.env[k] || "").replace(/[\s\u200b\ufeff]+/g, k === "APP_PASSWORD" ? " " : "").trim();
  if (!v) throw Object.assign(new Error(`Variable d'environnement manquante : ${k}`), { status: 500 });
  return v;
};

/* ---------- session cookie ---------- */
const COOKIE = "lgs_session";
function secret() {
  return process.env.SESSION_SECRET || env("APP_PASSWORD") + "|" + env("SUPABASE_SERVICE_KEY").slice(-16);
}
export function sessionToken() {
  return crypto.createHmac("sha256", secret()).update("suivi-devis-ok").digest("hex");
}
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
export function isLoggedIn(req) {
  const got = cookies(req)[COOKIE];
  if (!got) return false;
  const want = sessionToken();
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
export function setSession(res, on) {
  const base = `${COOKIE}=${on ? sessionToken() : ""}; Path=/; HttpOnly; Secure; SameSite=Lax`;
  res.setHeader("Set-Cookie", on ? `${base}; Max-Age=31536000` : `${base}; Max-Age=0`);
}
export function checkPassword(pw) {
  const a = Buffer.from(String(pw || "").trim().toUpperCase());
  const b = Buffer.from(env("APP_PASSWORD").trim().toUpperCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------- Supabase (REST, service key: server side only) ---------- */
export async function sb(path, { method = "GET", body, headers = {} } = {}) {
  const url = env("SUPABASE_URL").replace(/\/$/, "") + path;
  const key = env("SUPABASE_SERVICE_KEY");
  const r = await fetch(url, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const msg = (data && (data.message || data.error || data.msg)) || text || r.statusText;
    throw Object.assign(new Error(`Supabase ${r.status} : ${msg}`), { status: 502 });
  }
  return data;
}
export const supabaseUrl = () => env("SUPABASE_URL").replace(/\/$/, "");

// Every row of a table. Supabase answers at most 1000 rows per request, so read page by page.
export async function sbAll(table, query = "select=id,data") {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await sb(`/rest/v1/${table}?${query}&order=id&limit=1000&offset=${offset}`);
    out.push(...page);
    if (page.length < 1000) return out;
  }
}
export const isMissing = (e) => /PGRST20[25]|42P01|42883|Could not find|does not exist|schema cache/i.test(String(e && e.message));

/* ---------- route wrapper ---------- */
export function route(methods, fn, { auth = true } = {}) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      if (!methods.includes(req.method)) return res.status(405).json({ error: "Méthode non autorisée" });
      if (auth && !isLoggedIn(req)) return res.status(401).json({ error: "Mot de passe requis" });
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
      req.json = body || {};
      await fn(req, res);
    } catch (e) {
      console.error(e);
      res.status(e.status || 500).json({ error: e.message || "Erreur serveur" });
    }
  };
}

export const safeId = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(s);
export const safePath = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{1,80}\/[A-Za-z0-9._-]{1,160}$/.test(s);
