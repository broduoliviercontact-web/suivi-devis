// Test servers: a fake Supabase (REST + storage, in memory) and a small Vercel-like server
// that serves public/ and runs the api/ functions with the headers from vercel.json.
// Nothing here ever talks to the real database.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".mjs": "text/javascript; charset=utf-8" };
const readBody = (req) => new Promise((r) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => r(Buffer.concat(c))); });
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));

// migrated=false simulates a database where supabase/migration-2.sql has not been run.
export async function startServers({ migrated = true, password = "LGS" } = {}) {
  const db = { devis: new Map(), offres: new Map(), ...(migrated ? { evenements: new Map() } : {}) };
  const files = new Map();
  let seq = null;

  const supa = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const body = await readBody(req);
    const json = () => JSON.parse(body.toString() || "null");
    const send = (s, o) => {
      res.writeHead(s, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "PUT", "Access-Control-Allow-Headers": "*" });
      res.end(o === undefined ? "" : JSON.stringify(o));
    };
    if (req.method === "OPTIONS") return send(204);
    const signed = u.searchParams.get("token");
    if (!signed && req.headers.apikey !== "test-service-key") return send(401, { message: "Invalid API key" });
    let m;
    if ((m = /^\/rest\/v1\/(devis|offres|evenements)$/.exec(u.pathname))) {
      const t = db[m[1]];
      if (!t) return send(404, { code: "42P01", message: `relation "public.${m[1]}" does not exist` });
      let list = [...t].map(([id, data]) => ({ id, data }));
      for (const [k, v] of u.searchParams) {
        if (k === "id" && v.startsWith("eq.")) list = list.filter((r) => r.id === v.slice(3));
        else if (k === "id" && v.startsWith("in.(")) { const ids = v.slice(4, -1).split(",").map((x) => x.replace(/"/g, "")); list = list.filter((r) => ids.includes(r.id)); }
        else if (k.startsWith("data->>") && v.startsWith("lt.")) { const f = k.slice(7); list = list.filter((r) => r.data[f] != null && String(r.data[f]) < v.slice(3)); }
      }
      if (req.method === "GET") {
        const order = u.searchParams.get("order") || "";
        if (order.startsWith("data->num")) list.sort((a, b) => (b.data.num || 0) - (a.data.num || 0));
        else list.sort((a, b) => (a.id < b.id ? -1 : 1));
        const off = +(u.searchParams.get("offset") || 0), lim = Math.min(+(u.searchParams.get("limit") || 1000), 1000); // Supabase caps at 1000
        list = list.slice(off, off + lim);
        const sel = u.searchParams.get("select") || "";
        if (sel.startsWith("num:")) return send(200, list.map((r) => ({ num: r.data.num })));
        if (sel === "data") return send(200, list.map((r) => ({ data: r.data })));
        return send(200, list);
      }
      if (req.method === "POST") { for (const r of json()) t.set(r.id, r.data); return send(201); }
      if (req.method === "DELETE") { for (const r of list) t.delete(r.id); return send(204); }
    }
    if (u.pathname === "/rest/v1/rpc/merge_doc") {
      const { t, doc_id, patch } = json();
      if (!db[t]) return send(400, { message: "table inconnue" });
      const o = db[t].get(doc_id); if (o) Object.assign(o, patch);
      return send(204);
    }
    if (u.pathname === "/rest/v1/rpc/create_devis") {
      if (!migrated) return send(404, { code: "PGRST202", message: "Could not find the function public.create_devis in the schema cache" });
      if (seq == null) seq = [...db.devis.values()].reduce((m, d) => Math.max(m, d.num || 0), 0);
      const { doc_id, doc } = json(); const n = ++seq;
      await new Promise((r) => setTimeout(r, 20));
      db.devis.set(doc_id, { ...doc, num: n });
      return send(200, n);
    }
    if (u.pathname === "/storage/v1/object/devis" && req.method === "DELETE") { for (const p of json().prefixes) files.delete(p); return send(200, []); }
    if ((m = /^\/storage\/v1\/object\/upload\/sign\/devis\/(.+)$/.exec(u.pathname))) {
      if (req.method === "POST") return send(200, { url: `/object/upload/sign/devis/${m[1]}?token=up` });
      if (req.method === "PUT") { files.set(decodeURIComponent(m[1]), { type: req.headers["content-type"], body }); return send(200, { Key: m[1] }); }
    }
    if ((m = /^\/storage\/v1\/object\/sign\/devis\/(.+)$/.exec(u.pathname))) {
      if (req.method === "POST") return send(200, { signedURL: `/object/sign/devis/${m[1]}?token=dl` });
      const f = files.get(decodeURIComponent(m[1]));
      if (!f) return send(404, { message: "not found" });
      res.writeHead(200, { "Content-Type": f.type, "Access-Control-Allow-Origin": "*" }); return res.end(f.body);
    }
    send(404, { message: "no route " + u.pathname });
  });
  const supaPort = await listen(supa);
  const supaUrl = `http://127.0.0.1:${supaPort}`;
  Object.assign(process.env, { APP_PASSWORD: password, SUPABASE_URL: supaUrl, SUPABASE_SERVICE_KEY: "test-service-key" });

  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
  const headers = vercel.headers[0].headers.map((h) => ({ ...h, value: h.value.replace("https://*.supabase.co", supaUrl) }));
  const web = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    for (const h of headers) res.setHeader(h.key, h.value);
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); };
    if (u.pathname.startsWith("/api/")) {
      const b = await readBody(req);
      req.body = (req.headers["content-type"] || "").includes("json") && b.length ? JSON.parse(b) : b.toString();
      req.query = Object.fromEntries(u.searchParams);
      const f = path.join(ROOT, "api", path.basename(u.pathname) + ".js");
      if (path.basename(f).startsWith("_") || !fs.existsSync(f)) { res.statusCode = 404; return res.end(); }
      return (await import(pathToFileURL(f))).default(req, res);
    }
    const p = path.join(ROOT, "public", u.pathname === "/" ? "index.html" : path.normalize(u.pathname));
    if (p.startsWith(path.join(ROOT, "public")) && fs.existsSync(p) && fs.statSync(p).isFile()) {
      res.setHeader("Content-Type", TYPES[path.extname(p)] || "application/octet-stream");
      return res.end(fs.readFileSync(p));
    }
    res.statusCode = 404; res.end();
  });
  const webPort = await listen(web);

  return {
    base: `http://127.0.0.1:${webPort}`,
    db, files,
    seed(data) { for (const t in data) for (const [id, d] of Object.entries(data[t])) db[t].set(id, structuredClone(d)); },
    close: () => Promise.all([new Promise((r) => web.close(r)), new Promise((r) => supa.close(r))]),
  };
}

// Logs in and returns the session cookie header.
export async function login(base, password = "LGS") {
  const r = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
  const c = r.headers.get("set-cookie") || "";
  return { ok: r.ok, status: r.status, cookie: c.split(";")[0] };
}
