const STEPS=[["aEnvoyer","À envoyer"],["envoye","Envoyé"],["signe","Signé"],["paye","Payé"]];
const FACT=[["factSB","SB"],["factRecue","Reçue"],["factEnvoyee","Envoyée"]];
const FILTERS=[["tous","Tous"],["relancer","À relancer"],["payer","À payer"],["factures","Factures en attente"]];
const CHECK='<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const PEN='<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.8 2.7l2.5 2.5-7.9 7.9-3.1.6.6-3.1z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
const CLIP='<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 4.5L5.2 9.8a1.6 1.6 0 002.3 2.3l5.6-5.6a3 3 0 00-4.3-4.3L3.2 7.8a4.4 4.4 0 006.2 6.2l4.1-4.1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
const UPLOAD_ERR={too_large:"Le fichier dépasse 20 Mo. Envoie une version plus légère.",unsupported_type:"Ce type de fichier n'est pas accepté. Exporte le devis en PDF ou en image.",quota_or_state:"L'espace de stockage est plein. Retire d'anciens fichiers.",rate_limited:"Trop d'envois d'un coup. Réessaie dans quelques secondes.",upstream_auth:"Session expirée. Recharge la page et reconnecte-toi."};

let db=null, assets=null, canWrite=true, rows=[], offres=[], filter="tous", view="events";
const openRows=new Set();
let fiche=null;      // null | {id} | {id:null} for a new besoin
let oMode=null;      // null | {kind:"add"|"version"|"edit", offre?}
let gotDevis=false;
let events=[], trash={devis:[],offres:[],evenements:[]}, evTable=true, EV=new Map(), lastSig="", rawData=null;
try{filter=localStorage.getItem("devis-filter")||"tous";view=localStorage.getItem("devis-view")||"events"}catch(e){}

