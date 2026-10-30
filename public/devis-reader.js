/* Lecture d'un devis PDF dans le navigateur (aucun envoi, aucun serveur).
   1. extractLines : pdf.js lit le texte et sa position ; on reconstitue les lignes.
   2. parse : on repère la ligne d'en-tête (Qté, Tarif, Total…) pour savoir où sont les colonnes,
      puis on garde « quantité + désignation » pour chaque article, le total HT et le n° de devis.
   Ne marche que sur les PDF qui contiennent du texte (pas sur les scans ou les photos). */
(function (g) {
  const PDFJS = "/vendor/pdfjs/pdf.min.mjs", WORKER = "/vendor/pdfjs/pdf.worker.min.mjs";
  let lib = null;
  async function pdfjs() {
    if (!lib) { lib = await import(PDFJS); lib.GlobalWorkerOptions.workerSrc = WORKER; }
    return lib;
  }

  // ---- 1. text + positions -> lines of cells ----
  async function extractLines(data) {
    const { getDocument } = await pdfjs();
    const doc = await getDocument({ data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, standardFontDataUrl: "/vendor/pdfjs/standard_fonts/" }).promise;
    const pages = [];
    for (let p = 1; p <= Math.min(doc.numPages, 20); p++) {
      const tc = await (await doc.getPage(p)).getTextContent();
      pages.push(tc.items.filter((i) => i.str && i.str.trim()).map((i) => ({ s: i.str, x: i.transform[4], y: i.transform[5], w: i.width || 0 })));
    }
    doc.destroy();
    return groupLines(pages);
  }
  // Same baseline (±3 pt) = same line; pieces that touch are glued back together ("25" ",00" -> "25,00").
  function groupLines(pages) {
    const out = [];
    pages.forEach((items, page) => {
      items.sort((a, b) => b.y - a.y || a.x - b.x);
      const lines = [];
      for (const it of items) {
        const l = lines.find((l) => Math.abs(l.y - it.y) <= 3);
        l ? l.items.push(it) : lines.push({ y: it.y, items: [it] });
      }
      for (const l of lines) {
        l.items.sort((a, b) => a.x - b.x);
        const cells = [];
        for (const it of l.items) {
          const last = cells.at(-1);
          if (last && it.x - (last.x + last.w) < 1.5) { last.s += it.s; last.w = it.x + it.w - last.x; }
          else cells.push({ ...it });
        }
        for (const c of cells) c.s = c.s.replace(/\s+/g, " ").trim();
        out.push({ page, y: l.y, cells: cells.filter((c) => c.s) });
      }
    });
    return out;
  }

  // ---- 2. lines -> devis ----
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const RE_QTY = /^(qte|qt|quantite|qty|nb|nbre|nombre|quant\.?)\.?$/;
  const RE_DESIG = /^(designation|description|article|libelle|produit|materiel|prestation|desc\.?)s?$/;
  const RE_REF = /^(reference|ref\.?|code)$/;
  const RE_PRICEH = /^(p\.?u\.?|pu ht|prix|tarif|montant|total|remise|%|coef|tva|unite|duree|jours?|qte\.? jours?)\b/;
  const RE_STOP = /(total\s*g[ée]n[ée]ral|net\s*[àa]\s*payer|^total\s*h\.?\s*t|montant\s*total|conditions\s*(de|g)|^rib\b|\biban\b|bon\s*pour\s*accord|^tva\b)/i;
  const RE_NOTE = /(livr|reprise|retour|validation|contact|t[ée]l|mail|@|horaire|attention|merci|acompte|paiement|r[èe]glement|signature|devis\s*valable)/i;
  const AMOUNT = /-?\d{1,3}(?:[\s  .]\d{3})*(?:,\d{1,2})|-?\d+(?:[.,]\d{1,2})?/g;

  function parseAmount(s) {
    s = String(s).replace(/[€\s  ]/g, "");
    if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
    else if (/\.\d{1,2}$/.test(s)) s = s.replace(/,/g, "");
    else s = s.replace(/[.,]/g, "");
    const n = parseFloat(s);
    return isNaN(n) ? null : Math.round(n * 100) / 100;
  }
  const lineText = (l) => l.cells.map((c) => c.s).join("  ");
  const isNumberish = (s) => /^[-\d\s  .,€%x×*]+$/i.test(s) && /\d/.test(s);
  const fmtQty = (s) => { const n = parseAmount(s); return n == null ? s : String(n).replace(".", ","); };

  function findHeader(lines) {
    for (let i = 0; i < lines.length; i++) {
      const labels = lines[i].cells.map((c) => norm(c.s).replace(/[:]/g, "").trim());
      const q = labels.findIndex((t) => RE_QTY.test(t));
      if (q < 0) continue;
      const others = labels.filter((t, k) => k !== q && (RE_PRICEH.test(t) || RE_DESIG.test(t) || RE_REF.test(t))).length;
      if (others >= 1) return { index: i, cells: lines[i].cells, qty: q, desig: labels.findIndex((t) => RE_DESIG.test(t)) };
    }
    return null;
  }

  function parse(lines, { knownSuppliers = [] } = {}) {
    const all = lines.map(lineText);
    const text = all.join("\n");
    const res = { lignes: [], totalHT: null, ref: "", fournisseur: "", hasText: text.replace(/\s/g, "").length > 40 };
    if (!res.hasText) return res;

    // --- articles
    const h = findHeader(lines);
    if (h) {
      const xs = h.cells.map((c) => c.x);
      const qx = xs[h.qty];
      const qFrom = h.qty > 0 ? (xs[h.qty - 1] + qx) / 2 : qx - 18;
      const qTo = h.qty < xs.length - 1 ? (qx + xs[h.qty + 1]) / 2 : qx + 40;
      let dFrom = -1, dTo;
      if (h.desig >= 0) { dFrom = xs[h.desig] - 15; dTo = h.desig < xs.length - 1 ? xs[h.desig + 1] - 4 : 1e9; }
      else { const left = Math.min(...xs); dTo = left - 4; if (qFrom < dTo) dTo = qFrom; }
      let last = null, cont = 0;
      for (let i = h.index + 1; i < lines.length; i++) {
        const l = lines[i], t = lineText(l);
        if (/^\s*(page\s*\d|edit[ée] le)/i.test(t)) continue;
        if (RE_STOP.test(t.trim())) { if (/g[ée]n[ée]ral|net|conditions|rib|iban|accord|^tva/i.test(t)) break; last = null; continue; }
        if (/\btotal\b/i.test(t)) { last = null; continue; }
        const desig = l.cells.filter((c) => c.x >= dFrom && c.x < dTo && !(isNumberish(c.s) && c.x >= qFrom - 4)).map((c) => c.s).join(" ").trim();
        const qty = l.cells.filter((c) => c.x >= qFrom && c.x < qTo && isNumberish(c.s)).map((c) => c.s).join("").trim();
        const priced = l.cells.some((c) => c.x >= qTo && /\d/.test(c.s));
        if (desig && qty) {
          const d = desig.replace(/\s+/g, " ");
          res.lignes.push(/^\d+\s*[x×*]\s*\S/i.test(d) ? d : `${fmtQty(qty)} ${d}`);
          last = res.lignes.length - 1; cont = 0;
        } else if (desig && !qty && !priced && last != null && cont < 2 && desig.length <= 45 && !RE_NOTE.test(desig) && !/^[A-ZÀ-Ý0-9 &'\-/]{4,}$/.test(desig)) {
          res.lignes[last] += " " + desig; cont++; // suite de la désignation (« Noire », « (pas de réglage par vis) »)
        } else if (desig && !qty) { last = null; }
      }
    }
    if (!res.lignes.length) {
      // Pas d'en-tête reconnu : lignes « 2 Micro SM58 … 15,00 » ou « Micro SM58 … 2 … 15,00 ».
      for (const t of all) {
        if (RE_STOP.test(t) || /\btotal\b/i.test(t) || RE_NOTE.test(t)) continue;
        const m = /^\s*(\d{1,4}(?:[.,]\d+)?)\s*(?:x\s+)?([A-Za-zÀ-ÿ].{2,}?)\s{2,}.*\d[.,]\d{2}/.exec(t);
        if (m) res.lignes.push(`${fmtQty(m[1])} ${m[2].trim()}`);
      }
    }

    // --- total HT (le dernier « total … HT » du document, sinon le dernier « HT : »)
    let best = null;
    all.forEach((t, i) => {
      if (/t\.?t\.?c/i.test(t) && !/h\.?\s*t\b/i.test(t.replace(/t\.?t\.?c.*/i, ""))) return;
      const m = /(total[^:\n]{0,25}?)?\b(?:h\.?\s?t\.?|hors\s*taxes?)\b\s*[:=]?\s*([^\n]*)/i.exec(t);
      if (!m) return;
      let tail = m[2], nums = tail.match(AMOUNT);
      if (!nums && lines[i].cells.length === 1 && all[i + 1]) nums = all[i + 1].match(AMOUNT);
      if (!nums) return;
      const v = parseAmount(nums[0]);
      if (v == null || v === 0) return;
      const score = (m[1] ? 2 : 1) + (/total|montant|net/i.test(t) ? 1 : 0) - (/remise|acompte|tva/i.test(t) ? 3 : 0);
      if (!best || score >= best.score) best = { v, score };
    });
    if (best && best.score > 0) res.totalHT = best.v;

    // --- n° de devis
    for (const t of all) {
      const m = /(?:n[o°º]?\s*(?:de\s+)?devis|devis\s*(?:n[o°º]|num[ée]ro)|(?:notre\s+)?r[ée]f(?:[ée]rence)?(?:\s+devis)?|proforma\s*n[o°º]?)\s*[:#.]?\s*(?:devis\s*)?(?:n[o°º]\s*)?([A-Z0-9][\w\-/|.]*(?:\s?[/|-]\s?\w+)*)/i.exec(t);
      if (m && /\d/.test(m[1])) { res.ref = m[1].trim(); break; }
    }

    // --- fournisseur : un nom déjà connu présent dans le PDF, sinon le domaine de l'adresse e-mail
    const flat = norm(text).replace(/[^a-z0-9]/g, "");
    const known = knownSuppliers.filter((n) => { const k = norm(n).replace(/[^a-z0-9]/g, ""); return k.length >= 3 && flat.includes(k); })
      .sort((a, b) => b.length - a.length);
    if (known.length) res.fournisseur = known[0];
    else {
      const m = /[\w.+-]+@([\w-]+)\.[a-z.]{2,}/i.exec(text);
      if (m && !/^(gmail|hotmail|outlook|yahoo|orange|free|wanadoo|sfr|laposte|icloud|live|me)$/i.test(m[1])) res.fournisseur = m[1].replace(/[-_]+/g, " ").toUpperCase();
    }
    return res;
  }

  async function read(data, opts) { return parse(await extractLines(data), opts); }
  g.DevisReader = { read, parse, groupLines, parseAmount, extractLines };
})(typeof window !== "undefined" ? window : globalThis);
