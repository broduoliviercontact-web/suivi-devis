// Server tests: password, security headers, numbering, bin, pagination, daily clean-up, files.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServers, login } from "./server.mjs";

describe("serveur (base à jour)", () => {
  let s, H;
  const post = (path, body) => fetch(s.base + path, { method: "POST", headers: { "Content-Type": "application/json", Cookie: H }, body: JSON.stringify(body) });
  const doc = (body) => post("/api/doc", body).then(async (r) => ({ status: r.status, body: await r.json() }));
  const data = () => fetch(s.base + "/api/data", { headers: { Cookie: H } }).then((r) => r.json());
  before(async () => { s = await startServers(); H = (await login(s.base)).cookie; });
  after(() => s.close());

  test("sans mot de passe, aucune donnée", async () => {
    for (const p of ["/api/data", "/api/file?p=2026/a.pdf"]) assert.equal((await fetch(s.base + p)).status, 401, p);
    const r = await fetch(s.base + "/api/doc", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(r.status, 401);
  });

  test("mauvais mot de passe refusé, bon mot de passe accepté (majuscules indifférentes)", async () => {
    assert.equal((await login(s.base, "nope")).status, 401);
    const ok = await login(s.base, " lgs ");
    assert.ok(ok.ok); assert.match(ok.cookie, /^lgs_session=[0-9a-f]{64}$/);
  });

  test("en-têtes de sécurité", async () => {
    const r = await fetch(s.base + "/");
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    const csp = r.headers.get("content-security-policy");
    assert.match(csp, /frame-ancestors 'none'/); assert.match(csp, /script-src 'self'(;|$)/);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  });

  test("20 besoins créés en même temps reçoivent 20 numéros différents", async () => {
    s.seed({ devis: { old: { num: 25, objet: "Existant" } } });
    const res = await Promise.all(Array.from({ length: 20 }, (_, i) => doc({ table: "devis", id: "c" + i, op: "create", data: { objet: "x" + i, num: 1 } })));
    const nums = res.map((r) => r.body.num).sort((a, b) => a - b);
    assert.deepEqual(nums, Array.from({ length: 20 }, (_, i) => 26 + i));
    assert.equal(s.db.devis.get("c0").num !== 1, true, "le numéro envoyé par la page est ignoré");
  });

  test("modifier fusionne les champs sans écraser les autres", async () => {
    s.seed({ devis: { m1: { num: 1, objet: "Talkies", aEnvoyer: true } } });
    await doc({ table: "devis", id: "m1", op: "update", data: { signe: true } });
    assert.deepEqual(s.db.devis.get("m1"), { num: 1, objet: "Talkies", aEnvoyer: true, signe: true });
  });

  test("supprimer met à la corbeille, restaurer la vide", async () => {
    s.seed({ devis: { b1: { num: 2, objet: "Scène" } } });
    await doc({ table: "devis", id: "b1", op: "delete" });
    assert.ok(s.db.devis.get("b1").deleted, "toujours en base, marqué supprimé");
    assert.ok((await data()).devis.find((d) => d._id === "b1").deleted);
    await doc({ table: "devis", id: "b1", op: "restore" });
    assert.equal(s.db.devis.get("b1").deleted, null);
  });

  test("plus de 1000 propositions : tout est renvoyé", async () => {
    const offres = {};
    for (let i = 0; i < 2500; i++) offres["p" + String(i).padStart(5, "0")] = { devisId: "x", fournisseur: "F", version: 1 };
    s.seed({ offres });
    const d = await data();
    assert.equal(d.offres.filter((o) => o._id.startsWith("p")).length, 2500);
    assert.equal(d.evTable, true);
  });

  test("le nettoyage quotidien efface la corbeille de plus de 30 jours, avec propositions et PDF", async () => {
    const old = new Date(Date.now() - 40 * 864e5).toISOString(), recent = new Date(Date.now() - 2 * 864e5).toISOString();
    s.files.set("2026/vieux.pdf", { type: "application/pdf", body: Buffer.from("%PDF") });
    s.seed({
      devis: { vieux: { num: 90, deleted: old }, recent: { num: 91, deleted: recent }, vivant: { num: 92 } },
      offres: { ov: { devisId: "vieux", fichierId: "2026/vieux.pdf" }, ok: { devisId: "vivant" } },
      evenements: { evv: { nom: "Ancien", deleted: old } },
    });
    const r = await (await fetch(s.base + "/api/daily")).json();
    assert.deepEqual(r.purged, { devis: 1, offres: 1, evenements: 1, fichiers: 1 });
    assert.ok(!s.db.devis.has("vieux") && s.db.devis.has("recent") && s.db.devis.has("vivant"));
    assert.ok(!s.db.offres.has("ov") && s.db.offres.has("ok"));
    assert.ok(!s.files.has("2026/vieux.pdf"));
  });

  test("envoi et ouverture d'un PDF", async () => {
    const r = await (await post("/api/upload-url", { name: "Devis été #2.pdf", type: "application/pdf" })).json();
    assert.match(r.path, /^2026\/[0-9a-f]{12}-Devis_ete_2\.pdf$|^\d{4}\/[0-9a-f]{12}-Devis_ete_2\.pdf$/);
    assert.equal((await fetch(r.uploadUrl, { method: "PUT", headers: { "Content-Type": "application/pdf" }, body: "%PDF-1.4" })).status, 200);
    const open = await fetch(s.base + "/api/file?p=" + encodeURIComponent(r.path), { headers: { Cookie: H }, redirect: "manual" });
    assert.equal(open.status, 302);
    assert.equal(await (await fetch(open.headers.get("location"))).text(), "%PDF-1.4");
  });

  test("demandes invalides refusées", async () => {
    assert.equal((await post("/api/upload-url", { name: "x.exe", type: "application/x-msdownload" })).status, 400);
    for (const p of ["../../etc/passwd", "2026/../x.pdf", "a/b/c.pdf"])
      assert.equal((await fetch(s.base + "/api/file?p=" + encodeURIComponent(p), { headers: { Cookie: H } })).status, 400, p);
    assert.equal((await doc({ table: "users", id: "a", op: "set", data: {} })).status, 400);
    assert.equal((await doc({ table: "devis", id: "a b", op: "set", data: {} })).status, 400);
    assert.equal((await doc({ table: "devis", id: "a", op: "set", data: [1] })).status, 400);
    assert.equal((await doc({ table: "devis", id: "a", op: "drop", data: {} })).status, 400);
  });
});

describe("serveur (base pas encore à jour)", () => {
  let s, H;
  before(async () => { s = await startServers({ migrated: false }); H = (await login(s.base)).cookie; });
  after(() => s.close());

  test("les numéros se suivent quand même et le site signale la mise à jour manquante", async () => {
    s.seed({ devis: { d1: { num: 7 } } });
    const nums = [];
    for (let i = 0; i < 3; i++) {
      const r = await fetch(s.base + "/api/doc", { method: "POST", headers: { "Content-Type": "application/json", Cookie: H }, body: JSON.stringify({ table: "devis", id: "n" + i, op: "create", data: {} }) });
      nums.push((await r.json()).num);
    }
    assert.deepEqual(nums, [8, 9, 10]);
    const d = await (await fetch(s.base + "/api/data", { headers: { Cookie: H } })).json();
    assert.equal(d.evTable, false); assert.deepEqual(d.evenements, []);
    assert.equal((await fetch(s.base + "/api/daily")).status, 200);
  });
});
