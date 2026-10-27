import { route, sb, supabaseUrl, BUCKET, safePath } from "./_lib.js";

// GET ?p=<path>  -> opens the file (short-lived signed link).
// POST {path, op:"delete"} -> removes a file that no proposal points to anymore.
export default route(["GET", "POST"], async (req, res) => {
  if (req.method === "POST") {
    const { path, op } = req.json;
    if (op !== "delete" || !safePath(path)) return res.status(400).json({ error: "Requête invalide" });
    await sb(`/storage/v1/object/${BUCKET}`, { method: "DELETE", body: { prefixes: [path] } });
    return res.status(200).json({ ok: true });
  }
  const p = String(req.query?.p || new URL(req.url, "http://x").searchParams.get("p") || "");
  if (!safePath(p)) return res.status(400).json({ error: "Fichier invalide" });
  const r = await sb(`/storage/v1/object/sign/${BUCKET}/${p}`, { method: "POST", body: { expiresIn: 600 } });
  const rel = r.signedURL || r.signedUrl;
  res.setHeader("Location", `${supabaseUrl()}/storage/v1${rel.startsWith("/") ? rel : "/" + rel}`);
  res.status(302).end();
});
