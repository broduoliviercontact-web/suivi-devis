import crypto from "node:crypto";
import { route, sb, supabaseUrl, BUCKET } from "./_lib.js";

const TYPES = ["application/pdf", "image/png", "image/jpeg", "image/webp"];

// POST {name, type} -> {path, uploadUrl}. The browser then sends the file straight to
// Supabase with PUT, so large PDFs do not go through Vercel (which caps request bodies).
export default route(["POST"], async (req, res) => {
  const { name, type } = req.json;
  if (!TYPES.includes(type)) return res.status(400).json({ error: "Ce type de fichier n'est pas accepté. Envoie un PDF ou une image." });
  const clean = String(name || "devis").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(-120) || "devis";
  const path = `${new Date().getFullYear()}/${crypto.randomBytes(6).toString("hex")}-${clean}`;
  const r = await sb(`/storage/v1/object/upload/sign/${BUCKET}/${path}`, { method: "POST", body: {} });
  const rel = r.url || r.signedURL;
  res.status(200).json({ path, uploadUrl: `${supabaseUrl()}/storage/v1${rel.startsWith("/") ? rel : "/" + rel}` });
});