const $=id=>document.getElementById(id);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const pad=n=>"#"+String(n).padStart(3,"0");
const keyOf=s=>String(s||"").normalize("NFD").replace(/[̀-ͯ]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim().replace(/s\b/g,"");
const ext=n=>{const m=/\.([a-z0-9]{2,4})$/i.exec(n||"");return m?m[1].toUpperCase():"Fichier"};
const eur=n=>(n==null||isNaN(n))?"":new Intl.NumberFormat("fr-FR",{style:"currency",currency:"EUR",maximumFractionDigits:2}).format(n)+" HT";
const day=iso=>{if(!iso)return"";const d=new Date(iso);return isNaN(d)?"":d.toLocaleDateString("fr-FR",{day:"2-digit",month:"2-digit",year:"2-digit"})};
const fileLink=(id,name,label)=>id?`<a href="/api/file?p=${esc(id)}" target="_blank" rel="noopener">${esc(label||name||"Devis")}</a>`:"";

/* ---------- server connection ---------- */
async function call(url,opts={}){
  let r;
  try{r=await fetch(url,{credentials:"same-origin",...opts,headers:{"Content-Type":"application/json",...(opts.headers||{})}})}
  catch(_){throw {code:"offline",message:"Pas de connexion internet."}}
  let j={};try{j=await r.json()}catch(_){}
  if(r.status===401&&!url.startsWith("/api/login")){lock();throw {code:"login",message:"Mot de passe requis."}}
  if(!r.ok)throw {code:r.status===413?"too_large":"server",message:j.error||"Erreur du serveur."};
  return j;
}
// Same shape as before: api(table, id, "set"|"update"|"delete", data)
const api=(table,id,op,data)=>call("/api/doc",{method:"POST",body:JSON.stringify({table,id,op,data})});
const UP_TYPES={pdf:"application/pdf",png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",webp:"image/webp"};
assets={
  async upload(file){
    const t=UP_TYPES[(/\.([a-z0-9]+)$/i.exec(file.name)||[])[1]?.toLowerCase()]||file.type;
    if(!Object.values(UP_TYPES).includes(t))throw {code:"unsupported_type"};
    if(file.size>20*1024*1024)throw {code:"too_large"};
    const {path,uploadUrl}=await call("/api/upload-url",{method:"POST",body:JSON.stringify({name:file.name,type:t})});
    let r;try{r=await fetch(uploadUrl,{method:"PUT",headers:{"Content-Type":t,"x-upsert":"false"},body:file})}catch(_){throw {code:"offline"}}
    if(!r.ok)throw {code:r.status===413?"too_large":"upload"};
    return {id:path};
  },
  delete(path){return call("/api/file",{method:"POST",body:JSON.stringify({path,op:"delete"})})}
};

// Entry gate: the password is checked by the server, which then remembers this browser.
function unlock(){$("gate").hidden=true;$("app").hidden=false}
function lock(){$("gate").hidden=false;$("app").hidden=true;closeFiche&&!$("veil").hidden&&closeFiche()}
$("gateForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const b=e.submitter||$("gateForm").querySelector("button");b.disabled=true;
  try{await call("/api/login",{method:"POST",body:JSON.stringify({password:$("gatePw").value})});$("gatePw").value="";$("gateErr").hidden=true;unlock();start()}
  catch(err){$("gateErr").textContent=err.code==="offline"?"Pas de connexion internet.":"Mot de passe incorrect.";$("gateErr").hidden=false;$("gatePw").select()}
  finally{b.disabled=false}
});

// Reads the first date in an event name ("Ouverture 6-8/11", "Inauguration 5/12", "Gala 14/03/27") to sort events chronologically.
function evDate(name){
  const m=/(\d{1,2})(?:\s*[-,&àa]\s*\d{1,2})*\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?/.exec(name||"");
  if(!m) return Infinity;
  const d=+m[1], mon=+m[2]-1, now=new Date();
  let y=m[3]?(+m[3]<100?2000+ +m[3]:+m[3]):now.getFullYear();
  let t=new Date(y,mon,d).getTime();
  if(!m[3]&&t<now.getTime()-183*864e5) t=new Date(y+1,mon,d).getTime();
  return t;
}

/* ---------- offers helpers ---------- */
const devisById=id=>rows.find(r=>r._id===id);
const offersOf=id=>offres.filter(o=>o.devisId===id);
// One entry per supplier on a besoin: latest version first, older versions kept in .olds
function supplierGroups(id){
  const m=new Map();
  for(const o of offersOf(id)){const k=keyOf(o.fournisseur);if(!m.has(k))m.set(k,[]);m.get(k).push(o)}
  return [...m.values()].map(g=>{g.sort((a,b)=>(b.version||1)-(a.version||1));return {latest:g[0],olds:g.slice(1),retenue:g.some(o=>o.retenue)}});
}
function retained(id){return offersOf(id).find(o=>o.retenue)}

function status(d){
  if(d.paye) return ["s-pay","Payé"];
  if(d.signe) return ["s-sig","Signé, à payer"];
  if(d.envoye) return ["s-env","Envoyé, pas signé"];
  if(d.aEnvoyer) return ["s-aenv","À envoyer"];
  return ["s-prep","À préparer"];
}
const match={
  tous:()=>true,
  relancer:d=>d.envoye&&!d.signe,
  payer:d=>d.signe&&!d.paye,
  factures:d=>(d.signe||d.paye)&&!d.factRecue
};

/* ---------- events view ---------- */
function renderFilters(){
  $("filters").innerHTML=FILTERS.map(([k,l])=>`<button type="button" data-f="${k}" aria-pressed="${filter===k}">${l}<span class="n">${rows.filter(match[k]).length}</span></button>`).join("");
}
function ck(d,key,label,fact){
  return `<button type="button" class="ck${fact?" fact":""}" data-id="${esc(d._id)}" data-k="${key}" aria-pressed="${!!d[key]}" aria-label="${esc(label)} ${pad(d.num)}" ${canWrite?"":"disabled"}>${CHECK}<span class="lbl">${fact?'<span class="lf">Facture </span>':""}${label}</span></button>`;
}
// Text with clickable web links (escaped first)
const URL_RE=/https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;
const linkify=t=>esc(t).replace(URL_RE,u=>`<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
// Same, but long addresses shown as « site.fr › page… » so they never stretch a card
const linkifyShort=t=>esc(t).replace(URL_RE,u=>{let h=u,pth='';try{const x=new URL(u.replace(/&amp;/g,'&'));h=x.hostname.replace(/^www\./,'');pth=decodeURIComponent(x.pathname).replace(/^\/|\/$/g,'').split('/').pop().replace(/\.[a-z]+$/i,'').replace(/[-_]+/g,' ').trim()}catch(_){}return `<a href="${u}" target="_blank" rel="noopener noreferrer" title="${u}">${esc(h)}${pth?' › '+esc(pth.length>38?pth.slice(0,38)+'…':pth):''} ↗</a>`});
const firstUrl=t=>{const m=String(t||"").match(URL_RE);return m?m[0]:null};
const hostOf=u=>{try{return new URL(u).hostname.replace(/^www\./,"")}catch(_){return "site"}};
function subRows(d){
  const groups=supplierGroups(d._id).sort((a,b)=>(a.latest.montant??Infinity)-(b.latest.montant??Infinity));
  const prices=groups.map(g=>g.latest.montant).filter(n=>n!=null), min=prices.length?Math.min(...prices):null;
  const pct=n=>new Intl.NumberFormat("fr-FR",{maximumFractionDigits:0}).format(n);
  return `<div class="subrows" id="sub-${esc(d._id)}">`+groups.map(g=>{
    const o=g.latest, url=firstUrl(o.detail), rest=String(o.detail||"").replace(URL_RE,"").replace(/\s+/g," ").trim();
    let gap="";
    if(o.montant==null) gap=`<span class="gap muted">Prix à venir</span>`;
    else if(prices.length>1&&o.montant===min) gap=`<span class="gap best">Le moins cher</span>`;
    else if(prices.length>1) gap=`<span class="gap">+${eur(o.montant-min).replace(" HT","")} (+${pct((o.montant-min)/min*100)} %)</span>`;
    return `<div class="subrow${g.retenue?" is-ret":""}">
      <button type="button" class="sr-four" data-open="${esc(d._id)}">${g.retenue?"✓ ":""}${esc(o.fournisseur)}${(o.version||1)>1?` <span class="vbadge">V${o.version}</span>`:""}</button>
      <span class="sr-price">${o.montant!=null?eur(o.montant):"—"}</span>
      ${gap||"<span></span>"}
      <span class="sr-det" title="${esc(rest)}">${esc(rest)}</span>
      <span class="sr-links">${o.fichierId?`<a href="/api/file?p=${esc(o.fichierId)}" target="_blank" rel="noopener">${CLIP}${esc(ext(o.fichierNom))}</a>`:""}${url?`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(hostOf(url))} ↗</a>`:""}</span>
    </div>`;
  }).join("")+`</div>`;
}
function offerCell(d){
  const r=retained(d._id), groups=supplierGroups(d._id);
  if(r) return `<span class="ret">✓ <b>${esc(r.fournisseur)}</b>${r.montant!=null?" · "+eur(r.montant):""}</span>`;
  if(!groups.length) return d.fournisseur?esc(d.fournisseur):"Aucune proposition";
  if(groups.length===1){const o=groups[0].latest;return `<span class="many">${esc(o.fournisseur)}</span>${(o.version||1)>1?" · V"+o.version:""}${o.montant!=null?" · "+eur(o.montant):""}`}
  const prices=groups.map(g=>g.latest.montant).filter(n=>n!=null);
  return `<span class="many" title="${esc(groups.map(g=>g.latest.fournisseur).join(", "))}">${groups.length} propositions</span>${prices.length?" · dès "+eur(Math.min(...prices)):""}`;
}
function rowFile(d){
  const r=retained(d._id); if(r&&r.fichierId) return r;
  const g=supplierGroups(d._id); if(g.length===1&&g[0].latest.fichierId) return g[0].latest;
  return null;
}
function renderEvents(){
  renderFilters();
  const list=$("list");
  if(!gotDevis) return;
  const shown=rows.filter(match[filter]);
  const groups=new Map();
  for(const d of [...shown].sort((a,b)=>a.num-b.num)){const k=evKey(d);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(d)}
  if(filter==="tous")for(const e of EV.values())if(!e.virtual&&!groups.has(e._id))groups.set(e._id,[]);
  const newEv=canWrite?`<button type="button" class="new-ev" data-newev="1">+ Nouvel événement</button>`:"";
  if(!groups.size){list.innerHTML=(rows.length?`<div class="empty-state">Rien dans ce filtre. Tout est à jour.</div>`:`<div class="empty-state">Aucun devis pour l'instant. Ajoute le premier avec « + Nouveau besoin ».</div>`)+(filter==="tous"?newEv:"");return}
  const ordered=[...groups].map(([k,items])=>[EV.get(k)||{_id:k,nom:k},items]).sort((a,b)=>evTime(a[0])-evTime(b[0])||String(a[0].nom).localeCompare(String(b[0].nom),"fr"));
  let html="";
  for(const [ev,items] of ordered){
    const all=rows.filter(r=>evKey(r)===ev._id);
    const sig=all.filter(r=>r.signe).length, pay=all.filter(r=>r.paye).length;
    const tot=all.map(r=>retained(r._id)).filter(o=>o&&o.montant!=null).reduce((s,o)=>s+o.montant,0);
    const st=styleOf(ev), when=fmtEvDates(ev);
    const meta=[when,ev.lieu].filter(Boolean).map(esc).join(" · ");
    html+=`<section class="event"><div class="ev-head"><button type="button" class="tape ev-name ${evClass(st)}" style="${evStyle(st)}" data-ev="${esc(ev._id)}" title="Ouvrir la fiche de l'événement" ${canWrite?"":"disabled"}>${esc(ev.nom)}${canWrite?PEN:""}</button><span class="ev-count">${meta?`<b class="ev-when">${meta}</b> · `:""}${all.length} besoin${all.length>1?"s":""} · ${sig} signé${sig>1?"s":""} · ${pay} payé${pay>1?"s":""}${tot?" · retenu : "+eur(tot):""}${ev.notes?`<span class="ev-n" title="${esc(ev.notes)}"> · ${esc(ev.notes.replace(/\s+/g," "))}</span>`:""}</span>${canWrite?`<button type="button" class="ghost sm ev-add" data-addev="${esc(ev.nom==="Sans événement"?"":ev.nom)}">+ Besoin</button>`:""}</div>`;
    if(!items.length){html+=`<div class="sheet ev-empty">Aucun besoin pour l'instant.${canWrite?` <button type="button" class="linkish" data-addev="${esc(ev.nom)}">Ajouter le premier</button>`:""}</div></section>`;continue}
    html+=`<div class="sheet">`;
    html+=`<div class="row th" aria-hidden="true"><div class="l" style="padding-left:12px">N°</div><div class="l">Besoin</div><div class="l" style="padding-left:0">Propositions</div>${STEPS.map(s=>`<div>${s[1]}</div>`).join("")}<div></div>${FACT.map(s=>`<div>${s[1]}</div>`).join("")}</div>`;
    for(const d of items){
      const [cls,lab]=status(d), f=rowFile(d);
      html+=`<div class="row"><div class="num"><i class="dot ${cls}" title="${lab}"></i>${pad(d.num)}</div>`+
        `<div class="objc"><button type="button" class="obj" data-open="${esc(d._id)}">${esc(d.objet||"Sans objet")}</button>`+
        `<button type="button" class="kind ${kindOf(d)==="achat"?"ach":"loc"}" data-kind="${esc(d._id)}" title="${canWrite?"Cliquer pour passer en "+(kindOf(d)==="achat"?"location":"achat"):""}" ${canWrite?"":"disabled"}>${kindOf(d)==="achat"?"Achat":"Location"}</button>`+
        (f?`<a class="clip" href="/api/file?p=${esc(f.fichierId)}" target="_blank" rel="noopener" title="Ouvrir ${esc(f.fichierNom||"le devis")}">${CLIP}${esc(ext(f.fichierNom))}</a>`:"")+
        (kindOf(d)==="location"&&(d.debut||d.fin)?`<span class="dates">${fmtRange(d.debut,d.fin,d.hDebut,d.hFin,true)}</span>`:kindOf(d)==="achat"&&d.debut?`<span class="dates">${fmtLiv(d,true)}</span>`:"")+`</div>`+
        (supplierGroups(d._id).length?`<button type="button" class="offc offbtn" data-toggle="${esc(d._id)}" aria-expanded="${openRows.has(d._id)}" aria-controls="sub-${esc(d._id)}" title="Voir les propositions"><span class="oc">${offerCell(d)}</span><span class="chev" aria-hidden="true">▾</span></button>`:`<div class="offc">${offerCell(d)}</div>`)+`<div class="checks">`+
        STEPS.map(([k,l])=>ck(d,k,l,false)).join("")+`<div class="sep"><span class="sep-l">Facture</span></div>`+
        FACT.map(([k,l])=>ck(d,k,l,true)).join("")+`</div></div>`;
      if(openRows.has(d._id)&&supplierGroups(d._id).length)html+=subRows(d);
    }
    html+=`</div></section>`;
  }
  list.innerHTML=html+(filter==="tous"?newEv:"");
}

/* ---------- memory view ---------- */
// Latest version of each supplier's proposal on each besoin, newest first
function memEntries(){
  const out=[];
  for(const d of rows) for(const g of supplierGroups(d._id)) out.push({o:g.latest,d,retenue:g.retenue});
  return out.sort((a,b)=>String(b.o.cree||"").localeCompare(String(a.o.cree||"")));
}
function renderMemory(){
  const q=keyOf($("memSearch").value);
  const groups=new Map();
  for(const e of memEntries()){
    const k=keyOf(e.d.objet)||"autre";
    if(q&&!(k.includes(q)||keyOf(e.o.fournisseur).includes(q)||keyOf(e.o.detail).includes(q)))continue;
    if(!groups.has(k))groups.set(k,{name:e.d.objet||"Autre",items:[]});
    groups.get(k).items.push(e);
  }
  const box=$("memView");
  if(!groups.size){box.innerHTML=`<div class="empty-state">${q?"Rien trouvé pour cette recherche.":"La mémoire se remplit quand vous ajoutez des propositions (fournisseur, prix, ce qui est loué) dans les besoins."}</div>`;return}
  let html="";
  for(const g of [...groups.values()].sort((a,b)=>a.name.localeCompare(b.name,"fr"))){
    const prices=g.items.map(e=>e.o.montant).filter(n=>n!=null);
    const fours=new Set(g.items.map(e=>keyOf(e.o.fournisseur))).size;
    html+=`<section class="event"><div class="ev-head"><span class="tape mem-tape ${evClass({c:"grey"})}">${esc(g.name)}</span><span class="ev-count">${g.items.length} proposition${g.items.length>1?"s":""} · ${fours} fournisseur${fours>1?"s":""}${prices.length?" · de "+eur(Math.min(...prices))+" à "+eur(Math.max(...prices)):""}</span></div>`+
      `<div class="sheet mem-wrap"><table class="mem-table"><thead><tr><th>Fournisseur</th><th>Montant</th><th>Ce qui est loué</th><th>Événement</th><th></th></tr></thead><tbody>`;
    for(const e of g.items){
      html+=`<tr><td class="four">${esc(e.o.fournisseur)}${(e.o.version||1)>1?` <span class="vbadge">V${e.o.version}</span>`:""}</td><td class="p">${eur(e.o.montant)||"—"}</td><td class="det">${linkifyShort(e.o.detail||"")}</td>`+
        `<td><button type="button" class="linkish" data-open="${esc(e.d._id)}">${esc(evOf(e.d))} · ${pad(e.d.num)}</button><div class="notice">${day(e.o.cree)}</div></td>`+
        `<td>${e.retenue?'<span class="yes">✓ Retenu</span><br>':""}${fileLink(e.o.fichierId,e.o.fichierNom,ext(e.o.fichierNom))}</td></tr>`;
    }
    html+=`</tbody></table></div></section>`;
  }
  box.innerHTML=html;
}

function renderLists(){
  const ev=[...EV.values()].filter(e=>e.nom&&e.nom!=="Sans événement").sort((a,b)=>evTime(a)-evTime(b)).map(e=>e.nom);
  $("events").innerHTML=ev.map(e=>`<option value="${esc(e)}">`).join("");
  const ob=new Map();rows.forEach(r=>{if(r.objet&&!ob.has(keyOf(r.objet)))ob.set(keyOf(r.objet),r.objet)});
  $("objets").innerHTML=[...ob.values()].map(e=>`<option value="${esc(e)}">`).join("");
  const fo=new Map();offres.forEach(o=>{if(o.fournisseur&&!fo.has(keyOf(o.fournisseur)))fo.set(keyOf(o.fournisseur),o.fournisseur)});
  $("fournisseurs").innerHTML=[...fo.values()].map(e=>`<option value="${esc(e)}">`).join("");
}
function render(){
  buildEvents();
  if(!["events","memoire","calendrier","corbeille"].includes(view))view="events";
  $("tabEv").setAttribute("aria-selected",view==="events");$("tabMem").setAttribute("aria-selected",view==="memoire");$("tabCal").setAttribute("aria-selected",view==="calendrier");
  {const cur={events:"tabEv",memoire:"tabMem",calendrier:"tabCal"}[view]||"tabEv";for(const t of TABS)$(t).tabIndex=t===cur?0:-1}
  $("viewEvents").hidden=view!=="events";$("viewMem").hidden=view!=="memoire";$("viewCal").hidden=view!=="calendrier";$("viewTrash").hidden=view!=="corbeille";
  paintFoot();
  renderLists();
  if(view==="events")renderEvents();else if(view==="memoire")renderMemory();else if(view==="corbeille")renderTrash();else renderCalendar();
  if(fiche)renderFiche();
}

/* ---------- writes ---------- */
const queues={};
function write(id,fn){
  pending++;
  queues[id]=(queues[id]||Promise.resolve()).then(fn).catch(e=>{
    if(e&&e.code==="login")return;
    lastSig=""; // show the server's state again on the next refresh
    showNotice(e&&e.code==="offline"?"Pas de connexion : la dernière modification n'a pas été enregistrée.":"La modification n'a pas été enregistrée. Réessaie dans un instant.");
  }).finally(()=>{pending--;if(!pending)setTimeout(refresh,300)});
  return queues[id];
}
function showNotice(t){const n=$("notice");n.textContent=t;n.hidden=false}
const dropAsset=id=>{if(id&&assets)assets.delete(id).catch(()=>{})};

/* ---------- page events ---------- */
$("filters").addEventListener("click",e=>{
  const b=e.target.closest("[data-f]");if(!b)return;
  filter=b.dataset.f;try{localStorage.setItem("devis-filter",filter)}catch(_){}
  render();
});
/* ---------- keyboard ----------
   An open fiche keeps the keyboard: the page behind is inert, Tab cycles inside the fiche, and
   closing it gives the focus back to what opened it. The view tabs move with ← → Home End. */
const TABS=["tabEv","tabMem","tabCal"];
const focusables=root=>[...root.querySelectorAll('a[href],button,input,textarea,select,[tabindex]:not([tabindex="-1"])')].filter(e=>!e.disabled&&!e.hidden&&e.getClientRects().length&&!e.closest("[hidden],[inert]"));
const opener=[];
function describe(el){
  if(!el||el===document.body)return null;
  for(const a of ["data-open","data-ev","data-addev","data-toggle","data-newev"])if(el.hasAttribute&&el.hasAttribute(a))return `[${a}="${CSS.escape(el.getAttribute(a))}"]`;
  return el.id?"#"+CSS.escape(el.id):null;
}
function modalOpened(veil){
  if(!opener.some(o=>o.veil===veil)){const el=document.activeElement;opener.push({veil,el,sel:describe(el)})}
  $("app").inert=true;
  for(const v of document.querySelectorAll(".veil"))v.inert=v!==veil;
}
function modalClosed(){
  const still=[...document.querySelectorAll(".veil")].filter(v=>!v.hidden);
  const o=opener.pop();
  if(still.length){still.at(-1).inert=false}else{$("app").inert=false;for(const v of document.querySelectorAll(".veil"))v.inert=false}
  // the opener may have been redrawn meanwhile: find it again by what it opens
  const back=(o&&o.el&&o.el.isConnected&&!o.el.closest("[inert],[hidden]"))?o.el:(o&&o.sel?document.querySelector(o.sel):null);
  if(back&&!back.closest("[hidden]"))back.focus({preventScroll:true});
}
document.addEventListener("keydown",e=>{
  if(e.key!=="Tab")return;
  const veil=[...document.querySelectorAll(".veil")].find(v=>!v.hidden&&!v.inert);if(!veil)return;
  const f=focusables(veil);if(!f.length)return;
  const first=f[0],last=f.at(-1),cur=document.activeElement;
  if(!veil.contains(cur)){e.preventDefault();(e.shiftKey?last:first).focus();return}
  if(e.shiftKey&&cur===first){e.preventDefault();last.focus()}
  else if(!e.shiftKey&&cur===last){e.preventDefault();first.focus()}
});
document.querySelector(".tabs").addEventListener("keydown",e=>{
  const i=TABS.indexOf(e.target.id);if(i<0)return;
  const j={ArrowRight:(i+1)%3,ArrowLeft:(i+2)%3,Home:0,End:2}[e.key];if(j===undefined)return;
  e.preventDefault();$(TABS[j]).click();$(TABS[j]).focus();
});
document.querySelector(".tabs").addEventListener("click",e=>{
  const b=e.target.closest("[data-view]");if(!b)return;
  view=b.dataset.view;try{localStorage.setItem("devis-view",view)}catch(_){}
  render();
});
$("memSearch").addEventListener("input",renderMemory);
$("memView").addEventListener("click",e=>{const o=e.target.closest("[data-open]");if(o)openFiche(o.dataset.open)});
$("list").addEventListener("click",e=>{
  const c=e.target.closest(".ck");
  if(c&&db&&canWrite){
    const d=devisById(c.dataset.id);if(!d)return;
    const k=c.dataset.k, v=!d[k];
    d[k]=v;c.setAttribute("aria-pressed",v);
    write(d._id,()=>api("devis",d._id,"update",{[k]:v}));
    return;
  }
  const o=e.target.closest("[data-open]");
  if(o)return openFiche(o.dataset.open);
  const en=e.target.closest("[data-ev]");
  if(en&&canWrite)return openRename(en.dataset.ev);
  const ad=e.target.closest("[data-addev]");
  if(ad)return openFiche(null,ad.dataset.addev);
  if(e.target.closest("[data-newev]")&&canWrite)openRename(null);
});

/* ---------- edit an event: name + look (stored on each of its besoins as evStyle) ---------- */
const COLORS=[["yellow","Jaune"],["orange","Orange"],["red","Rouge"],["pink","Rose"],["purple","Violet"],["blue","Bleu"],["green","Vert"],["grey","Gris"],["white","Blanc"],["black","Noir"]];
const SIZES={s:"calc(var(--tape-k,1)*1.05rem)",m:"calc(var(--tape-k,1)*1.35rem)",l:"calc(var(--tape-k,1)*1.75rem)",xl:"calc(var(--tape-k,1)*2.2rem)"};
const defStyle=()=>({c:"grey",b:true,i:false,s:false,l:false,u:false,z:"m"});
/* ---------- events ----------
   An event is a fiche of its own (evenements table: nom, date, dateFin, lieu, notes, style).
   Besoins point to it with eventId. Older besoins only carry the event's name: they map to a
   « virtual » event whose id is derived from that name, until someone edits the event. */
const slugId=n=>"ev-"+(String(n||"").normalize("NFD").replace(/[̀-ͯ]/g,"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,60)||"sans-evenement");
const evKey=r=>r.eventId||slugId((r.evenement||"Sans événement").trim());
function buildEvents(){
  const m=new Map(events.map(e=>[e._id,{...e}]));
  for(const r of rows){
    const k=evKey(r);
    if(!m.has(k))m.set(k,{_id:k,nom:(r.evenement||"Sans événement").trim(),style:r.evStyle||null,virtual:true});
    else if(!m.get(k).style&&r.evStyle)m.get(k).style=r.evStyle;
  }
  EV=m;
}
const evObj=r=>EV.get(evKey(r))||{_id:evKey(r),nom:(r.evenement||"Sans événement").trim(),virtual:true};
const evOf=r=>evObj(r).nom||"Sans événement";
const styleOf=ev=>({...defStyle(),...((ev&&ev.style)||{})});
const evTime=ev=>{const d=dayOf(ev&&ev.date);return d?d.getTime():evDate(ev&&ev.nom)};
const evByName=name=>{const k=keyOf(name);return [...EV.values()].find(e=>keyOf(e.nom)===k)};
function fmtEvDates(ev){
  const a=dayOf(ev.date),b=dayOf(ev.dateFin);if(!a)return"";
  const f=(d,o)=>d.toLocaleDateString("fr-FR",o).replace(/\./g,"");
  if(!b||+b===+a)return f(a,{weekday:"short",day:"numeric",month:"short",year:"numeric"});
  if(a.getMonth()===b.getMonth()&&a.getFullYear()===b.getFullYear())return `${f(a,{weekday:"short",day:"numeric"})} → ${f(b,{weekday:"short",day:"numeric",month:"short",year:"numeric"})}`;
  return `${f(a,{day:"numeric",month:"short"})} → ${f(b,{day:"numeric",month:"short",year:"numeric"})}`;
}
const evClass=st=>"t-"+(COLORS.some(c=>c[0]===st.c)?st.c:"yellow");
function evStyle(st){
  const deco=[st.s&&"line-through",st.l&&"underline"].filter(Boolean).join(" ")||"none";
  return `font-weight:${st.b?700:400};font-style:${st.i?"italic":"normal"};text-decoration:${deco};text-decoration-thickness:${st.s?"2px":"auto"};text-transform:${st.u?"uppercase":"none"};letter-spacing:${st.u?".04em":".01em"};font-size:${SIZES[st.z]||SIZES.m}`;
}
let renaming=null, draft=null;
$("evColors").innerHTML=COLORS.map(([c,l])=>`<button type="button" class="sw t-${c}" data-c="${c}" title="${l}" aria-label="${l}"></button>`).join("");
function paintDraft(){
  const pv=$("evPreview");
  pv.className="tape "+evClass(draft);pv.setAttribute("style",evStyle(draft));
  pv.textContent=$("evName").value.trim()||"Nom de l'événement";
  document.querySelectorAll("#evColors .sw").forEach(b=>b.setAttribute("aria-pressed",b.dataset.c===draft.c));
  document.querySelectorAll("#evToggles .tg").forEach(b=>b.setAttribute("aria-pressed",!!draft[b.dataset.t]));
  document.querySelectorAll("#evSizes button").forEach(b=>b.setAttribute("aria-pressed",b.dataset.z===draft.z));
}
function openRename(id){
  const ev=id?EV.get(id):null;
  if(id&&!ev)return;
  renaming=ev?ev._id:"";draft=styleOf(ev);
  const n=ev?rows.filter(r=>evKey(r)===ev._id).length:0;
  $("evTitle").textContent=ev?"Fiche de l'événement":"Nouvel événement";
  $("evName").value=ev&&ev.nom!=="Sans événement"?ev.nom:"";
  const guess=ev&&!ev.date&&isFinite(evDate(ev.nom))?isoOf(new Date(evDate(ev.nom))):"";
  $("evD1").value=ev?.date||guess;$("evD2").value=ev?.dateFin||"";$("evLieu").value=ev?.lieu||"";$("evNotes").value=ev?.notes||"";
  $("evHint").textContent=ev?(n?`${n} besoin${n>1?"s":""} dans cet événement.`:"Aucun besoin dans cet événement."):"";
  $("evDel").hidden=!ev||ev.virtual||n>0;$("evDel").textContent="Supprimer l'événement";$("evDel").dataset.armed="";
  $("evErr").hidden=true;
  $("evMig").hidden=evTable;
  paintDraft();hideDiscard();snapEv=formState("#evForm")+JSON.stringify(draft);
  $("evVeil").hidden=false;modalOpened($("evVeil"));setTimeout(()=>$("evName").focus(),30);
}
function closeRename(){$("evVeil").hidden=true;renaming=null;draft=null;hideDiscard();modalClosed()}
$("evCancel").onclick=()=>tryCloseRename();$("evX").onclick=()=>tryCloseRename();
$("evVeil").addEventListener("click",e=>{if(e.target===$("evVeil"))tryCloseRename()});
$("evName").addEventListener("input",paintDraft);
$("evColors").addEventListener("click",e=>{const b=e.target.closest("[data-c]");if(b){draft.c=b.dataset.c;paintDraft()}});
$("evToggles").addEventListener("click",e=>{const b=e.target.closest("[data-t]");if(b){draft[b.dataset.t]=!draft[b.dataset.t];paintDraft()}});
$("evSizes").addEventListener("click",e=>{const b=e.target.closest("[data-z]");if(b){draft.z=b.dataset.z;paintDraft()}});
$("evReset").onclick=()=>{draft={...defStyle()};paintDraft()};
const evErr=t=>{$("evErr").textContent=t;$("evErr").hidden=false};
$("evForm").addEventListener("submit",e=>{
  e.preventDefault();
  const nom=$("evName").value.trim().replace(/\s+/g," ");
  if(!nom)return evErr("Indique un nom.");
  const date=$("evD1").value||null, dateFin=$("evD2").value||null;
  if(date&&dateFin&&dateFin<date)return evErr("La date de fin doit être après la date de début.");
  const ev=renaming?EV.get(renaming):null;
  const other=evByName(nom);
  if(other&&(!ev||other._id!==ev._id))return evErr("Un autre événement porte déjà ce nom.");
  const style={...draft};
  if(!evTable){
    // Database not updated yet: only the name and the look can be saved, on each besoin as before.
    if(!ev)return evErr("Pour créer un événement vide, la base doit d'abord être mise à jour (supabase/migration-2.sql).");
    for(const r of rows.filter(r=>evKey(r)===ev._id)){const patch={evenement:nom,evStyle:style,eventId:ev._id};Object.assign(r,patch);write(r._id,()=>api("devis",r._id,"update",patch))}
    closeRename();render();return;
  }
  const id=ev?ev._id:"ev-"+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
  const doc={nom,date,dateFin,lieu:$("evLieu").value.trim(),notes:$("evNotes").value.trim(),style,cree:(ev&&ev.cree)||new Date().toISOString()};
  const i=events.findIndex(x=>x._id===id);if(i>=0)events[i]={_id:id,...doc};else events.push({_id:id,...doc});
  write(id,()=>api("evenements",id,"set",doc));
  for(const r of rows.filter(r=>evKey(r)===id&&(r.eventId!==id||r.evenement!==nom))){
    const patch={eventId:id,evenement:nom};Object.assign(r,patch);write(r._id,()=>api("devis",r._id,"update",patch));
  }
  closeRename();render();
});
$("evDel").onclick=()=>{
  const b=$("evDel");
  if(!b.dataset.armed){b.dataset.armed="1";b.textContent="Confirmer la suppression";return}
  const id=renaming,ev=EV.get(id);closeRename();
  events=events.filter(x=>x._id!==id);render();
  write(id,()=>api("evenements",id,"delete"));
  toast(`Événement « ${ev?ev.nom:""} » mis à la corbeille.`,()=>restoreItem("evenements",id));
};
$("addBtn").onclick=()=>openFiche(null);

$("list").addEventListener("click",e=>{
  const t=e.target.closest("[data-toggle]");if(!t)return;
  e.stopPropagation();
  const id=t.dataset.toggle;openRows.has(id)?openRows.delete(id):openRows.add(id);renderEvents();
},true);

/* ---------- location / achat ---------- */
const kindOf=d=>d.type==="achat"?"achat":"location";
const fmtD=iso=>{const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(iso||"");if(!m)return"";const d=new Date(+m[1],+m[2]-1,+m[3]);return d.toLocaleDateString("fr-FR",{weekday:"short",day:"numeric",month:"short"}).replace(/\./g,"")};
const fmtH=h=>{const m=/^(\d{2}):(\d{2})/.exec(h||"");return m?`${+m[1]}h${m[2]==="00"?"":m[2]}`:""};
// "jeu 5 nov 9h → lun 9 nov 14h · 5 j" (hours optional); html=true wraps hours in <b>
// "Livraison jeu 5 nov 9h" (purchases)
function fmtLiv(d,html){const h=fmtH(d.hDebut);return `Livraison ${fmtD(d.debut)}${h?(html?` <b>${h}</b>`:` ${h}`):""}`}
function fmtRange(a,b,ha,hb,html){
  const H=h=>{const t=fmtH(h);return t?(html?` <b>${t}</b>`:` ${t}`):""};
  if(a&&b){const n=Math.round((new Date(b)-new Date(a))/864e5)+1;return `${fmtD(a)}${H(ha)} → ${fmtD(b)}${H(hb)}`+(n>0?` · ${n} j`:"")}
  return a?`arrivée ${fmtD(a)}${H(ha)}`:`reprise ${fmtD(b)}${H(hb)}`}
let fKind="location";
function paintKind(){
  document.querySelectorAll("#fKind button").forEach(b=>b.setAttribute("aria-pressed",b.dataset.k===fKind));
  document.querySelectorAll("#baseForm .loc-only").forEach(l=>l.hidden=fKind!=="location");
  // a purchase is delivered once and never taken back: one date and time, no pickup
  $("whenInL").textContent=fKind==="achat"?"Livraison (facultatif)":"Arrivée du matériel";
  $("fDebut").setAttribute("aria-label",fKind==="achat"?"Date de livraison":"Date d'arrivée");
  $("fHDebut").setAttribute("aria-label",fKind==="achat"?"Heure de livraison":"Heure d'arrivée");
}
$("fKind").addEventListener("click",e=>{const b=e.target.closest("[data-k]");if(b&&canWrite){fKind=b.dataset.k;paintKind()}});
$("list").addEventListener("click",e=>{
  const t=e.target.closest("[data-kind]");if(!t||!canWrite)return;
  e.stopPropagation();
  const d=devisById(t.dataset.kind);if(!d)return;
  const type=kindOf(d)==="achat"?"location":"achat";
  d.type=type;write(d._id,()=>api("devis",d._id,"update",{type}));render();
},true);

/* ---------- calendrier des locations ---------- */
let calMonth=(()=>{const n=new Date();return new Date(n.getFullYear(),n.getMonth(),1)})();
try{const m=/^(\d{4})-(\d{2})$/.exec(localStorage.getItem("devis-cal")||"");if(m)calMonth=new Date(+m[1],+m[2]-1,1)}catch(_){}
const isoOf=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
const dayOf=iso=>{const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(iso||"");return m?new Date(+m[1],+m[2]-1,+m[3]):null};
function locations(){
  return rows.filter(r=>kindOf(r)==="location"?(r.debut||r.fin):r.debut).map(r=>{
    const liv=kindOf(r)==="achat";
    let a=dayOf(r.debut||r.fin), b=liv?a:dayOf(r.fin||r.debut); if(b<a)[a,b]=[b,a];
    const ret=retained(r._id), g=supplierGroups(r._id);
    const four=ret?ret.fournisseur:(g.length===1?g[0].latest.fournisseur:"");
    return {r,a,b,four,liv,c:evClass(styleOf(evObj(r)))};
  }).sort((x,y)=>x.a-y.a||x.b-y.b||x.r.num-y.r.num);
}
function setCal(d){calMonth=new Date(d.getFullYear(),d.getMonth(),1);try{localStorage.setItem("devis-cal",isoOf(calMonth).slice(0,7))}catch(_){}renderCalendar()}
$("calPrev").onclick=()=>setCal(new Date(calMonth.getFullYear(),calMonth.getMonth()-1,1));
$("calNext").onclick=()=>setCal(new Date(calMonth.getFullYear(),calMonth.getMonth()+1,1));
$("calToday").onclick=()=>setCal(new Date());
$("calView").addEventListener("click",e=>{const o=e.target.closest("[data-open]");if(o)openFiche(o.dataset.open)});
function renderCalendar(){
  const y=calMonth.getFullYear(), m=calMonth.getMonth();
  const first=new Date(y,m,1), last=new Date(y,m+1,0);
  $("calTitle").textContent=first.toLocaleDateString("fr-FR",{month:"long",year:"numeric"});
  const all=locations();
  const inMonth=all.filter(l=>l.b>=first&&l.a<=last);
  {const nl=inMonth.filter(l=>!l.liv).length,nv=inMonth.length-nl;
   $("calCount").textContent=inMonth.length?[nl?`${nl} location${nl>1?"s":""}`:"",nv?`${nv} livraison${nv>1?"s":""}`:""].filter(Boolean).join(" · ")+" ce mois-ci":"Aucune location ni livraison ce mois-ci"}
  const todayIso=isoOf(new Date());
  // weeks from the Monday on/before the 1st to the Sunday on/after the last day
  const start=new Date(y,m,1-((first.getDay()+6)%7));
  const end=new Date(y,m+1,0+(7-((last.getDay()+6)%7)-1));
  const label=(l,first,last)=>l.liv?`<span class="hb in" title="Livraison (achat, sans reprise)"><i>Livraison</i>${l.r.hDebut?" "+esc(fmtH(l.r.hDebut)):""}</span><span class="cl">${esc(l.r.objet||"Sans objet")}${l.four?` <span class="cf">· ${esc(l.four)}</span>`:""}</span>`:`${first&&l.r.hDebut?`<span class="hb in" title="Arrivée du matériel"><i>Arrivée</i> ${esc(fmtH(l.r.hDebut))}</span>`:""}<span class="cl">${esc(l.r.objet||"Sans objet")}${l.four?` <span class="cf">· ${esc(l.four)}</span>`:""}</span>${last&&l.r.hFin?`<span class="hb out" title="Reprise du matériel"><i>Reprise</i> ${esc(fmtH(l.r.hFin))}</span>`:""}`;
  const tip=l=>esc(`${l.r.objet||""} · ${evOf(l.r)}${l.four?" · "+l.four:""}\n${l.liv?fmtLiv(l.r):fmtRange(l.r.debut,l.r.fin,l.r.hDebut,l.r.hFin)}`);
  let html=`<div class="cal"><div class="cal-dow">${["Lun","Mar","Mer","Jeu","Ven","Sam","Dim"].map(d=>`<div>${d}</div>`).join("")}</div>`;
  for(let w=new Date(start);w<=end;w=new Date(w.getFullYear(),w.getMonth(),w.getDate()+7)){
    const wEnd=new Date(w.getFullYear(),w.getMonth(),w.getDate()+6);
    let cells="";
    for(let i=0;i<7;i++){
      const d=new Date(w.getFullYear(),w.getMonth(),w.getDate()+i);
      cells+=`<div class="cd${d.getMonth()!==m?" out":""}${i>4?" we":""}${isoOf(d)===todayIso?" today":""}" style="grid-column:${i+1}"><b>${d.getDate()}</b>${d.getDate()===1?" "+d.toLocaleDateString("fr-FR",{month:"short"}):""}</div>`;
    }
    // lanes: first-fit so overlapping rentals stack
    const lanes=[]; let bars="";
    for(const l of all.filter(l=>l.b>=w&&l.a<=wEnd)){
      const s=l.a<w?w:l.a, e=l.b>wEnd?wEnd:l.b;
      const c0=Math.round((s-w)/864e5), c1=Math.round((e-w)/864e5);
      let lane=lanes.findIndex(end=>end<c0); if(lane<0){lane=lanes.length;lanes.push(c1)}else lanes[lane]=c1;
      bars+=`<button type="button" class="cbar ${l.c}${l.a<w?" cont-l":""}${l.b>wEnd?" cont-r":""}" style="grid-column:${c0+1} / ${c1+2};grid-row:${lane+2}" data-open="${esc(l.r._id)}" title="${tip(l)}">${label(l,l.a>=w,l.b<=wEnd)}</button>`;
    }
    html+=`<div class="cal-week" style="grid-template-rows:28px repeat(${lanes.length},auto) minmax(10px,1fr)">${cells}${bars}</div>`;
  }
  html+=`</div>`;
  // phone: chronological list for the month
  html+=`<div class="cal-list">${inMonth.length?inMonth.map(l=>`<button type="button" class="cl-item" data-open="${esc(l.r._id)}"><span class="cl-when ${l.c}">${esc(fmtShort(l.a,l.b))}</span><span class="cl-what">${esc(l.r.objet||"Sans objet")}</span>${l.liv?`<span class="cl-hours"><span class="hb"><i>Livraison</i>${l.r.hDebut?" "+esc(fmtH(l.r.hDebut)):""}</span></span>`:l.r.hDebut||l.r.hFin?`<span class="cl-hours">${l.r.hDebut?`<span class="hb"><i>Arrivée</i> ${esc(fmtH(l.r.hDebut))}</span>`:""}${l.r.hFin?`<span class="hb"><i>Reprise</i> ${esc(fmtH(l.r.hFin))}</span>`:""}</span>`:""}<span class="cl-meta">${esc(evOf(l.r))}${l.four?" · "+esc(l.four):""}</span></button>`).join(""):`<div class="empty-state">Aucune location ni livraison ce mois-ci.</div>`}</div>`;
  const undated=rows.filter(r=>kindOf(r)==="location"&&!r.debut&&!r.fin).sort((a,b)=>evTime(evObj(a))-evTime(evObj(b))||a.num-b.num);
  if(undated.length)html+=`<div class="cal-undated"><h3>Locations sans dates (${undated.length})</h3><p>Ouvre un besoin pour indiquer son début et sa fin de location : il apparaîtra dans le calendrier.</p><div class="chips">${undated.map(r=>`<button type="button" data-open="${esc(r._id)}">${pad(r.num)} ${esc(r.objet||"Sans objet")} <span>· ${esc(evOf(r))}</span></button>`).join("")}</div></div>`;
  $("calView").innerHTML=html;
}
function fmtShort(a,b){const f=d=>d.toLocaleDateString("fr-FR",{day:"numeric",month:"short"}).replace(/\./g,"");return +a===+b?f(a):`${f(a)} → ${f(b)}`}

/* ---------- fiche (panel) ---------- */
function openFiche(id,prefillEvent){
  const d=id?devisById(id):null;
  if(id&&!d)return;
  if(!id&&!canWrite)return;
  fiche={id:id||null};oMode=null;
  $("fEvent").value=d?(evOf(d)==="Sans événement"?"":evOf(d)):(prefillEvent||"");$("fObjet").value=d?.objet||"";
  fKind=d?kindOf(d):"location";$("fDebut").value=d?.debut||"";$("fFin").value=d?.fin||"";$("fHDebut").value=d?.hDebut||"";$("fHFin").value=d?.hFin||"";paintKind();
  [$("fEvent"),$("fObjet"),$("fDebut"),$("fFin"),$("fHDebut"),$("fHFin"),$("saveBtn"),...document.querySelectorAll("#fKind button")].forEach(x=>x.disabled=!canWrite);
  $("saveBtn").textContent=d?"Enregistrer":"Créer le besoin";
  $("delBtn").hidden=!d||!canWrite;$("delBtn").textContent="Supprimer ce besoin";$("delBtn").dataset.armed="";
  $("fErr").hidden=true;
  $("veil").hidden=false;document.body.style.overflow="hidden";modalOpened($("veil"));
  renderFiche();hideDiscard();snapshotFiche();
  setTimeout(()=>{if(!d)$(prefillEvent?"fObjet":"fEvent").focus();else $("closeBtn").focus()},30);
}
function closeFiche(){$("veil").hidden=true;document.body.style.overflow="";fiche=null;oMode=null;hideDiscard();modalClosed()}

/* ---------- never lose what is being typed ----------
   A fiche, a proposal or an event closes only through its own buttons; a click beside it,
   Escape or the × first ask to confirm when something has not been saved. */
const formState=sel=>JSON.stringify([...document.querySelectorAll(`${sel} input:not([type=file]), ${sel} textarea`)].map(i=>i.value).concat([...document.querySelectorAll(`${sel} input[type=file]`)].map(i=>i.files.length)));
let snapFiche="", snapOffer="", snapEv="";
const baseState=()=>formState("#baseForm")+"|"+fKind;
function snapshotFiche(){snapFiche=baseState()}
function offerDirty(){return !!oMode&&formState("#offerForm")!==snapOffer}
function ficheDirty(){return !$("veil").hidden&&(baseState()!==snapFiche||offerDirty())}
function evDirty(){return !$("evVeil").hidden&&draft&&(formState("#evForm")+JSON.stringify(draft))!==snapEv}
function hideDiscard(){document.querySelectorAll(".discard").forEach(b=>b.hidden=true)}
function askDiscard(panel,onDiscard,what){
  let bar=panel.querySelector(".discard");
  if(!bar){
    bar=document.createElement("div");bar.className="discard";bar.setAttribute("role","alert");
    bar.innerHTML='<span class="discard-t"></span><span class="discard-b"><button type="button" class="ghost sm" data-d="keep">Continuer à modifier</button><button type="button" class="ghost sm discard-drop" data-d="drop">Fermer sans enregistrer</button></span>';
    const head=panel.querySelector(".p-head");head?head.after(bar):panel.prepend(bar);
  }
  bar.querySelector(".discard-t").textContent=what||"Tu as des modifications non enregistrées.";
  bar.hidden=false;
  bar.onclick=e=>{const b=e.target.closest("[data-d]");if(!b)return;bar.hidden=true;if(b.dataset.d==="drop")onDiscard()};
  bar.scrollIntoView({block:"nearest",behavior:"smooth"});
  bar.querySelector('[data-d="keep"]').focus({preventScroll:true});
  bar.classList.remove("nudge");void bar.offsetWidth;bar.classList.add("nudge");
}
const fichePanel=()=>$("veil").querySelector(".panel");
function tryCloseFiche(){ficheDirty()?askDiscard(fichePanel(),closeFiche):closeFiche()}
function tryCloseRename(){evDirty()?askDiscard($("evForm"),closeRename,"Les changements de l'événement ne sont pas enregistrés."):closeRename()}
$("closeBtn").onclick=tryCloseFiche;
$("veil").addEventListener("click",e=>{if(e.target===$("veil"))tryCloseFiche()});
document.addEventListener("keydown",e=>{if(e.key!=="Escape")return;if(!$("evVeil").hidden)tryCloseRename();else if(!$("veil").hidden)tryCloseFiche()});
window.addEventListener("beforeunload",e=>{if(ficheDirty()||evDirty()){e.preventDefault();e.returnValue=""}});
$("fObjet").addEventListener("input",()=>{if(fiche&&!fiche.id)renderMem()});

function renderFiche(){
  const d=fiche.id?devisById(fiche.id):null;
  if(fiche.id&&!d){closeFiche();return}
  $("pTitle").textContent=d?`${pad(d.num)} · ${d.objet||"Sans objet"}`:"Nouveau besoin";
  $("pEv").textContent=d?evOf(d):"Indique l'événement et le besoin, puis ajoute les propositions des fournisseurs.";
  $("propSec").hidden=!d;
  $("offerForm").hidden=!oMode;
  $("addOfferBtn").hidden=!canWrite||!!oMode;
  if(d)renderProps(d);
  renderMem();
}
function renderProps(d){
  const groups=supplierGroups(d._id).sort((a,b)=>(b.retenue-a.retenue)||((a.latest.montant??Infinity)-(b.latest.montant??Infinity)));
  $("propTitle").textContent=`Propositions${groups.length?" ("+groups.length+")":""}`;
  if(!groups.length){$("propList").innerHTML=`<p class="hint">Aucune proposition pour l'instant. Ajoute celle de chaque fournisseur consulté pour les comparer.</p>`;return}
  $("propList").innerHTML=groups.map(g=>{
    const o=g.latest, isRet=!!o.retenue;
    return `<div class="offer${isRet?" retenue":""}">
      <div class="o-top"><span class="o-four">${esc(o.fournisseur)}</span><span class="vbadge">V${o.version||1}</span>${isRet?'<span class="rbadge">✓ Retenue</span>':""}<span class="o-price">${eur(o.montant)||"Prix à venir"}</span></div>
      ${o.detail?`<div class="o-det">${linkifyShort(o.detail)}</div>`:""}
      <div class="o-meta">${o.ref?`<span>Réf. ${esc(o.ref)}</span>`:""}<span>${day(o.cree)}</span>${fileLink(o.fichierId,o.fichierNom,"Ouvrir le "+ext(o.fichierNom))}</div>
      ${g.olds.length?`<div class="olds">${g.olds.map(v=>`<div><s>V${v.version||1}</s><span>${eur(v.montant)||"—"}</span><span>${day(v.cree)}</span>${fileLink(v.fichierId,v.fichierNom,ext(v.fichierNom))}${v.retenue?'<span class="yes">✓ retenue</span>':""}</div>`).join("")}</div>`:""}
      ${canWrite?`<div class="o-acts">
        <button type="button" class="ghost sm" data-act="retenir" data-o="${esc(o._id)}">${isRet?"Ne plus retenir":"Retenir"}</button>
        <button type="button" class="ghost sm" data-act="version" data-o="${esc(o._id)}">Nouvelle version</button>
        <button type="button" class="ghost sm" data-act="edit" data-o="${esc(o._id)}">Modifier</button>
        <button type="button" class="danger" data-act="del" data-o="${esc(o._id)}">Supprimer</button></div>`:""}
    </div>`;
  }).join("");
}
function renderMem(){
  const objet=fiche.id?devisById(fiche.id)?.objet:$("fObjet").value;
  const k=keyOf(objet);
  if(!k){$("memSec").hidden=true;return}
  $("memSec").hidden=false;
  $("memTitle").textContent=`Déjà en mémoire · ${objet.trim()}`;
  const items=memEntries().filter(e=>e.d._id!==fiche.id&&keyOf(e.d.objet)===k);
  if(!items.length){$("memList").innerHTML=`<p class="hint">Pas encore de proposition « ${esc(objet.trim())} » sur d'autres événements. Celles que tu ajoutes ici serviront la prochaine fois.</p>`;return}
  $("memList").innerHTML=items.map(e=>`<div class="mem-item">
      <div><span class="o-four">${esc(e.o.fournisseur)}</span>${e.retenue?' <span class="rbadge">✓ Retenu</span>':""}</div>
      <span class="o-price">${eur(e.o.montant)||"—"}</span>
      ${e.o.detail?`<div class="m-det">${linkifyShort(e.o.detail)}</div>`:""}
      <div class="m-meta"><span>${esc(evOf(e.d))} · ${pad(e.d.num)}</span><span>${day(e.o.cree)}</span>${fileLink(e.o.fichierId,e.o.fichierNom,"Ouvrir le "+ext(e.o.fichierNom))}
      ${fiche.id&&canWrite?`<button type="button" class="ghost sm" data-act="reprendre" data-o="${esc(e.o._id)}">Reprendre ce fournisseur</button>`:""}</div>
    </div>`).join("");
}

$("baseForm").addEventListener("submit",e=>{
  e.preventDefault();if(!db||!canWrite)return;
  const data={evenement:$("fEvent").value.trim(),objet:$("fObjet").value.trim(),type:fKind,
    debut:$("fDebut").value||null,fin:fKind==="location"?($("fFin").value||null):null,
    hDebut:$("fDebut").value?($("fHDebut").value||null):null,hFin:fKind==="location"&&$("fFin").value?($("fHFin").value||null):null};
  if(data.debut&&data.fin&&(data.fin<data.debut||(data.fin===data.debut&&data.hDebut&&data.hFin&&data.hFin<=data.hDebut))){$("fErr").textContent="La reprise doit être après l'arrivée du matériel.";$("fErr").hidden=false;return}
  if(!data.evenement||!data.objet){$("fErr").textContent="Indique l'événement et le besoin.";$("fErr").hidden=false;return}
  {const ev=evByName(data.evenement);if(ev){data.eventId=ev._id;data.evenement=ev.nom}else data.eventId=slugId(data.evenement)}
  $("fErr").hidden=true;
  if(fiche.id){
    const id=fiche.id;
    write(id,()=>api("devis",id,"update",data));
    const d=devisById(id);Object.assign(d,data);render();snapshotFiche();
  }else{
    // provisional number on screen; the server gives the real one (never twice the same)
    const num=rows.concat(trash.devis).reduce((m,r)=>Math.max(m,r.num||0),0)+1;
    const id="d-"+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
    const doc={...data,aEnvoyer:false,envoye:false,signe:false,paye:false,factSB:false,factRecue:false,factEnvoyee:false,cree:new Date().toISOString()};
    rows.push({_id:id,num,...doc});
    write(id,async()=>{const r=await api("devis",id,"create",doc);const d=devisById(id);if(d&&r.num&&d.num!==r.num){d.num=r.num;render()}});
    openFiche(id);openOffer({kind:"add"});
  }
});
$("delBtn").onclick=()=>{
  const b=$("delBtn");
  if(!b.dataset.armed){b.dataset.armed="1";b.textContent="Confirmer : supprimer le besoin et ses propositions";return}
  const id=fiche.id, d=devisById(id);closeFiche();
  rows=rows.filter(r=>r._id!==id);render();
  write(id,()=>api("devis",id,"delete"));
  toast(`${pad(d.num)} ${d.objet||""} mis à la corbeille avec ses propositions.`,()=>restoreItem("devis",id));
};

/* offers: add / new version / edit / retain / delete / reuse */
function openOffer(mode,prefill){
  oMode=mode;
  const o=mode.offre;
  $("oTitle").textContent=mode.kind==="edit"?`Modifier ${o.fournisseur} V${o.version||1}`:mode.kind==="version"?`${o.fournisseur} · nouvelle version (V${nextVersion(o)})`:"Nouvelle proposition";
  const src=mode.kind==="add"?(prefill||{}):o;
  $("oFour").value=src.fournisseur||"";$("oFour").disabled=mode.kind==="version";
  $("oMontant").value=mode.kind==="add"?"":(o.montant??"");
  $("oDetail").value=src.detail||"";
  $("oRef").value=mode.kind==="edit"?(o.ref||""):"";
  $("oFile").value="";$("oFile").hidden=!assets;
  $("oFileHint").hidden=!!assets;
  $("oFileHint").textContent="Pour joindre un fichier, il faut l'accès « Éditeur » à la page.";
  if(mode.kind==="edit"&&o.fichierId&&assets){$("oFileHint").hidden=false;$("oFileHint").textContent=`Fichier actuel : ${o.fichierNom||"devis"}. Choisis-en un autre pour le remplacer.`}
  $("oErr").hidden=true;
  renderFiche();snapOffer=formState("#offerForm");
  $("offerForm").scrollIntoView({block:"nearest"});
  setTimeout(()=>$(mode.kind==="version"?"oMontant":"oFour").focus(),30);
}
function nextVersion(o){return offersOf(o.devisId).filter(x=>keyOf(x.fournisseur)===keyOf(o.fournisseur)).reduce((m,x)=>Math.max(m,x.version||1),0)+1}
$("addOfferBtn").onclick=()=>openOffer({kind:"add"});
$("oCancel").onclick=()=>{const drop=()=>{oMode=null;renderFiche()};offerDirty()?askDiscard(fichePanel(),drop,"Cette proposition n'est pas enregistrée."):drop()};
const parseMontant=v=>{const s=String(v).replace(/[\s €]/g,"").replace(/HT/i,"").replace(",",".");if(!s)return null;const n=parseFloat(s);return isNaN(n)?null:Math.round(n*100)/100};

$("offerForm").addEventListener("submit",async e=>{
  e.preventDefault();if(!db||!canWrite||!oMode||!fiche?.id)return;
  const mode=oMode, base=mode.offre;
  const four=(mode.kind==="version"?base.fournisseur:$("oFour").value).trim();
  if(!four){$("oErr").textContent="Indique le fournisseur.";$("oErr").hidden=false;return}
  const montant=parseMontant($("oMontant").value);
  if($("oMontant").value.trim()&&montant==null){$("oErr").textContent="Le montant doit être un nombre, par exemple 1250 ou 1 250,50.";$("oErr").hidden=false;return}
  const data={fournisseur:four,montant,detail:$("oDetail").value.trim(),ref:$("oRef").value.trim()};
  const file=$("oFile").files[0];
  if(file&&assets){
    const t=/\.pdf$/i.test(file.name)?"application/pdf":(file.type||undefined);
    $("oSave").disabled=true;$("oSave").textContent="Envoi du fichier…";
    try{const r=await assets.upload(file,t?{type:t}:undefined);data.fichierId=r.id;data.fichierNom=file.name}
    catch(err){$("oErr").textContent=UPLOAD_ERR[err&&err.code]||"Le fichier n'a pas pu être envoyé. Réessaie.";$("oErr").hidden=false;$("oSave").disabled=false;$("oSave").textContent="Enregistrer";return}
    $("oSave").disabled=false;$("oSave").textContent="Enregistrer";
  }
  const devisId=fiche.id, now=new Date().toISOString();
  if(mode.kind==="edit"){
    const id=base._id, old=base.fichierId;
    Object.assign(base,data);
    write(id,async()=>{await api("offres",id,"update",data);if(data.fichierId&&old&&old!==data.fichierId)dropAsset(old)});
  }else{
    const version=mode.kind==="version"?nextVersion(base):(offersOf(devisId).some(x=>keyOf(x.fournisseur)===keyOf(four))?nextVersion({devisId,fournisseur:four}):1);
    const id="o"+Date.now().toString(36)+Math.random().toString(36).slice(2,5);
    const doc={devisId,...data,version,retenue:false,cree:now};
    if(doc.fichierId===undefined){doc.fichierId=null;doc.fichierNom=null}
    offres.push({_id:id,...doc});
    write(id,()=>api("offres",id,"set",doc));
  }
  oMode=null;render();
});

$("propList").addEventListener("click",e=>{
  const b=e.target.closest("[data-act]");if(!b||!canWrite)return;
  const o=offres.find(x=>x._id===b.dataset.o);if(!o)return;
  const act=b.dataset.act;
  if(act==="version")return openOffer({kind:"version",offre:o});
  if(act==="edit")return openOffer({kind:"edit",offre:o});
  if(act==="retenir"){
    const on=!o.retenue;
    for(const x of offersOf(o.devisId)){
      const want=on&&x._id===o._id;
      if(!!x.retenue!==want){x.retenue=want;write(x._id,()=>api("offres",x._id,"update",{retenue:want}))}
    }
    render();return;
  }
  if(act==="del"){
    if(!b.dataset.armed){b.dataset.armed="1";b.textContent="Confirmer la suppression";return}
    // deleting the latest version removes only that version; older ones stay
    offres=offres.filter(x=>x._id!==o._id);
    write(o._id,()=>api("offres",o._id,"delete"));
    render();
    toast(`Proposition ${o.fournisseur} V${o.version||1} mise à la corbeille.`,()=>restoreItem("offres",o._id));
    return;
  }
});
$("memList").addEventListener("click",e=>{
  const b=e.target.closest("[data-act='reprendre']");if(!b)return;
  const o=offres.find(x=>x._id===b.dataset.o);if(!o)return;
  openOffer({kind:"add"},{fournisseur:o.fournisseur,detail:o.detail});
});

/* ---------- corbeille: 30 days to change your mind ---------- */
const purgeDay=iso=>{const d=new Date(iso);d.setDate(d.getDate()+30);return d.toLocaleDateString("fr-FR",{day:"numeric",month:"long"})};
function restoreItem(table,id){
  const list=trash[table], i=list.findIndex(x=>x._id===id);
  const target=table==="devis"?rows:table==="offres"?offres:events;
  if(i>=0){const it={...list[i]};delete it.deleted;list.splice(i,1);target.push(it)}
  else if(rawData){ // just deleted, not yet in the bin list
    const it=(rawData[table]||[]).find(x=>x._id===id);if(it&&!target.some(x=>x._id===id)){const c={...it};delete c.deleted;target.push(c)}
  }
  render();write(id,()=>api(table,id,"restore"));
}
function renderTrash(){
  const t=trash, n=t.devis.length+t.offres.length+t.evenements.length;
  const item=(table,x,title,sub)=>`<div class="tr-item"><div class="tr-main"><b>${title}</b><span>${sub}</span><span class="tr-when">Supprimé le ${day(x.deleted)} · effacé pour de bon le ${purgeDay(x.deleted)}</span></div>${canWrite?`<button type="button" class="ghost sm" data-restore="${table}" data-id="${esc(x._id)}">Restaurer</button>`:""}</div>`;
  let html=`<div class="tr-head"><button type="button" class="ghost sm" id="trBack">← Retour au tableau</button><h2>Corbeille</h2><p>Ce qui est supprimé reste ici 30 jours, puis disparaît définitivement avec ses PDF.</p></div>`;
  if(!n)html+=`<div class="empty-state">La corbeille est vide.</div>`;
  if(t.devis.length)html+=`<h3 class="tr-sec">Besoins (${t.devis.length})</h3>`+t.devis.map(x=>item("devis",x,`${pad(x.num)} ${esc(x.objet||"Sans objet")}`,`${esc((EV.get(evKey(x))||{}).nom||x.evenement||"")} · ${(rawData?.offres||[]).filter(o=>o.devisId===x._id).length} proposition(s)`)).join("");
  if(t.offres.length)html+=`<h3 class="tr-sec">Propositions (${t.offres.length})</h3>`+t.offres.map(x=>{const d=devisById(x.devisId);return item("offres",x,`${esc(x.fournisseur)} V${x.version||1} · ${eur(x.montant)||"prix à venir"}`,d?`${pad(d.num)} ${esc(d.objet||"")} · ${esc(evOf(d))}`:"")}).join("");
  if(t.evenements.length)html+=`<h3 class="tr-sec">Événements (${t.evenements.length})</h3>`+t.evenements.map(x=>item("evenements",x,esc(x.nom||""),esc([fmtEvDates(x),x.lieu].filter(Boolean).join(" · ")))).join("");
  $("trashView").innerHTML=html;
}
$("trashView").addEventListener("click",e=>{
  if(e.target.closest("#trBack")){view="events";render();return}
  const b=e.target.closest("[data-restore]");if(b&&canWrite)restoreItem(b.dataset.restore,b.dataset.id);
});
function paintFoot(){
  const n=trash.devis.length+trash.offres.length+trash.evenements.length;
  $("trashBtn").textContent=`Corbeille${n?` (${n})`:""}`;
}
$("trashBtn").onclick=()=>{view=view==="corbeille"?"events":"corbeille";render();window.scrollTo({top:0})};

// Undo bar after a deletion
let toastTimer=null;
function toast(text,undo){
  const t=$("toast");$("toastText").textContent=text;t.hidden=false;
  $("toastUndo").hidden=!undo;$("toastUndo").onclick=()=>{t.hidden=true;undo&&undo()};
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.hidden=true,8000);
}

/* ---------- export: an Excel sheet to read, a full backup to keep ---------- */
function download(name,content,type){
  const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([content],{type}));a.download=name;
  document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},1000);
}
const stamp=()=>isoOf(new Date());
function exportRows(){
  const yes=b=>b?"oui":"";
  const head=["N°","Événement","Date événement","Lieu","Besoin","Type","Arrivée / livraison","Heure arrivée / livraison","Reprise","Heure reprise","À envoyer","Envoyé","Signé","Payé","Facture SB","Facture reçue","Facture envoyée","Fournisseur","Version","Montant HT","Retenue","Ce qui est loué","Réf. fournisseur","PDF"];
  const lines=[head];
  for(const d of [...rows].sort((a,b)=>evTime(evObj(a))-evTime(evObj(b))||a.num-b.num)){
    const ev=evObj(d);
    const b=[pad(d.num),ev.nom,ev.date?[ev.date,ev.dateFin].filter(Boolean).join(" → "):"",ev.lieu||"",d.objet||"",kindOf(d),d.debut||"",d.hDebut||"",kindOf(d)==="location"?d.fin||"":"",kindOf(d)==="location"?d.hFin||"":"",yes(d.aEnvoyer),yes(d.envoye),yes(d.signe),yes(d.paye),yes(d.factSB),yes(d.factRecue),yes(d.factEnvoyee)];
    const os=offersOf(d._id).sort((x,y)=>keyOf(x.fournisseur).localeCompare(keyOf(y.fournisseur))||(x.version||1)-(y.version||1));
    if(!os.length)lines.push([...b,"","","","","","",""]);
    for(const o of os)lines.push([...b,o.fournisseur,"V"+(o.version||1),o.montant,o.retenue?"oui":"",o.detail||"",o.ref||"",o.fichierId?`${location.origin}/api/file?p=${o.fichierId}`:""]);
  }
  return lines;
}
$("exportCsv").onclick=()=>{
  const cell=v=>{if(typeof v==="number")return String(v).replace(".",",");v=v==null?"":String(v);return /[;"\n\r]/.test(v)?`"${v.replace(/"/g,'""')}"`:v};
  download(`suivi-devis-${stamp()}.csv`,"﻿"+exportRows().map(l=>l.map(cell).join(";")).join("\r\n"),"text/csv;charset=utf-8");
};
$("exportJson").onclick=()=>{
  download(`sauvegarde-suivi-devis-${stamp()}.json`,JSON.stringify({exporte:new Date().toISOString(),...(rawData||{devis:rows,offres,evenements:events})},null,1),"application/json");
};

/* ---------- start ---------- */
// Data is fetched from the server, then refreshed every 15 s (and when the tab comes back),
// so changes made by the others show up without reloading.
let pending=0, refreshTimer=null, started=false;
async function refresh(){
  if(pending)return;
  try{
    const j=await call("/api/data");
    if(pending)return;
    $("notice").hidden=true;
    const sig=JSON.stringify(j);
    if(sig===lastSig&&gotDevis)return; // nothing new: no redraw, no flicker, focus kept
    lastSig=sig;rawData=j;
    const live=x=>!x.deleted;
    rows=j.devis.filter(live);offres=j.offres.filter(live);events=(j.evenements||[]).filter(live);evTable=j.evTable!==false;
    const liveIds=new Set(rows.map(r=>r._id));
    trash={devis:j.devis.filter(x=>x.deleted),offres:j.offres.filter(x=>x.deleted&&liveIds.has(x.devisId)),evenements:(j.evenements||[]).filter(x=>x.deleted)};
    gotDevis=true;render();
  }catch(err){if(err.code!=="login")showNotice(err.code==="offline"?"Pas de connexion : les derniers changements des autres ne s'affichent pas.":"Le tableau n'a pas pu se mettre à jour. Recharge la page.")}
}
function start(){
  if(started)return;started=true;db=true;
  $("addBtn").disabled=false;
  refresh();
  refreshTimer=setInterval(()=>{if(!document.hidden)refresh()},15000);
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)refresh()});
}
render();
call("/api/login").then(j=>{if(j.ok){unlock();start()}}).catch(()=>{});
