// Browser tests (Chromium), on a desktop screen and an iPhone screen.
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import { startServers } from "./server.mjs";
const { chromium, devices } = createRequire(import.meta.url)("playwright");

const ST = (c) => ({ c, b: true, i: false, s: false, l: false, u: false, z: "m" });
const SEED = {
  evenements: { ev1: { nom: "Ouverture de la halle", date: "2026-11-06", dateFin: "2026-11-08", lieu: "Grandes Serres", style: ST("blue") } },
  devis: {
    d1: { num: 1, eventId: "ev1", evenement: "Ouverture de la halle", objet: "Talkies", type: "location", debut: "2026-11-05", hDebut: "09:00", fin: "2026-11-09", hFin: "14:30", aEnvoyer: true },
    d2: { num: 2, evenement: "Inauguration 5/12", objet: "Sanitaires", type: "location" },
    d3: { num: 3, evenement: "VOEUX DU MAIRE 06/01/27", objet: "Gaffer", type: "achat" },
  },
  offres: {
    o1: { devisId: "d1", fournisseur: "TSF", montant: 380, version: 1, retenue: false, detail: "20 talkies", cree: "2026-10-27T10:00:00Z" },
    o2: { devisId: "d1", fournisseur: "Impact", montant: 450, version: 1, retenue: false, cree: "2026-10-27T10:00:00Z" },
  },
};

let s, browser;
const problems = [];
const contexts = [];
async function open(ctxOptions = { viewport: { width: 1240, height: 900 } }) {
  const ctx = await browser.newContext({ ...ctxOptions, acceptDownloads: true });
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => problems.push("erreur JS : " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/401 \(Unauthorized\)/.test(m.text())) problems.push("console : " + m.text()); });
  await page.goto(s.base);
  await page.fill("#gatePw", "LGS");
  await page.click("#gateForm button");
  await page.waitForSelector("#app:not([hidden])");
  await page.waitForSelector("[data-open]");
  return page;
}
const objets = (page) => page.$$eval(".obj", (els) => els.map((e) => e.textContent.trim()));
const eventNames = (page) => page.$$eval(".ev-name", (els) => els.map((e) => e.textContent.trim()));
// Waits for the proposal form after « Créer le besoin »; on failure says why (error shown, fiche state).
async function waitOffer(page) {
  try { await page.waitForSelector("#offerForm:not([hidden])", { timeout: 8000 }); }
  catch (e) {
    await page.screenshot({ path: "/tmp/claude-0/-home-claude/569f0a9a-91da-5b2b-8cd2-a5d7dbc6753b/scratchpad/offer-fail.png" }).catch(() => {});
    throw new Error("formulaire de proposition absent : " + JSON.stringify(await page.evaluate(() => ({ err: document.getElementById("fErr").hidden ? null : document.getElementById("fErr").textContent, veil: !document.getElementById("veil").hidden, title: document.getElementById("pTitle").textContent, ev: document.getElementById("fEvent").value, obj: document.getElementById("fObjet").value, focus: document.activeElement && document.activeElement.id, discard: !!document.querySelector(".discard:not([hidden])") }))));
  }
}
// Opens « Nouveau besoin » and waits until the fiche has placed the cursor (as a person would).
async function newBesoin(page, sel = "#addBtn") {
  await page.click(sel);
  await page.waitForFunction(() => ["fEvent", "fObjet"].includes(document.activeElement && document.activeElement.id));
}
const focused = (page) => page.evaluate(() => { const e = document.activeElement; return e && (e.id || e.textContent.trim().slice(0, 40)); });

before(async () => { browser = await chromium.launch(); });
after(async () => { await browser.close(); });
beforeEach(async () => { s = await startServers(); s.seed(SEED); problems.length = 0; });
afterEach(async () => { await Promise.all(contexts.splice(0).map((c) => c.close())); await s.close(); assert.deepEqual(problems, [], "aucune erreur dans la page"); });

