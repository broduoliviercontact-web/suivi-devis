import { route, sb, TABLES, safeId, isMissing } from "./_lib.js";

// POST {table, id, op, data}
//   create  = new besoin: the database gives it the next number (#023…), returned as {num}
//   set     = create or replace the whole document
//   update  = merge fields into the existing document
//   delete  = move to the bin (data.deleted = now); purged for good after 30 days by /api/daily
//   restore = take it out of the bin
export default route(["POST"], async (req, res) => {
  const { table, id, op, data } = req.json;
  if (!TABLES.includes(table)) return res.status(400).json({ error: "Table inconnue" });
  if (!safeId(id)) return res.status(400).json({ error: "Identifiant invalide" });
  const isObj = data && typeof data === "object" && !Array.isArray(data);
  if (["create", "set", "update"].includes(op) && !isObj) return res.status(400).json({ error: "Données invalides" });
  if (isObj && JSON.stringify(data).length > 100000) return res.status(413).json({ error: "Données trop longues" });

  const merge = (patch) => sb(`/rest/v1/rpc/merge_doc`, { method: "POST", body: { t: table, doc_id: id, patch } });

  if (op === "create") {
    if (table !== "devis") return res.status(400).json({ error: "Opération inconnue" });
    const { num: _ignored, ...doc } = data;
    let num;
    try {
      num = await sb(`/rest/v1/rpc/create_devis`, { method: "POST", body: { doc_id: id, doc } });
    } catch (e) {
      if (!isMissing(e)) throw e;
      // Before the database update (supabase/migration-2.sql): next number computed here.
      const top = await sb(`/rest/v1/devis?select=num:data->num&order=data->num.desc.nullslast&limit=1`);
      num = (Number(top[0]?.num) || 0) + 1;
      await sb(`/rest/v1/devis`, { method: "POST", headers: { Prefer: "return=minimal" }, body: [{ id, data: { ...doc, num } }] });
    }
    return res.status(200).json({ ok: true, num: Number(num) });
  }
  if (op === "set") {
    await sb(`/rest/v1/${table}`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: [{ id, data }],
    });
  } else if (op === "update") {
    await merge(data);
  } else if (op === "delete") {
    await merge({ deleted: new Date().toISOString() });
  } else if (op === "restore") {
    await merge({ deleted: null });
  } else {
    return res.status(400).json({ error: "Opération inconnue" });
  }
  res.status(200).json({ ok: true });
});
