/* Calendrier du mois en PDF (A4 paysage), fabriqué dans le navigateur avec jsPDF.
   Page 1 : la grille du mois, avec les locations (arrivée → reprise) et les livraisons d'achats.
   Pages suivantes : le détail, une ligne par location ou livraison. */
(function (g) {
  const LIB = "/vendor/jspdf/jspdf.umd.min.js";
  let loading = null;
  function lib() {
    if (g.jspdf) return Promise.resolve(g.jspdf);
    return (loading ||= new Promise((ok, ko) => {
      const s = document.createElement("script");
      s.src = LIB; s.onload = () => ok(g.jspdf); s.onerror = () => { loading = null; ko(new Error("jsPDF")); };
      document.head.appendChild(s);
    }));
  }

  // Couleurs des étiquettes d'événement (mêmes teintes que le tableau, version claire)
  const TAPE = { yellow: ["#fff2cc", "#3d3200"], orange: ["#fce4d6", "#5a2a0b"], red: ["#f8d4d4", "#7a1c1c"], pink: ["#fadbe8", "#6d1e45"],
    purple: ["#e4dfec", "#3f2f63"], blue: ["#ddebf7", "#1f3e66"], green: ["#e2efda", "#2f4a1f"], grey: ["#ededed", "#262626"],
    white: ["#ffffff", "#1f1f1f"], black: ["#404040", "#ffffff"] };
  const INK = "#1f1f1f", MUTED = "#6b6b6b", LINE = "#c8c8c8", GRID = "#e1e1e1", HEAD = "#f1f1f1", OUT = "#f6f6f6", WE = "#fafafa";
  const DAYS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
  const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
  const ABBR = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

  // Les polices standard du PDF ne connaissent pas tous les caractères : on remplace les autres.
  const clean = (s) => String(s ?? "").replace(/[→⇒]/g, "->").replace(/[   ]/g, " ").replace(/[^\x20-\x7e -ÿŒœŠšŸŽž–—‘’‚“”„†‡•…‰€]/g, "");
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const h = (t) => { const m = /^(\d{2}):(\d{2})/.exec(t || ""); return m ? `${+m[1]}h${m[2] === "00" ? "" : m[2]}` : ""; };
  const dShort = (d) => `${d.getDate()} ${ABBR[d.getMonth()]}`;

  /* items: [{a: Date, b: Date, liv: bool, objet, evenement, fournisseur, num, hDebut, hFin, color}] */
  async function build({ month, items, filterLabel, partsLabel }) {
    const { jsPDF } = await lib();
    const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
    const W = 297, H = 210, M = 10;
    const y0 = month.getFullYear(), m0 = month.getMonth();
    const first = new Date(y0, m0, 1), last = new Date(y0, m0 + 1, 0);
    const title = `Calendrier · ${MONTHS[m0]} ${y0}`;
    const inMonth = items.filter((l) => l.b >= first && l.a <= last);
    const footer = () => {
      const n = doc.getNumberOfPages();
      for (let p = 1; p <= n; p++) {
        doc.setPage(p); doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(MUTED);
        doc.text(clean(`Suivi des devis · ${partsLabel} · édité le ${new Date().toLocaleDateString("fr-FR")}`), M, H - 5);
        doc.text(`Page ${p}/${n}`, W - M, H - 5, { align: "right" });
      }
    };
    const header = (sub) => {
      doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.setTextColor(INK); doc.text(clean(title), M, M + 6);
      doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(MUTED); doc.text(clean(sub), M, M + 11.5);
    };
    const nLoc = inMonth.filter((l) => !l.liv).length, nLiv = inMonth.length - nLoc;
    const counts = [nLoc ? `${nLoc} location${nLoc > 1 ? "s" : ""}` : "", nLiv ? `${nLiv} livraison${nLiv > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ") || "Aucune location ni livraison";
    header(`${filterLabel} · ${counts}`);

    // ---- grille
    const gx = M, gw = W - 2 * M, cw = gw / 7, top = M + 16, headH = 6, laneH = 5.6, minWeek = 20, bottom = H - 10;
    const start = new Date(y0, m0, 1 - ((first.getDay() + 6) % 7));
    const weeks = [];
    for (let w = new Date(start); w <= last; w = new Date(w.getFullYear(), w.getMonth(), w.getDate() + 7)) {
      const wEnd = new Date(w.getFullYear(), w.getMonth(), w.getDate() + 6);
      const lanes = [], bars = [];
      for (const l of items.filter((l) => l.b >= w && l.a <= wEnd)) {
        const s = l.a < w ? w : l.a, e = l.b > wEnd ? wEnd : l.b;
        const c0 = Math.round((s - w) / 864e5), c1 = Math.round((e - w) / 864e5);
        let lane = lanes.findIndex((end) => end < c0); if (lane < 0) { lane = lanes.length; lanes.push(c1); } else lanes[lane] = c1;
        bars.push({ l, c0, c1, lane, first: l.a >= w, last: l.b <= wEnd });
      }
      weeks.push({ w, bars, h: Math.max(minWeek, 6.5 + lanes.length * laneH + 1.5) });
    }
    // la grille occupe toute la page quand elle tient ; sinon les semaines continuent sur la suivante
    const free = bottom - top - headH, need = weeks.reduce((t, w) => t + w.h, 0);
    if (need < free) { const extra = (free - need) / weeks.length; for (const w of weeks) w.h += extra; }
    let y = top;
    const dayHeader = () => {
      doc.setFillColor(HEAD); doc.setDrawColor(LINE); doc.setLineWidth(0.2); doc.rect(gx, y, gw, headH, "FD");
      doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(MUTED);
      DAYS.forEach((d, i) => doc.text(d, gx + i * cw + 2, y + 4.1));
      y += headH;
    };
    dayHeader();
    for (const wk of weeks) {
      if (y + wk.h > bottom) { doc.addPage(); header(`${filterLabel} · suite`); y = top; dayHeader(); }
      for (let i = 0; i < 7; i++) {
        const d = new Date(wk.w.getFullYear(), wk.w.getMonth(), wk.w.getDate() + i);
        const out = d.getMonth() !== m0;
        doc.setFillColor(out ? OUT : i > 4 ? WE : "#ffffff"); doc.setDrawColor(GRID);
        doc.rect(gx + i * cw, y, cw, wk.h, "FD");
        doc.setFont("helvetica", out ? "normal" : "bold"); doc.setFontSize(8); doc.setTextColor(out ? "#aaaaaa" : INK);
        doc.text(String(d.getDate()) + (d.getDate() === 1 ? " " + ABBR[d.getMonth()] : ""), gx + i * cw + 1.8, y + 4);
      }
      for (const b of wk.bars) {
        const x = gx + b.c0 * cw + 0.8, w = (b.c1 - b.c0 + 1) * cw - 1.6, by = y + 6 + b.lane * laneH;
        const [bg, fg] = TAPE[b.l.color] || TAPE.grey;
        doc.setFillColor(bg); doc.setDrawColor("#9a9a9a"); doc.setLineWidth(0.15);
        doc.roundedRect(x, by, w, laneH - 1, 0.8, 0.8, "FD");
        let tx = x + 1.2, right = x + w - 1.2;
        const badge = (txt, atRight) => {
          doc.setFont("helvetica", "bold"); doc.setFontSize(6.3);
          const tw = doc.getTextWidth(txt) + 2;
          const bx = atRight ? right - tw : tx;
          doc.setFillColor("#262626"); doc.roundedRect(bx, by + 0.7, tw, laneH - 2.4, 0.6, 0.6, "F");
          doc.setTextColor("#ffffff"); doc.text(txt, bx + 1, by + 3.3);
          if (atRight) right = bx - 1; else tx = bx + tw + 1;
        };
        if (b.l.liv) badge(clean(`Livraison${b.l.hDebut ? " " + h(b.l.hDebut) : ""}`));
        else {
          if (b.first && b.l.hDebut) badge(`Arr. ${h(b.l.hDebut)}`);
          if (b.last && b.l.hFin) badge(`Rep. ${h(b.l.hFin)}`, true);
        }
        doc.setFont("helvetica", "normal"); doc.setFontSize(6.8); doc.setTextColor(fg);
        let txt = clean(b.l.objet + (b.l.fournisseur ? " · " + b.l.fournisseur : ""));
        const room = right - tx;
        if (room > 3) {
          while (txt.length > 1 && doc.getTextWidth(txt) > room) txt = txt.slice(0, -2) + "…";
          doc.text(txt, tx, by + 3.3);
        }
      }
      y += wk.h;
    }

    // ---- détail du mois
    if (inMonth.length) {
      doc.addPage(); header(`Détail · ${counts}`);
      const cols = [["Date(s)", 38], ["Heures", 32], ["Type", 20], ["N°", 12], ["Besoin", 62], ["Événement / catégorie", 62], ["Fournisseur", 51]];
      let ty = top;
      const rowH = 6.2;
      const head = () => {
        doc.setFillColor(HEAD); doc.setDrawColor(LINE); doc.rect(M, ty, gw, rowH, "FD");
        doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(MUTED);
        let x = M; for (const [t, w] of cols) { doc.text(clean(t), x + 1.5, ty + 4.2); x += w; }
        ty += rowH;
      };
      head();
      const fit = (t, w) => { t = clean(t); while (t.length > 1 && doc.getTextWidth(t) > w - 3) t = t.slice(0, -2) + "…"; return t; };
      for (const l of [...inMonth].sort((p, q) => p.a - q.a || p.b - q.b || p.num - q.num)) {
        if (ty + rowH > bottom) { doc.addPage(); header("Détail · suite"); ty = top; head(); }
        const dates = l.liv || +l.a === +l.b ? dShort(l.a) : `${dShort(l.a)} -> ${dShort(l.b)}`;
        const hours = l.liv ? (l.hDebut ? "livr. " + h(l.hDebut) : "") : [l.hDebut ? "arr. " + h(l.hDebut) : "", l.hFin ? "rep. " + h(l.hFin) : ""].filter(Boolean).join(" · ");
        const cells = [dates, hours, l.liv ? "Livraison" : "Location", "#" + String(l.num).padStart(3, "0"), l.objet, l.evenement, l.fournisseur || ""];
        doc.setDrawColor(GRID); doc.line(M, ty + rowH, M + gw, ty + rowH);
        doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(INK);
        let x = M; cells.forEach((c, i) => { doc.text(fit(c, cols[i][1]), x + 1.5, ty + 4.2); x += cols[i][1]; });
        ty += rowH;
      }
    }
    footer();
    return doc;
  }
  g.CalendarPdf = { build, clean, iso };
})(window);
