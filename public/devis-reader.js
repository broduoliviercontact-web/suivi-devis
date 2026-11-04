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
  const RE_PU = /^(p\.?\s?u\.?|prix(\s+unit(aire|\.)?)?|tarif|pu ht|p\.u\. ht|prix ht|prix u\.?)( ht| h\.t\.?| €| eur)?$/;
  const RE_REM = /^(%|remise|rem\.?|rabais|% rem\.?|remise %)$/;
  const RE_TOT = /^(total|montant|total ht|montant ht|total h\.t\.?|montant h\.t\.?)( €)?$/;
  const RE_PRICEH = /^(p\.?u\.?|pu ht|prix|tarif|montant|total|remise|%|coef|tva|unite|duree|jours?|qte\.? jours?)\b/;
  const RE_STOP = /(total\s*g[ée]n[ée]ral|net\s*[àa]\s*payer|^total\s*h\.?\s*t|montant\s*total|conditions\s*(de|g)|^rib\b|\biban\b|bon\s*pour\s*accord|^tva\b)/i;
  const RE_NOTE = /(livr|reprise|retour|validation|contact|t[ée]l|mail|@|horaire|attention|merci|acompte|paiement|r[èe]glement|signature|devis\s*valable)/i;
  const AMOUNT = /-?\d{1,3}(?:[\s  .]\d{3})*(?:,\d{1,2})|-?\d+(?:[.,]\d{1,2})?/g;

  function parseAmount(s) {
    s = String(s).replace(/[%€\s  ]/g, "");
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
      if (others >= 1) {
        const col = (re) => { let k = -1; labels.forEach((t, j) => { if (j !== q && re.test(t)) k = j; }); return k; };
        return { index: i, cells: lines[i].cells, qty: q, desig: labels.findIndex((t) => RE_DESIG.test(t)),
          pu: labels.findIndex((t, j) => j !== q && RE_PU.test(t)), rem: col(RE_REM), total: col(RE_TOT) };
      }
    }
    return null;
  }

  function parse(lines, { knownSuppliers = [] } = {}) {
    const all = lines.map(lineText);
    const text = all.join("\n");
    const res = { lignes: [], articles: [], totalHT: null, ttc: null, transport: null, remise: null, paiement: "", validite: null, dates: null,
      ref: "", refKey: "", fournisseur: "", hasText: text.replace(/\s/g, "").length > 40 };
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
      // price cells of an article line: the number closest to each header column
      const near = (l, k) => { if (k < 0) return null; const hx = xs[k]; let best = null;
        for (const c of l.cells) { if (c.x < qTo - 2 || !/\d/.test(c.s) || !isNumberish(c.s)) continue; const dist = Math.abs(c.x + c.w / 2 - (hx + (h.cells[k].w || 0) / 2));
          if (dist < 45 && (!best || dist < best.dist)) best = { dist, s: c.s }; } return best && best.s; };
      const amounts = (l) => l.cells.filter((c) => c.x >= qTo - 2 && /\d/.test(c.s) && isNumberish(c.s) && !/%/.test(c.s)).map((c) => parseAmount(c.s));
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
          const am = amounts(l), puS = near(l, h.pu), remS = near(l, h.rem), totS = near(l, h.total);
          const pu = puS != null ? parseAmount(puS) : am.length >= 2 ? am[0] : null;
          const total = totS != null && !/%/.test(totS) ? parseAmount(totS) : am.length ? am[am.length - 1] : null;
          const rem = remS != null && /%/.test(remS) ? parseAmount(remS) : null;
          res.articles.push({ q: parseAmount(qty), d, pu, remise: rem || null, total });
          last = res.lignes.length - 1; cont = 0;
        } else if (desig && !qty && !priced && last != null && cont < 2 && desig.length <= 45 && !RE_NOTE.test(desig) && !/^[A-ZÀ-Ý0-9 &'\-/]{4,}$/.test(desig)) {
          res.lignes[last] += " " + desig; if (res.articles[last]) res.articles[last].d += " " + desig; cont++; // suite de la désignation (« Noire », « (pas de réglage par vis) »)
        } else if (desig && !qty) { last = null; }
      }
    }
    if (!res.lignes.length) {
      // Pas d'en-tête reconnu : lignes « 2 Micro SM58 … 15,00 » ou « Micro SM58 … 2 … 15,00 ».
      for (const t of all) {
        if (RE_STOP.test(t) || /\btotal\b/i.test(t) || RE_NOTE.test(t)) continue;
        const m = /^\s*(\d{1,4}(?:[.,]\d+)?)\s*(?:x\s+)?([A-Za-zÀ-ÿ].{2,}?)\s{2,}.*\d[.,]\d{2}/.exec(t);
        if (m) { res.lignes.push(`${fmtQty(m[1])} ${m[2].trim()}`); const am = t.match(AMOUNT) || []; const n = am.map(parseAmount).filter((x) => x != null);
          res.articles.push({ q: parseAmount(m[1]), d: m[2].trim(), pu: n.length >= 3 ? n[n.length - 2] : null, remise: null, total: n.length >= 2 ? n[n.length - 1] : null }); }
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
    res.refKey = refKey(res.ref);
    Object.assign(res, extras(all, res));

    // --- fournisseur : un nom déjà connu présent dans le PDF, sinon le domaine de l'adresse e-mail
    const flat = norm(text).replace(/[^a-z0-9]/g, "");
    const known = knownSuppliers.filter((n) => { const k = norm(n).replace(/[^a-z0-9]/g, ""); return k.length >= 3 && flat.includes(k); })
      .sort((a, b) => b.length - a.length);
    if (known.length) res.fournisseur = known[0];
    else {
      const m = /[\w.+-]+@([\w-]+)\.[a-z.]{2,}/i.exec(text);
      if (m && !/^(gmail|hotmail|outlook|yahoo|orange|free|wanadoo|sfr|laposte|icloud|live|me)$/i.test(m[1])) {
        res.fournisseur = m[1].replace(/[-_]+/g, " ").toUpperCase();
        // the name as written in the document (« easybackline » -> « EASY BACKLINE »)
        const want = norm(m[1]).replace(/[^a-z0-9]/g, "");
        for (const t of all) {
          const words = t.split(/\s+/);
          for (let i = 0; i < words.length && res.fournisseur === m[1].replace(/[-_]+/g, " ").toUpperCase(); i++) {
            let acc = "";
            for (let j = i; j < Math.min(words.length, i + 5); j++) {
              acc += norm(words[j]).replace(/[^a-z0-9]/g, "");
              if (acc === want && !/@/.test(words.slice(i, j + 1).join(" "))) { res.fournisseur = words.slice(i, j + 1).join(" ").replace(/[,;:]+$/, ""); break; }
              if (!want.startsWith(acc)) break;
            }
          }
        }
      }
    }
    return res;
  }

  // Same devis, another version: "202603|35798 / 4" and "202603|35798 / 5" share the key "20260335798".
  function refKey(ref) {
    return norm(ref).replace(/(?:\s*[/|]\s*\d{1,2}|\s+-\s+\d{1,2}|[-_ ]?v(?:ersion)?\s*\d{1,2}|\s*(?:rev|ind(?:ice)?)\.?\s*[a-z0-9])$/i, "").replace(/[^a-z0-9]/g, "");
  }

  // ---- dates written in the devis ----
  const MOIS = ["janv", "fevr", "mars", "avr", "mai", "juin", "juil", "aout", "sept", "oct", "nov", "dec"];
  const RE_DATE = /\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?\b|\b(?:lun|mar|mer|jeu|ven|sam|dim)[a-z]*\.?\s+(\d{1,2})(?:er)?\s+([a-zéû]{3,}\.?)(?:\s+(\d{4}))?|\b(\d{1,2})(?:er)?\s+([a-zéû]{3,}\.?)(?:\s+(\d{4}))?/gi;
  const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  function dateAt(m, ref) {
    let d, mo, y;
    if (m[1]) { d = +m[1]; mo = +m[2]; y = m[3] ? +m[3] : null; }
    else { d = +(m[4] || m[7]); const w = norm(m[5] || m[8]).replace(/\./, ""); mo = MOIS.findIndex((x) => w.startsWith(x)) + 1; if (!mo) return null; y = m[6] || m[9] ? +(m[6] || m[9]) : null; }
    if (!(d >= 1 && d <= 31 && mo >= 1 && mo <= 12)) return null;
    if (y != null && y < 100) y += 2000;
    if (y == null) { // no year: the first one on or after the date of the devis (or of today)
      const r = ref || new Date(); y = r.getFullYear(); if (new Date(y, mo - 1, d) < new Date(r.getFullYear(), r.getMonth(), r.getDate() - 31)) y++;
    }
    if (y < 2000 || y > 2100) return null;
    return iso(y, mo, d);
  }
  const datesIn = (t, ref) => { const out = []; RE_DATE.lastIndex = 0; let m; while ((m = RE_DATE.exec(t))) { const v = dateAt(m, ref); if (v) out.push({ v, i: m.index, end: RE_DATE.lastIndex }); } return out; };
  const hourAt = (t) => { const m = /\b(?:[àa]|vers|d[eè]s|avant|pour|entre)?\s*([01]?\d|2[0-3])\s*h\s*([0-5]\d)?(?![a-z])/i.exec(t); return m ? `${m[1].padStart(2, "0")}:${m[2] || "00"}` : null; };

  function extras(all, res) {
    const out = {};
    const amountAfter = (t, re) => { const m = re.exec(t); if (!m) return null; const nums = t.slice(m.index + m[0].length).match(AMOUNT); return nums ? parseAmount(nums[0]) : null; };
    // date of the devis (for years left out and for « valable 30 jours »)
    let docDate = null;
    for (const t of all) {
      const m = /(?:edit[ée]\s+le|date\s+du\s+devis|devis\s+du|[ée]tabli\s+le|^\s*le|date\s*d'[ée]mission)\s*:?\s*(.{4,30})/i.exec(t) || (/^\s*date\s*:(?!\s*du\b)\s*(.{4,30})/i.exec(t));
      if (m) { const d = datesIn(m[1], new Date(2000, 0, 1))[0]; if (d && /\d{4}|\d{1,2}[/.]\d{1,2}[/.]\d{2}/.test(m[1])) { docDate = new Date(d.v); break; } }
    }
    // TTC
    for (const t of all) { if (/\bt\.?\s?t\.?\s?c\b|net\s+[àa]\s+payer/i.test(t)) { const v = amountAfter(t, /\bt\.?\s?t\.?\s?c\.?\b|net\s+[àa]\s+payer/i); if (v) out.ttc = v; } }
    // transport / delivery: a « Total transport » line, otherwise the article lines about it
    const RE_TR = /\b(transport|livraison|enl[eè]vement|frais\s+de\s+port|d[ée]placement|logistique|aller[\s-]retour|a\/r)\b/i;
    for (const t of all) { const m = /total\s+(transport|livraison|logistique|frais\s+de\s+port)[^\d\n]*?(-?\d[\d\s  .]*,\d{2}|-?\d+(?:\.\d{2})?)/i.exec(t); if (m) out.transport = (out.transport || 0) + parseAmount(m[2]); }
    if (out.transport == null) { const tr = res.articles.filter((a) => RE_TR.test(a.d) && a.total); if (tr.length) out.transport = Math.round(tr.reduce((s, a) => s + a.total, 0) * 100) / 100; }
    // discount (text): a « Remise » amount line; otherwise what the % column takes off when the lines add up
    // to the total HT (some devis also price the parts of a pack), else just the rates.
    const fmtE = (v) => v.toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " €";
    for (const t of all) { if (/^\s*(remise|rabais|escompte)\b/i.test(t) && !/%\s*$/.test(t)) { const nums = (t.match(AMOUNT) || []).map(parseAmount).filter((v) => v); const rate = /(\d{1,2}(?:[.,]\d+)?)\s*%/.exec(t);
      if (nums.length && !(nums.length === 1 && rate)) out.remise = fmtE(Math.abs(nums.at(-1))) + (rate ? ` (${rate[1].replace(".", ",")} %)` : ""); } }
    if (out.remise == null) {
      const withRate = res.articles.filter((a) => a.remise > 0 && a.remise < 100);
      if (withRate.length) {
        const sum = res.articles.reduce((t, a) => t + (a.total || 0), 0);
        const r = withRate.reduce((t, a) => t + (a.total ? a.total / (1 - a.remise / 100) - a.total : 0), 0);
        const rates = [...new Set(withRate.map((a) => a.remise))].sort((x, y) => x - y);
        const rateTxt = rates.length === 1 ? `${String(rates[0]).replace(".", ",")} %` : `${String(rates[0]).replace(".", ",")} à ${String(rates.at(-1)).replace(".", ",")} %`;
        out.remise = res.totalHT && Math.abs(sum - res.totalHT) <= Math.max(1, res.totalHT * 0.005) && r >= 0.5 ? `${fmtE(r)} (${rateTxt})` : `${rateTxt} selon les lignes`;
      }
    }
    // payment: deposit and terms
    const pay = [];
    for (const t of all) {
      const a = /acompte[^\n]{0,40}?(\d{1,3}(?:[.,]\d+)?)\s*%([^\n]{0,40})/i.exec(t);
      if (a && !pay.some((p) => /acompte/i.test(p))) pay.push(`Acompte ${a[1].replace(".", ",")} %${/commande|signature|r[ée]servation/i.test(a[2]) ? " " + a[2].match(/(à la |a la )?(commande|signature|r[ée]servation)/i)[0].replace(/^a la/i, "à la") : ""}`.trim());
      else if (/acompte/i.test(t) && !pay.some((p) => /acompte/i.test(p))) { const v = amountAfter(t, /acompte[^:\d]*:?/i); if (v) pay.push(`Acompte ${String(v).replace(".", ",")} €`); }
      const c = /conditions?\s+de\s+(?:paiement|r[èe]glement)\s*:?\s*([^\n]{2,60})/i.exec(t) || /(?:mode|modalit[ée]s?)\s+de\s+(?:paiement|r[èe]glement)\s*:?\s*([^\n]{2,60})/i.exec(t) || /\b(paiement\s+(?:[àa]\s+\d+\s+jours[^\n]{0,20}|comptant|[àa]\s+r[ée]ception[^\n]{0,20}))/i.exec(t);
      if (c && !pay.some((p) => !/acompte/i.test(p))) pay.push(c[1].replace(/\s{2,}.*$/, "").replace(/[.;,\s]+$/, "").trim());
    }
    out.paiement = pay.join(" · ");
    // validity
    for (const t of all) {
      const j = /(?:valable|validit[ée]|valide)[^\n\d]{0,25}(\d{1,3})\s*jours/i.exec(t);
      if (j) { const b = docDate || new Date(); const d = new Date(b.getFullYear(), b.getMonth(), b.getDate() + +j[1]); out.validite = iso(d.getFullYear(), d.getMonth() + 1, d.getDate()); break; }
      const u = /(?:valable|valide|validit[ée])[^\n]{0,20}?jusqu.{0,4}au\s*:?\s*(.{4,30})/i.exec(t);
      if (u) { const d = datesIn(u[1], docDate)[0]; if (d) { out.validite = d.v; break; } }
    }
    // rental dates: delivery / pick-up written in words win over the period « du … au … »
    const KW = [["debut", /\b(livraison|livr[ée]e?s?|arriv[ée]e|montage|installation|mise\s+en\s+place|d[ée]but\s+de\s+location)\b/gi], ["fin", /\b(reprise|retour|enl[eè]vement|d[ée]montage|restitution|fin\s+de\s+location)\b/gi]];
    const found = {};
    for (const t of all) {
      const ds = datesIn(t, docDate); if (!ds.length) continue;
      const hits = [];
      for (const [k, re] of KW) { re.lastIndex = 0; let m; while ((m = re.exec(t))) hits.push({ k, i: m.index, end: re.lastIndex }); }
      hits.sort((a, b) => a.i - b.i);
      hits.forEach((h, n) => {
        if (found[h.k]) return;
        const stop = n + 1 < hits.length ? hits[n + 1].i : t.length;
        const d = ds.find((x) => x.i >= h.end && x.i < stop && x.i - h.end < 40); if (!d) return;
        found[h.k] = { v: d.v, h: hourAt(t.slice(d.end, Math.min(stop, d.end + 25))) };
      });
    }
    let per = null;
    for (const t of all) { const m = /\b(?:du|p[ée]riode\s*:?)\s+(.{3,28}?)\s+au\s+(.{3,30})/i.exec(t); if (m) { const a = datesIn(m[1], docDate)[0], b = datesIn(m[2], docDate)[0]; if (a && b && a.v <= b.v) { per = { a: a.v, b: b.v }; break; } } }
    const debut = found.debut ? found.debut.v : per && per.a, fin = found.fin ? found.fin.v : per && per.b;
    if (debut || fin) out.dates = { debut: debut || null, fin: fin && (!debut || fin >= debut) ? fin : null, hDebut: found.debut && found.debut.h || null, hFin: found.fin && found.fin.h || null, docDate: docDate ? iso(docDate.getFullYear(), docDate.getMonth() + 1, docDate.getDate()) : null };
    return out;
  }

  async function read(data, opts) { return parse(await extractLines(data), opts); }
  g.DevisReader = { read, parse, groupLines, parseAmount, extractLines, refKey };
})(typeof window !== "undefined" ? window : globalThis);
