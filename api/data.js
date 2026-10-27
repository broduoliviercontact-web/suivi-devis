import { route, sb } from "./_lib.js";

// Everything the page shows: all besoins (devis) and all proposals (offres).
export default route(["GET"], async (req, res) => {
  const [devis, offres] = await Promise.all([
    sb("/rest/v1/devis?select=id,data&limit=10000"),
    sb("/rest/v1/offres?select=id,data&limit=20000"),
  ]);
  res.status(200).json({
    devis: devis.map((r) => ({ _id: r.id, ...r.data })),
    offres: offres.map((r) => ({ _id: r.id, ...r.data })),
  });
});