describe("ordinateur", () => {
  test("le mot de passe protège la page", async () => {
    const ctx = await browser.newContext(); contexts.push(ctx); const page = await ctx.newPage();
    await page.goto(s.base);
    assert.ok(await page.isVisible("#gate")); assert.ok(await page.isHidden("#app"));
    await page.fill("#gatePw", "faux"); await page.click("#gateForm button");
    await page.waitForSelector("#gateErr:not([hidden])");
    assert.equal(await page.textContent("#gateErr"), "Mot de passe incorrect.");
    await ctx.close();
  });

  test("événements classés par date, cases enregistrées", async () => {
    const page = await open();
    assert.deepEqual(await eventNames(page), ["Ouverture de la halle", "Inauguration 5/12"], "la partie Location ne montre que les locations");
    await page.click('.ck[data-id="d2"][data-k="envoye"]');
    await page.waitForTimeout(500);
    assert.equal(s.db.devis.get("d2").envoye, true);
    await page.reload(); await page.waitForSelector("[data-open]");
    assert.equal(await page.getAttribute('.ck[data-id="d2"][data-k="envoye"]', "aria-pressed"), "true");
  });

  test("créer un besoin et sa proposition", async () => {
    const page = await open();
    await newBesoin(page);
    await page.fill("#fEvent", "ouverture de la halle"); // casse différente : même événement
    await page.fill("#fObjet", "Praticables");
    await page.click("#saveBtn");
    await waitOffer(page);
    await page.fill("#oFour", "ASD"); await page.fill("#oMontant", "1 250,50");
    await page.click("#oSave");
    await page.waitForTimeout(800);
    const d = [...s.db.devis.values()].find((x) => x.objet === "Praticables");
    assert.equal(d.num, 4); assert.equal(d.eventId, "ev1");
    const o = [...s.db.offres.values()].find((x) => x.fournisseur === "ASD");
    assert.equal(o.montant, 1250.5); assert.equal(o.version, 1);
    assert.match(await page.textContent("#pTitle"), /^#004 · Praticables$/);
  });

  test("une saisie en cours n'est jamais perdue", async () => {
    const page = await open();
    await page.click('[data-open="d2"] >> nth=0');
    await page.fill("#fObjet", "Sanitaires PMR");
    await page.mouse.click(20, 880); // clic à côté
    assert.ok(await page.isVisible("#veil"));
    assert.ok(await page.isVisible(".discard"));
    assert.equal(await page.inputValue("#fObjet"), "Sanitaires PMR");
    await page.keyboard.press("Escape");
    assert.ok(await page.isVisible("#veil"));
    await page.click('[data-d="drop"]');
    assert.ok(await page.isHidden("#veil"));
    assert.equal(s.db.devis.get("d2").objet, "Sanitaires");
  });

  test("fiche événement : dates, lieu, nouvel événement vide", async () => {
    const page = await open();
    await page.click('[data-ev="ev-inauguration-5-12"]');
    assert.equal(await page.inputValue("#evD1"), "2026-12-05", "date reprise du nom");
    await page.fill("#evName", "Inauguration du parvis"); await page.fill("#evLieu", "Pantin");
    await page.click("#evForm button[type=submit]");
    await page.click("[data-newev]");
    await page.fill("#evName", "Salon pro"); await page.fill("#evD1", "2026-11-20");
    await page.click("#evForm button[type=submit]");
    await page.waitForTimeout(800);
    assert.deepEqual(await eventNames(page), ["Ouverture de la halle", "Salon pro", "Inauguration du parvis"]);
    const ev = [...s.db.evenements.values()].find((e) => e.nom === "Inauguration du parvis");
    assert.equal(ev.lieu, "Pantin"); assert.equal(ev.date, "2026-12-05");
    assert.equal(s.db.devis.get("d2").evenement, "Inauguration du parvis");
  });

  test("corbeille : annuler tout de suite, ou restaurer plus tard", async () => {
    const page = await open();
    const del = async () => { await page.click('[data-open="d2"] >> nth=0'); await page.click("#delBtn"); await page.click("#delBtn"); };
    await del();
    assert.ok(!(await objets(page)).includes("Sanitaires"));
    await page.click("#toastUndo"); await page.waitForTimeout(600);
    assert.ok((await objets(page)).includes("Sanitaires"));
    assert.equal(s.db.devis.get("d2").deleted, null);
    await del(); await page.waitForTimeout(800);
    assert.equal(await page.textContent("#trashBtn"), "Corbeille (1)");
    await page.click("#trashBtn"); await page.click('[data-restore="devis"]'); await page.waitForTimeout(600);
    await page.click("#trBack");
    assert.ok((await objets(page)).includes("Sanitaires"));
  });

  test("export Excel", async () => {
    const page = await open();
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#exportCsv")]);
    const csv = fs.readFileSync(await dl.path(), "utf8");
    assert.ok(csv.startsWith("\ufeffN°;Partie;Événement / catégorie;"));
    assert.ok(csv.includes("#001;Location Événementielle;Ouverture de la halle;2026-11-06 → 2026-11-08;Grandes Serres;Talkies;2026-11-05;09:00;2026-11-09;14:30;oui;"));
    assert.ok(csv.includes("#003;Achat DTSE;VOEUX DU MAIRE 06/01/27;;;Gaffer;;;;;;;;;;;"), "les achats aussi, avec leurs propres étapes");
    assert.ok(csv.includes(";TSF;V1;380;"));
  });

  test("clavier : la fiche garde le focus et le rend à la fermeture", async () => {
    const page = await open();
    await page.focus('[data-open="d1"] >> nth=0');
    await page.keyboard.press("Enter");
    await page.waitForSelector("#veil:not([hidden])");
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press(i % 2 ? "Tab" : "Shift+Tab");
      assert.ok(await page.evaluate(() => document.getElementById("veil").contains(document.activeElement)), "le focus reste dans la fiche");
    }
    assert.ok(await page.evaluate(() => document.getElementById("app").inert), "la page derrière est inactive");
    await page.keyboard.press("Escape");
    await page.waitForSelector("#veil", { state: "hidden" });
    assert.equal(await page.evaluate(() => document.activeElement.dataset.open), "d1");
    assert.ok(await page.evaluate(() => !document.getElementById("app").inert));
  });

  test("clavier : les onglets se pilotent aux flèches", async () => {
    const page = await open();
    await page.focus("#tabEv");
    await page.keyboard.press("ArrowRight"); assert.equal(await focused(page), "tabMem"); assert.ok(await page.isVisible("#viewMem"));
    await page.keyboard.press("ArrowRight"); assert.equal(await focused(page), "tabCal"); assert.ok(await page.isVisible("#viewCal"));
    await page.keyboard.press("ArrowRight"); assert.equal(await focused(page), "tabEv");
    await page.keyboard.press("End"); assert.equal(await focused(page), "tabCal");
    await page.keyboard.press("Home"); assert.equal(await focused(page), "tabEv");
    assert.deepEqual(await page.$$eval('[role="tab"]', (t) => t.map((x) => x.tabIndex)), [0, -1, -1]);
  });

  test("propositions dépliées, calendrier avec heures", async () => {
    const page = await open();
    await page.click('[data-toggle="d1"]');
    assert.equal(await page.locator(".subrow").count(), 2);
    assert.match(await page.textContent(".subrow >> nth=1"), /\+70,00\s€\s\(\+18\s%\)/u); // espaces insécables du format français
    await page.click("#tabCal");
    for (let i = 0; i < 24 && !/novembre 2026/i.test(await page.textContent("#calTitle")); i++)
      await page.click(new Date() < new Date(2026, 10, 1) ? "#calNext" : "#calPrev");
    assert.match(await page.textContent(".cbar >> nth=0"), /Arrivée 9h/);
    assert.match(await page.textContent(".cbar >> nth=1"), /Reprise 14h30/);
  });
});

