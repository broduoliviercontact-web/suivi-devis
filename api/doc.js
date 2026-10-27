import { route, sb, TABLES, safeId, BUCKET, safePath } from "./_lib.js";

// POST {table, id, op: "set"|"update"|"delete", data}
//   set    = create or replace the whole document
//   update = merge fields into the existing document
//   delete = remove it (and, for a proposal, its attached file)
export default route(["POST"], async (req, res) => {
  const { table, id, op, data } = req.json;
  if (!TABLES.includes(table)) return res.status(400).json({ error: "Table inconnue" });
  if (!safeId(id)) return res.status(400).json({ error: "Identifiant invalide" });
  const isObj = data && typeof data === "object" && !Array.isArray(data);
  if ((op === "set" || op === "update") && !isObj) return res.status(400).json({ error: "Données invalides" });
  if (isObj && JSON.stringify(data).length > 100000) return res.status(413).json({ error: "Données trop longues" });

  if (op === "set") {
    await sb(`/rest/v1/${table}`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: [{ id, data }],
    });
  } else if (op === "update") {
    await sb(`/rest/v1/rpc/merge_doc`, { method: "POST", body: { t: table, doc_id: id, patch: data } });
  } else if (op === "delete") {
    let file = null;
    if (table === "offres") {
      const rows = await sb(`/rest/v1/offres?id=eq.${id}&select=data`);
      file = rows[0]?.data?.fichierId || null;
    }
    await sb(`/rest/v1/${table}?id=eq.${id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    if (file && safePath(file)) {
      await sb(`/storage/v1/object/${BUCKET}`, { method: "DELETE", body: { prefixes: [file] } }).catch(() => {});
    }
  } else {
    return res.status(400).json({ error: "Opération inconnue" });
  }
  res.status(200).json({ ok: true });
});
