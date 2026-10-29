import { route, sb, sbAll, isMissing, BUCKET, safePath } from "./_lib.js";

// Called once a day by Vercel (see "crons" in vercel.json):
//  1. a real database request, so the free Supabase project never pauses for inactivity;
//  2. empties the bin: items deleted more than 30 days ago are removed for good, with their PDFs.
// It only touches items already in the bin, so it needs no password.
export default route(["GET"], async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: "Non autorisé" });

  const limit = new Date(Date.now() - 30 * 864e5).toISOString();
  const old = (t) => sbAll(t, `select=id,data&data->>deleted=lt.${encodeURIComponent(limit)}`)
    .catch((e) => { if (isMissing(e)) return []; throw e; });

  const [devis, offres, evenements] = await Promise.all([old("devis"), old("offres"), old("evenements")]);
  const devisIds = new Set(devis.map((r) => r.id));
  // proposals of a purged besoin go with it
  const extra = devisIds.size ? (await sbAll("offres")).filter((o) => devisIds.has(o.data?.devisId)) : [];
  const offresAll = [...new Map([...offres, ...extra].map((o) => [o.id, o])).values()];
  const files = offresAll.map((o) => o.data?.fichierId).filter(safePath);

  const del = async (t, ids) => {
    for (let i = 0; i < ids.length; i += 100) {
      const list = ids.slice(i, i + 100).map((x) => `"${x}"`).join(",");
      await sb(`/rest/v1/${t}?id=in.(${list})`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    }
  };
  await del("offres", offresAll.map((o) => o.id));
  await del("devis", [...devisIds]);
  if (evenements.length) await del("evenements", evenements.map((r) => r.id));
  if (files.length) await sb(`/storage/v1/object/${BUCKET}`, { method: "DELETE", body: { prefixes: files } }).catch(() => {});

  res.status(200).json({ ok: true, purged: { devis: devisIds.size, offres: offresAll.length, evenements: evenements.length, fichiers: files.length } });
}, { auth: false });