describe("achats", () => {
  test("livraison sans reprise : fiche, tableau et calendrier", async () => {
    const page = await open();
    await page.click("#spAch");
    await page.click('[data-open="d3"] >> nth=0');
    assert.equal(await page.textContent("#whenInL"), "Livraison (facultatif)");
    assert.ok(await page.isHidden("#whenOut"), "pas de reprise pour un achat");
    await page.fill("#fDebut", "2026-11-04"); await page.fill("#fHDebut", "10:30");
    await page.click("#saveBtn"); await page.waitForTimeout(500);
    const d = s.db.devis.get("d3");
    assert.equal(d.debut, "2026-11-04"); assert.equal(d.hDebut, "10:30"); assert.equal(d.fin, null);
    await page.click("#closeBtn");
    assert.match(await page.textContent('.row:has([data-open="d3"]) .dates'), /^Livraison mer 4 nov\s10h30$/u);
    // a location switched to purchase keeps only the delivery
    await page.click("#spLoc");
    await page.click('[data-open="d1"] >> nth=0'); await page.click('#fKind [data-k="achat"]');
    assert.ok(await page.isHidden("#whenOut"));
    await page.click("#saveBtn"); await page.waitForTimeout(500); await page.click("#closeBtn");
    assert.equal(s.db.devis.get("d1").fin, null); assert.equal(s.db.devis.get("d1").hFin, null);
    await page.click("#tabCal");
    for (let i = 0; i < 24 && !/novembre 2026/i.test(await page.textContent("#calTitle")); i++)
      await page.click(new Date() < new Date(2026, 10, 1) ? "#calNext" : "#calPrev");
    assert.equal(await page.textContent("#calCount"), "2 livraisons ce mois-ci");
    const bar = await page.textContent('.cbar[data-open="d3"]');
    assert.match(bar, /Livraison 10h30/); assert.doesNotMatch(bar, /Reprise/);
    assert.equal(await page.locator('.cbar[data-open="d1"]').count(), 1, "une seule case, pas une barre sur plusieurs jours");
  });
});

