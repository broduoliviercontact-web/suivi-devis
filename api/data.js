import { route, sbAll, isMissing } from "./_lib.js";

// Everything the page shows: besoins (devis), proposals (offres) and event sheets (evenements).
// Items in the bin carry data.deleted (date) and are returned too, for the « Corbeille ».
export default route(["GET"], async (req, res) => {
  const [devis, offres, ev] = await Promise.all([
    sbAll("devis"),
    sbAll("offres"),
    sbAll("evenements").then((r) => ({ rows: r, ok: true })).catch((e) => {
      if (isMissing(e)) return { rows: [], ok: false }; // migration not run yet
      throw e;
    }),
  ]);
  const flat = (rows) => rows.map((r) => ({ _id: r.id, ...r.data }));
  res.status(200).json({ devis: flat(devis), offres: flat(offres), evenements: flat(ev.rows), evTable: ev.ok });
});