describe("deux parties : Location Événementielle / Achat DTSE", () => {
  test("chaque partie a ses besoins, ses étapes et ses filtres", async () => {
    const page = await open();
    assert.equal(await page.getAttribute("#spLoc", "aria-pressed"), "true");
    assert.ok(!(await objets(page)).includes("Gaffer"));
    await page.click("#spAch");
    assert.equal(await page.textContent("#tabEv"), "Achats");
    assert.deepEqual(await objets(page), ["Gaffer"]);
    assert.deepEqual(await page.$$eval(".row.th >> nth=0", (r) => [...r[0].children].slice(3, 7).map((c) => c.textContent)), ["Devis demandé", "Commandé", "Livré", "Payé"]);
    assert.deepEqual(await page.$$eval("#filters button", (b) => b.map((x) => x.firstChild.textContent)), ["Tous", "Devis en attente", "À livrer", "À payer", "Factures en attente"]);
    await page.click('.ck[data-id="d3"][data-k="commande"]'); await page.waitForTimeout(400);
    assert.equal(s.db.devis.get("d3").commande, true);
    assert.equal(await page.textContent('#filters [data-f="livrer"] .n'), "1");
    await page.reload(); await page.waitForSelector("[data-open]");
    assert.equal(await page.getAttribute("#spAch", "aria-pressed"), "true", "la partie choisie est retenue");
    assert.match(page.url(), /#achats$/);
  });

  test("Nouveau besoin : réglé sur la partie, un nom nouveau crée une catégorie", async () => {
    const page = await open();
    await page.click("#spAch"); await newBesoin(page);
    assert.equal(await page.getAttribute('#fKind [data-k="achat"]', "aria-pressed"), "true");
    assert.equal(await page.textContent("#fEventL"), "Événement ou catégorie");
    await page.fill("#fEvent", "Consommables"); await page.fill("#fObjet", "Gaffer noir 50 mm");
    await page.click("#saveBtn"); await waitOffer(page);
    await page.click("#oCancel"); await page.click("#closeBtn"); await page.waitForTimeout(600);
    const cat = [...s.db.evenements.entries()].find(([, e]) => e.nom === "Consommables");
    assert.ok(cat && cat[1].kind === "categorie");
    assert.equal([...s.db.devis.values()].find((d) => d.objet === "Gaffer noir 50 mm").eventId, cat[0]);
    assert.deepEqual(await eventNames(page), ["Consommables", "VOEUX DU MAIRE 06/01/27"], "catégories d'abord, puis événements");
    assert.ok(await page.$eval('.ev-name >> nth=0', (e) => e.classList.contains("is-cat")));
    // une location ne peut pas aller dans une catégorie
    await page.click("#spLoc"); await newBesoin(page);
    await page.fill("#fEvent", "Consommables"); await page.fill("#fObjet", "Talkies");
    await page.click("#saveBtn");
    assert.match(await page.textContent("#fErr"), /catégorie d'achats/);
    await page.click("#closeBtn"); await page.click('[data-d="drop"]');
    // et une catégorie vide se crée depuis la partie Achat
    await page.click("#spAch"); await page.click('[data-newev="cat"]');
    assert.equal(await page.textContent("#evTitle"), "Nouvelle catégorie");
    assert.ok(await page.isHidden("#evDatesRow"));
    await page.fill("#evName", "Outillage"); await page.click("#evForm button[type=submit]"); await page.waitForTimeout(500);
    assert.deepEqual(await eventNames(page), ["Consommables", "Outillage", "VOEUX DU MAIRE 06/01/27"]);
  });

  test("l'étiquette ACHAT / LOCATION fait changer de partie, avec Annuler", async () => {
    const page = await open();
    await page.click('[data-kind="d2"]'); await page.waitForTimeout(400);
    assert.equal(s.db.devis.get("d2").type, "achat");
    assert.ok(!(await objets(page)).includes("Sanitaires"));
    assert.match(await page.textContent("#toastText"), /passé dans « Achat DTSE »/);
    await page.click("#toastUndo"); await page.waitForTimeout(400);
    assert.equal(s.db.devis.get("d2").type, "location");
    assert.ok((await objets(page)).includes("Sanitaires"));
  });

  test("calendrier commun : Tout / Locations / Livraisons", async () => {
    s.seed({ devis: { d3: { ...SEED.devis.d3, debut: "2026-11-07", hDebut: "08:00" } } });
    const page = await open();
    await page.click("#tabCal");
    for (let i = 0; i < 24 && !/novembre 2026/i.test(await page.textContent("#calTitle")); i++)
      await page.click(new Date() < new Date(2026, 10, 1) ? "#calNext" : "#calPrev");
    await page.click('[data-cf="tout"]');
    assert.equal(await page.textContent("#calCount"), "1 location · 1 livraison ce mois-ci");
    await page.click('[data-cf="liv"]');
    assert.equal(await page.locator('.cbar[data-open="d1"]').count(), 0);
    assert.equal(await page.locator('.cbar[data-open="d3"]').count(), 1);
    await page.click('[data-cf="loc"]');
    assert.equal(await page.locator('.cbar[data-open="d3"]').count(), 0);
    await page.click("#spAch");
    assert.ok(await page.isVisible("#viewCal"), "le calendrier reste ouvert en changeant de partie");
  });
});

describe("synchronisation", () => {
  test("un rafraîchissement lent ne fait jamais disparaître un besoin qu'on vient de créer", async () => {
    await s.close(); s = await startServers({ readDelay: 400 }); s.seed(SEED);
    const page = await open();
    for (let i = 0; i < 4; i++) {
      s.db.devis.get("d2").envoye = !s.db.devis.get("d2").envoye; // quelqu'un d'autre coche une case
      await page.evaluate(() => { refresh(); }); // une lecture part (sans attendre sa fin)…
      await newBesoin(page); await page.fill("#fEvent", "Ouverture de la halle"); await page.fill("#fObjet", "Test " + i);
      await page.click("#saveBtn"); // …pendant qu'on crée un besoin
      await waitOffer(page);
      await page.waitForTimeout(900);
      assert.ok(await page.isVisible("#veil"), "la fiche reste ouverte");
      assert.match(await page.textContent("#pTitle"), new RegExp("Test " + i));
      await page.click("#oCancel"); await page.click("#closeBtn");
      assert.ok((await objets(page)).includes("Test " + i), "le nouveau besoin est dans le tableau");
    }
  });
});

describe("lire un devis PDF", () => {
  const FIX = new URL("./fixtures/", import.meta.url).pathname;
  const readMsg = (page) => page.waitForFunction(() => /Lu dans|ne contient|Aucune ligne|pas pu/.test(document.getElementById("oReadMsg").textContent)).then(() => page.textContent("#oReadMsg"));

  test("nouvelle proposition : le PDF remplit les champs, puis il est enregistré", async () => {
    const page = await open();
    await page.click('[data-open="d2"] >> nth=0'); await page.click("#addOfferBtn");
    assert.ok(await page.isHidden("#oReadRow"), "pas de bouton tant qu'aucun PDF n'est choisi");
    await page.setInputFiles("#oFile", FIX + "devis-designation.pdf");
    await page.click("#oRead");
    assert.match(await readMsg(page), /^Lu dans le PDF : 3 lignes · 1\s234,50\s€ HT · réf\. D-2026-114 · STAGEPRO\./u);
    assert.equal(await page.inputValue("#oDetail"), "12 Praticable Samia 2x1 m hauteur 60 cm\n2 Escalier 3 marches\n3 Jupe de scène noire 6 m");
    assert.equal(await page.inputValue("#oMontant"), "1234,50");
    await page.click("#oSave"); await page.waitForTimeout(800);
    const o = [...s.db.offres.values()].find((x) => x.fournisseur === "STAGEPRO");
    assert.equal(o.montant, 1234.5); assert.equal(o.ref, "D-2026-114"); assert.ok(o.fichierId && s.files.has(o.fichierId));
  });

  test("nouvelle version d'un devis déjà en base : prix remplacé, texte d'avant récupérable", async () => {
    s.files.set("2026/abc123-devis.pdf", { type: "application/pdf", body: fs.readFileSync(FIX + "devis-colonnes.pdf") });
    s.seed({ offres: { o9: { devisId: "d2", fournisseur: "Sonolux", montant: 900, detail: "ancien détail", version: 1, retenue: false, fichierId: "2026/abc123-devis.pdf", fichierNom: "devis.pdf", cree: "2026-10-27T10:00:00Z" } } });
    const page = await open();
    await page.click('[data-open="d2"] >> nth=0');
    await page.click('[data-act="version"][data-o="o9"]');
    await page.click("#oRead");
    assert.match(await readMsg(page), /^Lu dans le PDF : 6 lignes · 877,40\s€ HT · réf\. DV-2026-0457\./u);
    assert.equal(await page.inputValue("#oMontant"), "877,40", "le prix de la V1 est remplacé");
    const lignes = (await page.inputValue("#oDetail")).split("\n");
    assert.deepEqual(lignes, ["1 Console Yamaha QL5", "4 Enceinte L-Acoustics X12", "4 Pied d'enceinte (noir, avec adaptateur)", "6 Micro HF Shure ULXD2 B58", "20 Câble XLR 10m", "1 Transport A/R"]);
    await page.click("#oUndoRead");
    assert.equal(await page.inputValue("#oDetail"), "ancien détail");
  });

  test("un scan est signalé, une image n'a pas de bouton", async () => {
    const page = await open();
    await page.click('[data-open="d2"] >> nth=0'); await page.click("#addOfferBtn");
    await page.setInputFiles("#oFile", FIX + "devis-scan.pdf"); await page.click("#oRead");
    assert.match(await readMsg(page), /scan ou photo/);
    assert.equal(await page.inputValue("#oDetail"), "");
    await page.setInputFiles("#oFile", { name: "photo.png", mimeType: "image/png", buffer: Buffer.from("x") });
    assert.ok(await page.isHidden("#oRead"));
    assert.match(await page.textContent("#oReadMsg"), /que sur les PDF/);
  });
});

describe("iPhone", () => {
  test("rien ne déborde, la fiche s'ouvre en plein écran", async () => {
    const page = await open(devices["iPhone 13"]);
    for (const tab of ["#tabEv", "#tabMem", "#tabCal"]) {
      await page.click(tab);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, tab);
    }
    await page.click("#tabEv");
    await page.click('[data-open="d1"] >> nth=0');
    const box = await page.locator("#veil .panel").boundingBox();
    assert.equal(Math.round(box.width), 390);
    const sizes = await page.$$eval("#veil input:not([type=file]), #veil textarea", (els) => els.map((e) => parseFloat(getComputedStyle(e).fontSize)));
    assert.ok(sizes.every((x) => x >= 16), "champs en 16 px : pas de zoom automatique sur iPhone");
  });
});
