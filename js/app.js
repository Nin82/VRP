// ============================================================================
// Ottimizzatore Ritiri — app.js
// Struttura pensata per essere scomposta in moduli separati man mano che
// si aggiungono nuove feature (es. js/geocoding.js, js/vrptw.js, js/ui.js).
// Per ora è un unico file ES module, organizzato in sezioni commentate.
// ============================================================================

// ---------------------------------------------------------------------------
// CONFIG — caricata da config.json (richiede di essere servita via http,
// non aperta con doppio click: da qui l'aggancio a Codespaces / un server locale)
// ---------------------------------------------------------------------------
let CONFIG = null;
async function loadConfig(){
  try{
    const resp = await fetch('./config.json');
    CONFIG = await resp.json();
  }catch(e){
    console.warn('config.json non caricato (apri il progetto tramite un server http, non con file://). Uso i default hardcoded.', e);
    CONFIG = {
      palette: ["#F2A93B","#3D8B8B","#C75146","#7C9070","#6E7BA8","#B98BC9","#D9B23D"],
      headerSynonyms: {
        cliente: ['cliente','ragione sociale','nome cliente','tenuta','azienda'],
        indirizzo: ['indirizzo','via','indirizzo di ritiro','indirizzo ritiro'],
        cap: ['cap','codice postale','zip','postal code'],
        localita: ['localita','comune','citta','city','location'],
        orario: ['orario ritiro','orario di ritiro','orario','ora ritiro','ora'],
        bancali: ['bancali','pallet','pallets','n. bancali','numero bancali','n bancali'],
        volume: ['m3','mc','metri cubi','volume','mcubi','m³']
      },
      defaults: {
        capacitaBancali:33, volumeBancalePerM3:2.1, tempoSostaMin:20,
        tolleranzaRitardoMin:15, maxGiroOre:9, orarioPartenza:'07:00',
        maxMezzi:1, rientroDeposito:true,
        mapCenter:{lat:44.4938,lng:11.3387}, mapZoom:7
      },
      endpoints: {
        nominatimSearch:'https://nominatim.openstreetmap.org/search',
        osrmTable:'https://router.project-osrm.org/table/v1/driving',
        osrmRoute:'https://router.project-osrm.org/route/v1/driving',
        osmTiles:'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
      },
      geocoding: { requestDelayMs:1100, countryCode:'it', countryName:'Italia' }
    };
  }
}

// ---------------------------------------------------------------------------
// STATO
// ---------------------------------------------------------------------------
let deposito = { via:"", cap:"", citta:"", lat:null, lng:null, geoDisplay:null };
let ritiri = [];       // {id, cliente, indirizzo, cap, localita, orario, orarioEntro, quantita(m3), lat, lng, approssimato, cittaSospetta, cittaTrovata}
let ritiroIdSeq = 1;
let flotta = [];       // {id, orarioPartenza} — un mezzo per riga, ognuno con la propria partenza
let mezzoIdSeq = 1;
const geocodeCache = {};

let map, markersLayer, routesLayer;

// ---------------------------------------------------------------------------
// UTILITY GENERICHE
// ---------------------------------------------------------------------------
function $(id){ return document.getElementById(id); }
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function setStatus(id, msg, isErr){
  const el = $(id);
  el.textContent = msg; el.className = 'status-line' + (isErr?' err':'');
}
function toMinutes(hhmm){
  if(!hhmm) return null;
  const [h,m] = hhmm.split(':').map(Number);
  if(isNaN(h)) return null;
  return h*60+m;
}
function fmtClock(min){
  const h = Math.floor(min/60)%24, m = Math.round(min%60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

// ---------------------------------------------------------------------------
// PERSISTENZA (window.storage, personale — richiede l'ambiente Claude/artifact;
// se non disponibile fallisce silenziosamente e l'app funziona lo stesso)
// ---------------------------------------------------------------------------
async function salva(){
  try{
    localStorage.setItem('ottimizzatore-ritiri:v4', JSON.stringify({ deposito, ritiri, ritiroIdSeq, flotta, mezzoIdSeq }));
  }catch(e){ console.warn('salvataggio locale fallito', e); }
}
async function carica(){
  try{
    const raw = localStorage.getItem('ottimizzatore-ritiri:v4');
    if(raw){
      const d = JSON.parse(raw);
      deposito = d.deposito || deposito;
      ritiri = d.ritiri || [];
      ritiroIdSeq = d.ritiroIdSeq || (ritiri.length+1);
      flotta = d.flotta || [];
      mezzoIdSeq = d.mezzoIdSeq || (flotta.length+1);
    }
  }catch(e){ console.warn('lettura locale fallita', e); }
  if(flotta.length === 0){
    flotta = [{ id: mezzoIdSeq++, orarioPartenza: CONFIG.defaults.primoMezzoOrarioPartenza }];
  }
  $('depositoVia').value = deposito.via || "";
  $('depositoCap').value = deposito.cap || "";
  $('depositoCitta').value = deposito.citta || "";
  if(deposito.lat) setStatus('depositoStatus', `geolocalizzato ✓ — ${deposito.geoDisplay||''}`, false);
  renderRitiri();
  renderMarkersBase();
  renderFlotta();
}

// ---------------------------------------------------------------------------
// MAPPA
// ---------------------------------------------------------------------------
function initMap(){
  map = L.map('map', { zoomControl: true }).setView([CONFIG.defaults.mapCenter.lat, CONFIG.defaults.mapCenter.lng], CONFIG.defaults.mapZoom);
  L.tileLayer(CONFIG.endpoints.osmTiles, { attribution: '&copy; OpenStreetMap contributors', maxZoom: 18 }).addTo(map);
  markersLayer = L.layerGroup().addTo(map);
  routesLayer = L.layerGroup().addTo(map);
}
function renderFlotta(){
  $('flottaCount').textContent = `(${flotta.length})`;
  $('flottaList').innerHTML = flotta.map((m,i) => `
    <div class="item-card-lite" style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border-soft);">
      <input type="text" data-mezzo-nome="${m.id}" value="${escapeHtml(m.nome || '')}" placeholder="Mezzo ${i+1} / autista" style="flex:1;">
      <input type="time" data-mezzo-orario="${m.id}" value="${m.orarioPartenza}" style="width:110px;">
      <button class="btn-danger" data-del-mezzo="${m.id}">×</button>
    </div>
  `).join('');
  $('flottaList').querySelectorAll('[data-mezzo-nome]').forEach(inp=>{
    inp.addEventListener('change', ()=>{
      const m = flotta.find(x=>x.id===parseInt(inp.dataset.mezzoNome));
      if(m){ m.nome = inp.value.trim(); salva(); }
    });
  });
  $('flottaList').querySelectorAll('[data-mezzo-orario]').forEach(inp=>{
    inp.addEventListener('change', ()=>{
      const m = flotta.find(x=>x.id===parseInt(inp.dataset.mezzoOrario));
      if(m){ m.orarioPartenza = inp.value; salva(); }
    });
  });
  $('flottaList').querySelectorAll('[data-del-mezzo]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      if(flotta.length<=1){ alert('Deve restare almeno un mezzo.'); return; }
      flotta = flotta.filter(m=>m.id!==parseInt(btn.dataset.delMezzo));
      renderFlotta(); salva();
    });
  });
}

function renderMarkersBase(){
  markersLayer.clearLayers();
  if(deposito.lat){
    L.circleMarker([deposito.lat, deposito.lng], { radius:7, color:'#E8E6E0', weight:2, fillColor:'#14181C', fillOpacity:1 })
      .bindTooltip('Deposito').addTo(markersLayer);
  }
  ritiri.forEach(r=>{
    if(r.lat){
      L.circleMarker([r.lat, r.lng], { radius:6, color:'#8A9099', weight:1.5, fillColor:'#20272F', fillOpacity:1 })
        .bindTooltip(r.cliente).addTo(markersLayer);
    }
  });
}

// ---------------------------------------------------------------------------
// IMPORT FILE (Excel / CSV) — SheetJS
// ---------------------------------------------------------------------------
function normalizeHeader(h){
  return String(h||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
}
function matchColumn(headers, keys){
  for(let i=0;i<headers.length;i++){
    const h = normalizeHeader(headers[i]);
    if(keys.some(k => h === k || h.includes(k))) return i;
  }
  return -1;
}
function parseItalianNumber(v){
  if(typeof v === 'number') return v;
  let s = String(v||'').trim();
  if(!s) return 0;
  if(s.includes(',') && s.includes('.')) s = s.replace(/\./g,'').replace(',', '.');
  else if(s.includes(',')) s = s.replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}
function normalizeOrario(v){
  if(v === null || v === undefined || v === '') return '';
  if(v instanceof Date){
    const hh = String(v.getUTCHours()).padStart(2,'0');
    const mm = String(v.getUTCMinutes()).padStart(2,'0');
    return `${hh}:${mm}`;
  }
  if(typeof v === 'number'){
    const totalMin = Math.round(v * 24 * 60);
    const hh = String(Math.floor(totalMin/60) % 24).padStart(2,'0');
    const mm = String(totalMin % 60).padStart(2,'0');
    return `${hh}:${mm}`;
  }
  const s = String(v).trim();
  const m = s.match(/(\d{1,2})[:.](\d{2})/);
  if(m) return `${m[1].padStart(2,'0')}:${m[2]}`;
  return s;
}

function processWorkbook(data){
  const wb = XLSX.read(data, { type:'array', cellDates:true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header:1, raw:true, defval:'' });
  if(rows.length < 2){ setStatus('optStatus', 'Il file non contiene righe di dati.', true); return; }
  const headers = rows[0];
  const syn = CONFIG.headerSynonyms;
  const iCliente = matchColumn(headers, syn.cliente);
  const iIndirizzo = matchColumn(headers, syn.indirizzo);
  const iCap = matchColumn(headers, syn.cap);
  const iLocalita = matchColumn(headers, syn.localita);
  const iOrario = matchColumn(headers, syn.orario);
  const iOrarioEntro = matchColumn(headers, syn.orarioEntro);
  const iMetriLineari = matchColumn(headers, syn.metriLineari);
  const iVolume = matchColumn(headers, syn.volume);
  const iBancali = matchColumn(headers, syn.bancali);

  if(iCliente === -1 || iIndirizzo === -1){
    setStatus('optStatus', 'Colonne non riconosciute: servono almeno "Cliente" e "Indirizzo".', true);
    return;
  }

  const volumeBancale = parseFloat($('volumeBancale').value) || CONFIG.defaults.volumeBancalePerM3;

  const nuovi = [];
  for(let r=1;r<rows.length;r++){
    const row = rows[r];
    if(!row || row.every(c => c === '' || c === undefined || c === null)) continue;
    const cliente = String(row[iCliente]||'').trim();
    const indirizzo = String(row[iIndirizzo]||'').trim();
    const cap = iCap !== -1 ? String(row[iCap]||'').trim() : '';
    const localita = iLocalita !== -1 ? String(row[iLocalita]||'').trim() : '';
    if(!cliente || !indirizzo) continue;
    const orario = iOrario !== -1 ? normalizeOrario(row[iOrario]) : '';
       const orarioEntro = iOrarioEntro !== -1 ? normalizeOrario(row[iOrarioEntro]) : '';
    const metriLineari = iMetriLineari !== -1 ? parseItalianNumber(row[iMetriLineari]) : 0;
    let quantita = 0;
    let bancaliStandard = 0;
    if(iVolume !== -1) quantita = parseItalianNumber(row[iVolume]);
    else if(iBancali !== -1){
      bancaliStandard = parseItalianNumber(row[iBancali]);
      quantita = bancaliStandard * volumeBancale;
    }
    nuovi.push({ id: ritiroIdSeq++, cliente, indirizzo, cap, localita, orario, orarioEntro, quantita, metriLineari, bancaliStandard, lat:null, lng:null, approssimato:false });
  }

  if(nuovi.length === 0){ setStatus('optStatus', 'Nessun ritiro valido trovato nel file.', true); return; }

  if(ritiri.length > 0){
    const sostituisci = confirm(`Ci sono già ${ritiri.length} ritiri caricati. Vuoi sostituirli con i ${nuovi.length} del nuovo file?\n(Annulla per accodarli invece)`);
    ritiri = sostituisci ? nuovi : ritiri.concat(nuovi);
  } else {
    ritiri = nuovi;
  }
  setStatus('optStatus', `Caricati ${nuovi.length} ritiri dal file.`, false);
  renderRitiri(); salva();
}

function handleFile(file){
  const reader = new FileReader();
  reader.onload = (e) => {
    try{ processWorkbook(new Uint8Array(e.target.result)); }
    catch(err){ console.error(err); setStatus('optStatus', 'Errore lettura file: ' + err.message, true); }
  };
  reader.readAsArrayBuffer(file);
}

function processFlottaWorkbook(data){
  const wb = XLSX.read(data, { type:'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header:1, raw:true, defval:'' });
  if(rows.length < 2){ setStatus('optStatus', 'Il file flotta non contiene righe di dati.', true); return; }
  const headers = rows[0];
  const syn = CONFIG.headerSynonyms;
  const iNome = matchColumn(headers, syn.nomeMezzo);
  const iOrario = matchColumn(headers, syn.orarioPartenzaMezzo);

  const nuovi = [];
  for(let r=1;r<rows.length;r++){
    const row = rows[r];
    if(!row || row.every(c => c === '' || c === undefined || c === null)) continue;
    const nome = iNome !== -1 ? String(row[iNome]||'').trim() : '';
    const orarioPartenza = iOrario !== -1 ? normalizeOrario(row[iOrario]) : '';
    if(!orarioPartenza) continue;
    nuovi.push({ id: mezzoIdSeq++, nome, orarioPartenza });
  }
  if(nuovi.length === 0){ setStatus('optStatus', 'Nessun mezzo valido trovato nel file (serve almeno l\'orario di partenza).', true); return; }

  if(flotta.length > 0){
    const sostituisci = confirm(`Ci sono già ${flotta.length} mezzi in elenco. Vuoi sostituirli con i ${nuovi.length} del file?\n(Annulla per accodarli invece)`);
    flotta = sostituisci ? nuovi : flotta.concat(nuovi);
  } else {
    flotta = nuovi;
  }
  setStatus('optStatus', `Caricati ${nuovi.length} mezzi dal file.`, false);
  renderFlotta(); salva();
}

function handleFileFlotta(file){
  const reader = new FileReader();
  reader.onload = (e) => {
    try{ processFlottaWorkbook(new Uint8Array(e.target.result)); }
    catch(err){ console.error(err); setStatus('optStatus', 'Errore lettura file flotta: ' + err.message, true); }
  };
  reader.readAsArrayBuffer(file);
}

// ---------------------------------------------------------------------------
// GEOCODING — ricerca strutturata a più livelli + verifica città
// (bug fix: un risultato senza campo città verificabile NON viene più
// accettato automaticamente — si scende a un livello più sicuro)
// ---------------------------------------------------------------------------
function normalizeCity(s){
  return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z\s]/g,'').trim();
}
function levenshtein(a,b){
  const m=a.length, n=b.length;
  const dp = Array.from({length:m+1},()=>new Array(n+1).fill(0));
  for(let i=0;i<=m;i++) dp[i][0]=i;
  for(let j=0;j<=n;j++) dp[0][j]=j;
  for(let i=1;i<=m;i++) for(let j=1;j<=n;j++)
    dp[i][j] = a[i-1]===b[j-1] ? dp[i-1][j-1] : 1+Math.min(dp[i-1][j-1],dp[i-1][j],dp[i][j-1]);
  return dp[m][n];
}
function cityMatches(input, found){
  if(!input || !found) return true;
  const a = normalizeCity(input), b = normalizeCity(found);
  if(!a || !b) return true;
  if(a===b || a.includes(b) || b.includes(a)) return true;
  return levenshtein(a,b) <= 2;
}
function extractCity(hit){
  if(!hit || !hit.address) return null;
  return hit.address.city || hit.address.town || hit.address.village || hit.address.hamlet || hit.address.municipality || hit.address.county || null;
}
// un risultato senza città verificabile è trattato come sospetto, non accettato al volo
function verifiedCity(input, found){
  if(!input) return true;
  if(!found) return false;
  return cityMatches(input, found);
}

async function nominatimStructured(params){
  const qs = new URLSearchParams({ format:'json', limit:'1', addressdetails:'1', countrycodes:CONFIG.geocoding.countryCode, ...params }).toString();
  const resp = await fetch(`${CONFIG.endpoints.nominatimSearch}?${qs}`, { headers:{ 'Accept':'application/json' } });
  if(!resp.ok) return null;
  const data = await resp.json();
  return data.length ? data[0] : null;
}
async function nominatimFreeform(q){
  const qs = new URLSearchParams({ format:'json', limit:'1', addressdetails:'1', countrycodes:CONFIG.geocoding.countryCode, q }).toString();
  const resp = await fetch(`${CONFIG.endpoints.nominatimSearch}?${qs}`);
  if(!resp.ok) return null;
  const data = await resp.json();
  return data.length ? data[0] : null;
}

async function geocodeMultilivello({ via, cap, citta }){
  const key = `${via}|${cap}|${citta}`.toLowerCase().trim();
  if(geocodeCache[key]) return geocodeCache[key];
  const delay = CONFIG.geocoding.requestDelayMs;
  const country = CONFIG.geocoding.countryName;

  let hit = null, precisione = 'esatto', scartatoPerCittaSbagliata = false;

  if(via){
    const h = await nominatimStructured({ street: via, postalcode: cap||'', city: citta||'', country });
    if(h && verifiedCity(citta, extractCity(h))) hit = h;
    else if(h) scartatoPerCittaSbagliata = true;
  }
  if(!hit && via){
    await sleep(delay);
    const h = await nominatimFreeform(`${via}, ${cap||''} ${citta||''}, ${country}`);
    if(h && verifiedCity(citta, extractCity(h))) hit = h;
    else if(h) scartatoPerCittaSbagliata = true;
  }
  if(!hit && cap){
    await sleep(delay);
    hit = await nominatimStructured({ postalcode: cap, country });
    if(hit) precisione = 'approssimato';
  }
  if(!hit && citta){
    await sleep(delay);
    hit = await nominatimFreeform(`${citta}, ${country}`);
    if(hit) precisione = 'approssimato';
  }

  if(!hit){
    const msg = scartatoPerCittaSbagliata
      ? `trovato solo un indirizzo omonimo in un'altra città per: ${via||''} (${citta||''})`
      : `indirizzo non trovato: ${via||''} ${cap||''} ${citta||''}`.trim();
    throw new Error(msg);
  }
  const res = {
    lat: parseFloat(hit.lat), lng: parseFloat(hit.lon), precisione,
    displayName: hit.display_name, cittaTrovata: extractCity(hit),
    cittaSospetta: citta ? !cityMatches(citta, extractCity(hit)) : false
  };
  geocodeCache[key] = res;
  return res;
}

// ---------------------------------------------------------------------------
// VRPTW — costruzione a inserimento più economico con vincoli di
// capacità e finestra oraria; minimizza i mezzi usati sul totale disponibile
// ---------------------------------------------------------------------------
// metri lineari "effettivi" di un ritiro: se l'utente ne ha dichiarati esplicitamente (eccezione,
// es. bancali pesanti/bassi non impilabili), si usano quelli; altrimenti si stima dal volume
// assumendo la densità media di un carico normale a pieno regime (capacitaM3/capacitaLineare).
function effectiveML(r, capacitaM3PerMezzo, capacitaLineareM, metriLineariPerBancale){
  if(r.metriLineari && r.metriLineari > 0) return r.metriLineari;                    // eccezione dichiarata (fuori misura)
  if(r.bancaliStandard && r.bancaliStandard > 0) return r.bancaliStandard * metriLineariPerBancale; // bancali standard noti
  const densita = capacitaM3PerMezzo / capacitaLineareM;                             // fallback: solo m3 dichiarati (es. da colonna "Metri cubi")
  return (r.quantita||0) / densita;
}

function checkFeasibleAndCost(routeStops, durMin, ritiriArr, tempoSostaMin, partenzaMin, tolleranzaMin){
  let cursor = partenzaMin, prev = 0, totalTravel = 0;
  for(const idx of routeStops){
    const travel = durMin[prev][idx];
    cursor += travel; totalTravel += travel;
    const r = ritiriArr[idx-1];
    const readyMin = toMinutes(r.orario);        // pronto dalle (nessun problema arrivare dopo)
    const deadlineMin = toMinutes(r.orarioEntro); // entro le / chiusura cliente
    if(readyMin !== null && cursor < readyMin) cursor = readyMin; // si aspetta che sia pronta
    if(deadlineMin !== null && cursor > deadlineMin + tolleranzaMin) return { feasible:false };
    cursor += tempoSostaMin;
    prev = idx;
  }
  return { feasible:true, addedCost: totalTravel };
}

function buildRoutesVRPTW(ritiriArr, durMin, capacitaM3PerMezzo, capacitaLineareM, metriLineariPerBancale, flotta, tempoSostaMin, tolleranzaMin){
  const partenzeMin = flotta.map(f => toMinutes(f.orarioPartenza));
  const partenzaMinima = Math.min(...partenzeMin);

  const irraggiungibili = [];
  let unrouted = ritiriArr.map((r,i)=>i+1).filter(idx=>{
    const chk = checkFeasibleAndCost([idx], durMin, ritiriArr, tempoSostaMin, partenzaMinima, tolleranzaMin);
    if(!chk.feasible){ irraggiungibili.push(ritiriArr[idx-1]); return false; }
    return true;
  });

  const routes = [];
  for(let vi=0; vi<flotta.length; vi++){
    const partenzaMin = partenzeMin[vi];
    let route = { stops:[], carico:0, metriLineari:0, partenzaMin };

    const fattibiliPerQuestoMezzo = unrouted.filter(idx=>
      checkFeasibleAndCost([idx], durMin, ritiriArr, tempoSostaMin, partenzaMin, tolleranzaMin).feasible
    );
    if(fattibiliPerQuestoMezzo.length > 0){
      const conOrario = fattibiliPerQuestoMezzo.filter(i => toMinutes(ritiriArr[i-1].orario) !== null);
      const seed = conOrario.length > 0
        ? conOrario.reduce((b,i)=> toMinutes(ritiriArr[i-1].orario) < toMinutes(ritiriArr[b-1].orario) ? i : b, conOrario[0])
        : fattibiliPerQuestoMezzo.reduce((b,i)=> durMin[0][i]>durMin[0][b]?i:b, fattibiliPerQuestoMezzo[0]);
      route.stops.push(seed);
      route.carico += ritiriArr[seed-1].quantita||0;
      route.metriLineari += effectiveML(ritiriArr[seed-1], capacitaM3PerMezzo, capacitaLineareM, metriLineariPerBancale);
      unrouted = unrouted.filter(i=>i!==seed);
    }
    let improved = true;
    while(improved){
      improved = false;
      let bestC=null, bestPos=null, bestCost=Infinity;
      for(const cand of unrouted){
        const qty = ritiriArr[cand-1].quantita||0;
        const ml = effectiveML(ritiriArr[cand-1], capacitaM3PerMezzo, capacitaLineareM, metriLineariPerBancale);
        if(route.carico+qty > capacitaM3PerMezzo) continue;
        if(route.metriLineari+ml > capacitaLineareM) continue;
        for(let pos=0; pos<=route.stops.length; pos++){
          const trial = [...route.stops.slice(0,pos), cand, ...route.stops.slice(pos)];
          const chk = checkFeasibleAndCost(trial, durMin, ritiriArr, tempoSostaMin, partenzaMin, tolleranzaMin);
          if(chk.feasible && chk.addedCost < bestCost){ bestCost=chk.addedCost; bestC=cand; bestPos=pos; }
        }
      }
      if(bestC!==null){
        route.stops.splice(bestPos,0,bestC);
        route.carico += ritiriArr[bestC-1].quantita||0;
        route.metriLineari += effectiveML(ritiriArr[bestC-1], capacitaM3PerMezzo, capacitaLineareM, metriLineariPerBancale);
        unrouted = unrouted.filter(i=>i!==bestC);
        improved = true;
      }
    }
    routes.push(route);
  }
  return { routes, nonAssegnati: unrouted.map(i=>ritiriArr[i-1]), irraggiungibili };
}

// raffina l'ordine di un giro già costruito (riduce i km) SENZA violare
// le finestre orarie: uno scambio 2-opt viene accettato solo se resta fattibile
function constrainedTwoOpt(stops, durMin, ritiriArr, tempoSostaMin, partenzaMin, tolleranzaMin){
  let best = stops.slice();
  let bestChk = checkFeasibleAndCost(best, durMin, ritiriArr, tempoSostaMin, partenzaMin, tolleranzaMin);
  let bestCost = bestChk.addedCost;
  let improved = true;
  while(improved){
    improved = false;
    for(let i=0;i<best.length-1;i++){
      for(let j=i+1;j<best.length;j++){
        const cand = best.slice(0,i).concat(best.slice(i,j+1).reverse(), best.slice(j+1));
        const chk = checkFeasibleAndCost(cand, durMin, ritiriArr, tempoSostaMin, partenzaMin, tolleranzaMin);
        if(chk.feasible && chk.addedCost < bestCost - 1e-6){
          best = cand; bestCost = chk.addedCost; improved = true;
        }
      }
    }
  }
  return best;
}

function routeLength(order, matrix){
  let t=0; for(let i=0;i<order.length-1;i++) t += matrix[order[i]][order[i+1]]; return t;
}

// ---------------------------------------------------------------------------
// OSRM
// ---------------------------------------------------------------------------
async function osrmTable(coords){
  const coordStr = coords.map(c => `${c[1]},${c[0]}`).join(';');
  const resp = await fetch(`${CONFIG.endpoints.osrmTable}/${coordStr}?annotations=duration,distance`);
  if(!resp.ok) throw new Error('OSRM table fallito');
  const data = await resp.json();
  if(data.code !== 'Ok') throw new Error('OSRM: ' + data.code);
  return data;
}
async function osrmRoute(coords){
  const coordStr = coords.map(c => `${c[1]},${c[0]}`).join(';');
  const resp = await fetch(`${CONFIG.endpoints.osrmRoute}/${coordStr}?overview=full&geometries=geojson`);
  if(!resp.ok) throw new Error('OSRM route fallito');
  const data = await resp.json();
  if(data.code !== 'Ok') throw new Error('OSRM: ' + data.code);
  return data.routes[0];
}

// ---------------------------------------------------------------------------
// RENDERING — liste, righe ritiro, risultati
// ---------------------------------------------------------------------------
function renderRitiri(){
  $('ritiriCount').textContent = `(${ritiri.length})`;
  const scrollBox = $('ritiriScroll');
  const summary = $('fileSummary');
  if(ritiri.length === 0){
    scrollBox.style.display = 'none'; summary.style.display = 'none';
    return;
  }
  summary.style.display = 'flex';
  const totQty = ritiri.reduce((s,r)=>s+r.quantita,0);
  $('fileSummaryText').textContent = `${ritiri.length} ritiri · ${totQty.toFixed(1)} m³ totali`;
  scrollBox.style.display = 'block';
  scrollBox.innerHTML = ritiri.map(r => `
    <div class="ritiro-row">
      <div class="rtop">
        <span class="${r.cittaSospetta ? 'geo-sospetta' : (r.lat ? (r.approssimato ? 'geo-approx' : 'geo-ok') : 'geo-pending')}"
              title="${r.cittaSospetta ? 'città trovata diversa da quella dichiarata: '+(r.cittaTrovata||'?') : (r.approssimato?'geolocalizzato in modo approssimato':'')}">●</span>
        <input type="text" data-rid="${r.id}" data-rfield="cliente" value="${escapeHtml(r.cliente)}" placeholder="Cliente">
        <button class="btn-danger" data-del="${r.id}">×</button>
      </div>
      <div class="rrow">
        <input type="text" data-rid="${r.id}" data-rfield="indirizzo" value="${escapeHtml(r.indirizzo)}" placeholder="Indirizzo">
        <input type="text" class="rcap" data-rid="${r.id}" data-rfield="cap" value="${escapeHtml(r.cap||'')}" placeholder="CAP">
      </div>
      <div class="rrow">
        <input type="text" data-rid="${r.id}" data-rfield="localita" value="${escapeHtml(r.localita||'')}" placeholder="Località">
        <input type="time" class="rtime" data-rid="${r.id}" data-rfield="orario" value="${r.orario||''}" title="Pronto dalle">
        <input type="time" class="rtime" data-rid="${r.id}" data-rfield="orarioEntro" value="${r.orarioEntro||''}" title="Entro le">
      </div>
      <div class="rrow">
        <input type="number" step="0.1" class="rqty" data-rid="${r.id}" data-rfield="quantita" value="${r.quantita}">
        <input type="number" step="0.1" class="rqty" data-rid="${r.id}" data-rfield="metriLineari" value="${r.metriLineari||0}" title="Metri lineari (0 = non si applica)">
        <span class="rmeta" style="align-self:center;">m³ / ml · dalle ${r.orario||'—'} entro ${r.orarioEntro||'—'}</span>
      </div>
    </div>
  `).join('');
  scrollBox.querySelectorAll('[data-del]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      ritiri = ritiri.filter(r => r.id !== parseInt(btn.dataset.del));
      renderRitiri(); renderMarkersBase(); salva();
    });
  });
  scrollBox.querySelectorAll('[data-rfield]').forEach(inp=>{
    inp.addEventListener('change', ()=>{
      const r = ritiri.find(x=>x.id===parseInt(inp.dataset.rid));
      if(!r) return;
      const field = inp.dataset.rfield;
      if(field === 'quantita' || field === 'metriLineari'){
        const v = parseFloat(inp.value);
        r[field] = isNaN(v) ? 0 : v;
      } else {
        const val = inp.value.trim();
        const cambiaIndirizzo = ['indirizzo','cap','localita'].includes(field) && val !== (r[field]||'');
        r[field] = val;
        if(cambiaIndirizzo){
          // l'indirizzo non è più quello geolocalizzato: va ricalcolato alla prossima ottimizzazione
          r.lat = null; r.lng = null; r.approssimato = false; r.cittaSospetta = false; r.cittaTrovata = null;
        }
      }
      salva();
      // aggiorna solo la riga toccata sulla mappa/riepilogo, senza ridisegnare tutta la lista
      // (ridisegnarla perderebbe il focus mentre si sta ancora scrivendo)
      $('fileSummaryText').textContent = `${ritiri.length} ritiri · ${ritiri.reduce((s,x)=>s+x.quantita,0).toFixed(1)} m³ totali`;
    });
  });
}

function renderFleetLegend(risultati, nonAssegnatiTutti){
  const el = $('fleetLegend');
  if(risultati.length===0 && nonAssegnatiTutti.length===0){
    el.innerHTML = `<div class="legend-empty">Lancia un'ottimizzazione per vedere qui l'abbinamento clienti-mezzo.</div>`;
    return;
  }
  let html = risultati.map(r => `
    <div class="legend-block">
      <div class="legend-head">
        <span class="swatch" style="background:${r.colore}"></span>
        <span class="lname">${escapeHtml(r.nome)}</span>
        <span class="lmeta">${r.stops.length} clienti · ${r.km.toFixed(0)} km</span>
      </div>
      <div class="legend-chips">
        ${r.stops.map(s => `<span class="legend-chip"><span class="dot" style="background:${r.colore}"></span>${escapeHtml(s.ritiro.cliente)}</span>`).join('')}
      </div>
    </div>
  `).join('');

  if(nonAssegnatiTutti.length){
    html += `
      <div class="legend-block">
        <div class="legend-head">
          <span class="swatch" style="background:var(--danger)"></span>
          <span class="lname" style="color:var(--danger);">Non assegnati</span>
          <span class="lmeta">${nonAssegnatiTutti.length}</span>
        </div>
        <div class="legend-chips">
          ${nonAssegnatiTutti.map(r => `<span class="legend-chip unassigned">${escapeHtml(r.cliente)}</span>`).join('')}
        </div>
      </div>
    `;
  }
  el.innerHTML = html;
}

function renderResults(risultati, nonGeolocalizzati, nonAssegnati, daVerificare, capacitaM3PerMezzo, capacitaLineareM){
  const panel = $('resultsPanel');
  const inner = $('resultsInner');
  if(risultati.length===0 && nonGeolocalizzati.length===0 && nonAssegnati.length===0 && daVerificare.length===0){
    panel.classList.remove('show'); return;
  }
  panel.classList.add('show');

  let html = risultati.map(r => {
    const pct = Math.min(100, Math.round((r.carico / capacitaM3PerMezzo) * 100));
    const avvisi = [];
    if(r.overLimit) avvisi.push(`⚠ giro di ${(r.minuti/60).toFixed(1)}h, oltre il limite impostato`);
    if(r.numLate) avvisi.push(`⚠ ${r.numLate} tappa/e fuori orario`);
    return `
    <div class="vresult" data-vehicle-id="${r.flottaId}" style="${r.overLimit ? 'border-color:var(--danger)':''}">
      <div class="vhead" draggable="true" data-drag-driver="${r.flottaId}" title="Trascina per scambiare il driver con un altro giro">
        <span class="swatch" style="background:${r.colore}"></span>
        <span class="vname">⋮⋮ ${escapeHtml(r.nome)}</span>
      </div>
      <div class="stats">
        <span><b>${r.carico.toFixed(1)}</b> m³ · saturazione <b>${pct}%</b></span>
        ${r.metriLineari>0 ? `<span><b>${r.metriLineari.toFixed(1)}</b> ml / ${capacitaLineareM.toFixed(1)}</span>` : ''}
        <span><b>${r.km.toFixed(0)}</b> km</span>
        <span><b>${Math.round(r.minuti)}</b> min</span>
        <span><b>${r.stops.length}</b> tappe</span>
      </div>
      ${avvisi.length ? `<div style="color:var(--danger);font-size:11px;margin-bottom:8px;">${avvisi.join('<br>')}</div>` : ''}
      <ul class="stoplist">
        ${r.stops.map((s,i)=>`
          <li style="flex-wrap:wrap;">
            <span class="idx">${i+1}</span>
            <span class="stime ${s.late?'late':''}" title="Orario stimato di arrivo del mezzo">
              <span class="slabel">arrivo</span> ${s.arrivo}
            </span>
            <span class="sname" title="${escapeHtml(s.ritiro.indirizzo)}${s.ritiro.approssimato?' (geoloc. approssimata)':''}">${escapeHtml(s.ritiro.cliente)}${s.ritiro.approssimato?' ~':''}</span>
            <span class="sqty">${s.ritiro.quantita.toFixed(1)}m³</span>
            <span class="sreq-full">
              ${s.waited ? `<span class="wait-badge" title="Il mezzo è arrivato prima che la merce fosse pronta e ha aspettato">⏳ in attesa</span>` : ''}
              ${(s.ritiro.orario || s.ritiro.orarioEntro) ? `<span class="slabel">finestra cliente</span> ${s.ritiro.orario ? 'dalle '+s.ritiro.orario : 'sempre pronta'}${s.ritiro.orarioEntro ? ' — entro le '+s.ritiro.orarioEntro : ' — nessuna chiusura indicata'}` : `<span class="slabel">finestra cliente</span> nessuna indicata`}
            </span>
          </li>
          <div class="stop-edit">
            <input type="text" class="edit-indirizzo" data-edit-id="${s.ritiro.id}" data-edit-field="indirizzo" value="${escapeHtml(s.ritiro.indirizzo)}" placeholder="Indirizzo">
            <input type="text" class="edit-cap" data-edit-id="${s.ritiro.id}" data-edit-field="cap" value="${escapeHtml(s.ritiro.cap||'')}" placeholder="CAP">
            <input type="text" class="edit-localita" data-edit-id="${s.ritiro.id}" data-edit-field="localita" value="${escapeHtml(s.ritiro.localita||'')}" placeholder="Località">
            <input type="number" step="0.1" class="edit-qty" data-edit-id="${s.ritiro.id}" data-edit-field="quantita" value="${s.ritiro.quantita}">
            <span class="edit-unit">m³</span>
            <input type="number" step="0.1" class="edit-qty" data-edit-id="${s.ritiro.id}" data-edit-field="metriLineari" value="${s.ritiro.metriLineari||0}" title="0 = calcolo automatico">
            <span class="edit-unit">ml (0=auto)</span>
          </div>
        `).join('')}
      </ul>
      <div class="modal-recalc-wrap">
        <button class="btn-primary" style="width:100%;" data-recalc-card>↻ Salva modifiche e ricalcola</button>
      </div>
    </div>
  `;}).join('');

  if(daVerificare.length){
    html += `
      <div class="vresult" style="border-color:var(--danger)">
        <div class="vhead"><span class="vname" style="color:var(--danger)">DA VERIFICARE — CITTÀ SOSPETTA (${daVerificare.length})</span></div>
        <ul class="stoplist">
          ${daVerificare.map(r=>`<li><span class="sname">${escapeHtml(r.cliente)}: atteso "${escapeHtml(r.localita)}", trovato "${escapeHtml(r.cittaTrovata||'?')}"</span></li>`).join('')}
        </ul>
      </div>
    `;
  }
  if(nonAssegnati.length){
    html += `
      <div class="vresult" data-vehicle-id="auto" style="border-color:var(--danger)">
        <div class="vhead"><span class="vname" style="color:var(--danger)">NON ASSEGNABILI (${nonAssegnati.length})</span></div>
        <ul class="stoplist">
          ${nonAssegnati.map(r=>`<li><span class="sname">${escapeHtml(r.cliente)} — ${r.irraggiungibile ? `orario ${r.orario} irraggiungibile da solo dal deposito` : `${r.quantita.toFixed(1)} m³, orario ${r.orario||'—'}, nessun mezzo compatibile`}</span></li>`).join('')}
        </ul>
      </div>
    `;
  }
  if(nonGeolocalizzati.length){
    html += `
      <div class="vresult" style="border-color:var(--danger)">
        <div class="vhead"><span class="vname" style="color:var(--danger)">NON GEOLOCALIZZATI (${nonGeolocalizzati.length})</span></div>
        <ul class="stoplist">
          ${nonGeolocalizzati.map(r=>`<li><span class="sname">${escapeHtml(r.cliente)} — ${escapeHtml(r.indirizzo)} ${escapeHtml(r.cap||'')} ${escapeHtml(r.localita||'')}</span></li>`).join('')}
        </ul>
      </div>
    `;
  }
  inner.innerHTML = html;
}

// ---------------------------------------------------------------------------
// OTTIMIZZAZIONE END-TO-END
// ---------------------------------------------------------------------------
async function eseguiOttimizzazione(){
  const btn = $('optimizeBtn');
  try{

    if(ritiri.length === 0){ setStatus('optStatus', 'Carica o aggiungi almeno un ritiro.', true); return; }
    deposito.via = $('depositoVia').value.trim();
    deposito.cap = $('depositoCap').value.trim();
    deposito.citta = $('depositoCitta').value.trim();
    if(!deposito.cap && !deposito.citta){ setStatus('optStatus', 'Inserisci almeno CAP o città del deposito.', true); return; }

    btn.disabled = true;

    if(!deposito.lat){
      setStatus('optStatus', 'Geolocalizzazione deposito...', false);
      const g = await geocodeMultilivello({ via: deposito.via, cap: deposito.cap, citta: deposito.citta });
      deposito.lat=g.lat; deposito.lng=g.lng; deposito.geoDisplay=g.displayName;
      const avviso = g.cittaSospetta ? ` ⚠ città trovata diversa da quella inserita: "${g.cittaTrovata}"` : '';
      setStatus('depositoStatus', `geolocalizzato${g.precisione==='approssimato'?' (approssimato)':' ✓'} — ${g.displayName}${avviso}`, g.precisione==='approssimato' || g.cittaSospetta);
      await sleep(CONFIG.geocoding.requestDelayMs);
    }

    const daGeocodificare = ritiri.filter(r => !r.lat);
    let done = 0;
    for(const r of daGeocodificare){
      setStatus('optStatus', `Geolocalizzazione ${++done}/${daGeocodificare.length}: ${r.cliente}...`, false);
      try{
        const g = await geocodeMultilivello({ via: r.indirizzo, cap: r.cap, citta: r.localita });
        r.lat=g.lat; r.lng=g.lng; r.approssimato = g.precisione === 'approssimato';
        r.geoDisplay = g.displayName; r.cittaTrovata = g.cittaTrovata; r.cittaSospetta = g.cittaSospetta;
      }catch(e){
        console.warn('geocoding fallito per', r.indirizzo, r.cap, r.localita);
      }
      renderRitiri();
      await sleep(CONFIG.geocoding.requestDelayMs);
    }
    salva();
    renderMarkersBase();

    const ritiriValidi = ritiri.filter(r => r.lat);
    const nonGeolocalizzati = ritiri.filter(r => !r.lat);
    const daVerificare = ritiriValidi.filter(r => r.cittaSospetta);
    if(ritiriValidi.length === 0){ setStatus('optStatus', 'Nessun indirizzo geolocalizzabile.', true); btn.disabled=false; return; }

    setStatus('optStatus', 'Calcolo matrice distanze (OSRM)...', false);
    const coords = [[deposito.lat, deposito.lng], ...ritiriValidi.map(r=>[r.lat,r.lng])];
    const table = await osrmTable(coords);
    const fullDur = table.durations, fullDist = table.distances; // secondi, metri
    const durMin = fullDur.map(row => row.map(v => v/60));

    setStatus('optStatus', 'Costruzione dei giri (capacità + orari)...', false);
    const capacitaM3PerMezzo = parseFloat($('capacitaUtileM3').value) || CONFIG.defaults.capacitaUtileM3;
    const capacitaLineareM = parseFloat($('capacitaLineareM').value) || CONFIG.defaults.capacitaLineareM;
    const metriLineariPerBancale = parseFloat($('metriLineariPerBancale').value) || CONFIG.defaults.metriLineariPerBancale;
    const tempoSostaMin = parseFloat($('tempoSosta').value) || CONFIG.defaults.tempoSostaMin;
    const tolleranzaMin = parseFloat($('tolleranzaRitardo').value) || CONFIG.defaults.tolleranzaRitardoMin;
    const maxGiroMin = (parseFloat($('maxGiroOre').value) || CONFIG.defaults.maxGiroOre) * 60;
    const rientro = $('rientroDeposito').checked;

    const { routes, nonAssegnati, irraggiungibili } = buildRoutesVRPTW(ritiriValidi, durMin, capacitaM3PerMezzo, capacitaLineareM, metriLineariPerBancale, flotta, tempoSostaMin, tolleranzaMin);

    const risultati = [];
    routesLayer.clearLayers();
    markersLayer.clearLayers();
    renderMarkersBase();

    for(let vi=0; vi<routes.length; vi++){
      const route = routes[vi];
      if(route.stops.length === 0) continue;
      const nomeMezzo = (flotta[vi] && flotta[vi].nome) ? flotta[vi].nome : `Mezzo ${vi+1}`;
      setStatus('optStatus', `Ottimizzo percorso: ${nomeMezzo}...`, false);

      const refinedStops = constrainedTwoOpt(route.stops, durMin, ritiriValidi, tempoSostaMin, route.partenzaMin, tolleranzaMin);
      let order = [0, ...refinedStops];
      if(rientro) order = [...order, 0];

      const routeCoords = order.map(gi => gi===0 ? [deposito.lat, deposito.lng] : [ritiriValidi[gi-1].lat, ritiriValidi[gi-1].lng]);
      let geomData = null;
      try{ geomData = await osrmRoute(routeCoords); }catch(e){}

      let cursorMin = route.partenzaMin;
      const stopsWithTime = [];
      for(let k=1;k<order.length;k++){
        const gi = order[k];
        if(gi === 0) break;
        cursorMin += durMin[order[k-1]][gi];
        const ritiroObj = ritiriValidi[gi-1];
        const readyMin = toMinutes(ritiroObj.orario);
        const deadlineMin = toMinutes(ritiroObj.orarioEntro);
        let waited = false;
        if(readyMin !== null && cursorMin < readyMin){ cursorMin = readyMin; waited = true; }
        const arrivo = fmtClock(cursorMin);
        let late = false;
        if(deadlineMin !== null && cursorMin > deadlineMin + tolleranzaMin) late = true;
        stopsWithTime.push({ ritiro: ritiroObj, arrivo, late, waited });
        cursorMin += tempoSostaMin;
      }

      const totalDistM = geomData ? geomData.distance : routeLength(order, fullDist);
      const totalDurSec = geomData ? geomData.duration : routeLength(order, fullDur);
      const minutiTotali = totalDurSec/60 + (stopsWithTime.length*tempoSostaMin);

      risultati.push({
        nome: nomeMezzo, flottaId: flotta[vi].id, colore: CONFIG.palette[vi % CONFIG.palette.length],
        stops: stopsWithTime, carico: route.carico, metriLineari: route.metriLineari,
        km: totalDistM/1000, minuti: minutiTotali,
        overLimit: minutiTotali > maxGiroMin,
        numLate: stopsWithTime.filter(s=>s.late).length
      });

      if(geomData) L.geoJSON(geomData.geometry, { style:{ color: CONFIG.palette[vi % CONFIG.palette.length], weight:4, opacity:0.85 } }).addTo(routesLayer);
      stopsWithTime.forEach((sw, idx)=>{
        L.circleMarker([sw.ritiro.lat, sw.ritiro.lng], {
          radius:8, color: sw.late ? '#C75146' : '#14181C', weight: sw.late?2.5:1.5,
          fillColor: CONFIG.palette[vi % CONFIG.palette.length], fillOpacity:1
        }).bindTooltip(`${idx+1}. ${sw.ritiro.cliente} — arrivo ${sw.arrivo}${sw.late?' ⚠ in ritardo':''}`).addTo(markersLayer);
      });
    }

    if(deposito.lat){
      L.circleMarker([deposito.lat, deposito.lng], { radius:8, color:'#E8E6E0', weight:2, fillColor:'#14181C', fillOpacity:1 })
        .bindTooltip('Deposito').addTo(markersLayer);
    }

    const tuttiNonAssegnati = [...nonGeolocalizzati, ...nonAssegnati, ...irraggiungibili];
    renderResults(risultati, nonGeolocalizzati, [...nonAssegnati, ...irraggiungibili.map(r=>({...r, irraggiungibile:true}))], daVerificare, capacitaM3PerMezzo, capacitaLineareM);
    renderFleetLegend(risultati, tuttiNonAssegnati);

    if(risultati.length){
      const allCoords = risultati.flatMap(r => r.stops.map(s=>[s.ritiro.lat, s.ritiro.lng]));
      allCoords.push([deposito.lat, deposito.lng]);
      map.fitBounds(allCoords, { padding:[40,40] });
    }

    const problemi = [];
    if(daVerificare.length) problemi.push(`${daVerificare.length} indirizzo/i con città sospetta`);
    if(nonGeolocalizzati.length) problemi.push(`${nonGeolocalizzati.length} non geolocalizzabile/i`);
    if(nonAssegnati.length) problemi.push(`${nonAssegnati.length} non assegnabile/i (capacità o orari incompatibili)`);
    if(irraggiungibili.length) problemi.push(`${irraggiungibili.length} irraggiungibile/i entro l'orario richiesto già da solo dal deposito`);
    const troppiLunghi = risultati.filter(r=>r.overLimit).length;
    if(troppiLunghi) problemi.push(`${troppiLunghi} mezzo/i oltre il limite orario`);
    const riepilogo = `Usati ${risultati.length} mezzi su ${flotta.length} disponibili.`;
    setStatus('optStatus', problemi.length ? `${riepilogo} Avvisi: ${problemi.join('; ')}.` : `${riepilogo} Ottimizzazione completata.`, problemi.length>0);

  }catch(err){
    console.error(err);
    setStatus('optStatus', 'Errore: ' + err.message, true);
  }finally{
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// EVENTI UI — collegati dopo il caricamento della config
// ---------------------------------------------------------------------------
function closeModal(){
  document.querySelectorAll('.modal-overlay, .modal-close').forEach(el => el.remove());
}
function openCardModal(cardEl){
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const clone = cardEl.cloneNode(true);
  clone.classList.add('modal-card');
  overlay.appendChild(clone);
  overlay.addEventListener('click', (e)=>{ if(e.target===overlay) closeModal(); });
  document.body.appendChild(overlay);
  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-close';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', closeModal);
  document.body.appendChild(closeBtn);
  overlay.dataset.hasCloseBtn = 'true';
}
document.addEventListener('keydown', (e)=>{ if(e.key==='Escape') closeModal(); });

// legge i campi modificati dentro una scheda (nel modale) e li riporta nello stato:
// se indirizzo/CAP/Località cambiano, quel ritiro va ri-geolocalizzato da capo.
function applyCardEdits(cardEl){
  const touched = new Set();
  cardEl.querySelectorAll('[data-edit-id]').forEach(inp=>{
    const id = parseInt(inp.dataset.editId);
    const field = inp.dataset.editField;
    const r = ritiri.find(x=>x.id===id);
    if(!r) return;
    if(field === 'quantita' || field === 'metriLineari'){
      const v = parseFloat(inp.value);
      if(!isNaN(v)) r[field] = v;
      return;
    }
    const val = inp.value.trim();
    if(val !== (r[field]||'')){
      r[field] = val;
      touched.add(id);
    }
  });
  touched.forEach(id=>{
    const r = ritiri.find(x=>x.id===id);
    if(r){ r.lat=null; r.lng=null; r.approssimato=false; r.cittaSospetta=false; r.cittaTrovata=null; }
  });
  renderRitiri();
  salva();
}

function wireUpUI(){
  // deposito
  ['depositoVia','depositoCap','depositoCitta'].forEach(id=>{
    $(id).addEventListener('change', ()=>{
      deposito.via = $('depositoVia').value.trim();
      deposito.cap = $('depositoCap').value.trim();
      deposito.citta = $('depositoCitta').value.trim();
      deposito.lat = null; deposito.lng = null;
      setStatus('depositoStatus', "da geolocalizzare all'ottimizzazione", false);
      salva();
    });
  });

  // import file
  const dropzone = $('dropzone');
  const fileInput = $('fileInput');
  dropzone.addEventListener('click', ()=> fileInput.click());
  fileInput.addEventListener('change', (e)=>{ if(e.target.files[0]) handleFile(e.target.files[0]); fileInput.value=''; });
  ['dragover','dragenter'].forEach(evt => dropzone.addEventListener(evt, (e)=>{ e.preventDefault(); dropzone.classList.add('drag'); }));
  ['dragleave','drop'].forEach(evt => dropzone.addEventListener(evt, (e)=>{ e.preventDefault(); dropzone.classList.remove('drag'); }));
  dropzone.addEventListener('drop', (e)=>{ const file = e.dataTransfer.files[0]; if(file) handleFile(file); });

  const dropzoneFlotta = $('dropzoneFlotta');
  const fileInputFlotta = $('fileInputFlotta');
  dropzoneFlotta.addEventListener('click', ()=> fileInputFlotta.click());
  fileInputFlotta.addEventListener('change', (e)=>{ if(e.target.files[0]) handleFileFlotta(e.target.files[0]); fileInputFlotta.value=''; });
  ['dragover','dragenter'].forEach(evt => dropzoneFlotta.addEventListener(evt, (e)=>{ e.preventDefault(); dropzoneFlotta.classList.add('drag'); }));
  ['dragleave','drop'].forEach(evt => dropzoneFlotta.addEventListener(evt, (e)=>{ e.preventDefault(); dropzoneFlotta.classList.remove('drag'); }));
  dropzoneFlotta.addEventListener('drop', (e)=>{ const file = e.dataTransfer.files[0]; if(file) handleFileFlotta(file); });

  $('clearRitiriBtn').addEventListener('click', ()=>{
    if(confirm('Svuotare tutti i ritiri caricati?')){ ritiri = []; renderRitiri(); renderMarkersBase(); salva(); }
  });

  // form manuale
  $('manualToggle').addEventListener('click', ()=> $('manualForm').classList.toggle('show'));
  $('addManualBtn').addEventListener('click', ()=>{
    const cliente = $('mCliente').value.trim();
    const indirizzo = $('mIndirizzo').value.trim();
    const cap = $('mCap').value.trim();
    const localita = $('mLocalita').value.trim();
    const orario = $('mOrario').value;
    const orarioEntro = $('mOrarioEntro').value;
    const quantita = parseFloat($('mQuantita').value) || 0;
    const metriLineari = parseFloat($('mMetriLineari').value) || 0;
    if(!cliente || !indirizzo){ alert('Compila almeno cliente e indirizzo.'); return; }
    ritiri.push({ id: ritiroIdSeq++, cliente, indirizzo, cap, localita, orario, orarioEntro, quantita, metriLineari, lat:null, lng:null, approssimato:false });
    ['mCliente','mIndirizzo','mCap','mLocalita','mOrario','mOrarioEntro','mQuantita','mMetriLineari'].forEach(id => $(id).value = '');
    renderRitiri(); salva();
  });

  $('addMezzoBtn').addEventListener('click', ()=>{
    const ultimo = flotta[flotta.length-1];
    flotta.push({ id: mezzoIdSeq++, orarioPartenza: ultimo ? ultimo.orarioPartenza : CONFIG.defaults.primoMezzoOrarioPartenza });
    renderFlotta(); salva();
  });

  $('optimizeBtn').addEventListener('click', eseguiOttimizzazione);

  $('resultsInner').addEventListener('click', (e)=>{
    // il drag non deve aprire il modale: si apre solo cliccando fuori dalle righe trascinabili
    if(e.target.closest('[data-drag-id]')) return;
    const card = e.target.closest('.vresult');
    if(card) openCardModal(card);
  });

  $('resultsInner').addEventListener('dragstart', (e)=>{
    const head = e.target.closest('[data-drag-driver]');
    if(!head) return;
    e.dataTransfer.setData('application/x-driver-swap', head.dataset.dragDriver);
    e.dataTransfer.effectAllowed = 'move';
  });

  $('resultsInner').addEventListener('dragover', (e)=>{
    const card = e.target.closest('.vresult');
    if(!card) return;
    e.preventDefault();
    card.classList.add('drag-over');
  });
  $('resultsInner').addEventListener('dragleave', (e)=>{
    const card = e.target.closest('.vresult');
    if(card) card.classList.remove('drag-over');
  });
  $('resultsInner').addEventListener('drop', (e)=>{
    const card = e.target.closest('.vresult');
    if(!card) return;
    e.preventDefault();
    card.classList.remove('drag-over');

    const driverIdSorgente = e.dataTransfer.getData('application/x-driver-swap');
    if(!driverIdSorgente) return;
    const vehicleIdDest = card.dataset.vehicleId;
    if(vehicleIdDest === 'auto') return; // non ha senso scambiare col riquadro "non assegnabili"
    const idA = parseInt(driverIdSorgente), idB = parseInt(vehicleIdDest);
    if(idA === idB) return;
    const mezzoA = flotta.find(f=>f.id===idA), mezzoB = flotta.find(f=>f.id===idB);
    if(!mezzoA || !mezzoB) return;
    const tmp = mezzoA.nome;
    mezzoA.nome = mezzoB.nome;
    mezzoB.nome = tmp;
    salva();
    renderFlotta();
    eseguiOttimizzazione();
  });

  // il pulsante "ricalcola" vive solo dentro il modale (clone della scheda)
  document.addEventListener('click', (e)=>{
    const recalcBtn = e.target.closest('[data-recalc-card]');
    if(recalcBtn){
      const card = recalcBtn.closest('.vresult');
      applyCardEdits(card);
      closeModal();
      eseguiOttimizzazione();
    }
  });

  // dentro il modale, i campi di modifica non devono chiudere il modale al click
  document.addEventListener('click', (e)=>{
    if(e.target.closest('.stop-edit') && e.target.closest('.modal-card')) e.stopPropagation();
  }, true);
}

function applyDefaults(){
  const d = CONFIG.defaults;
  $('capacitaUtileM3').value = d.capacitaUtileM3;
  $('capacitaLineareM').value = d.capacitaLineareM;
  $('metriLineariPerBancale').value = d.metriLineariPerBancale;
  $('volumeBancale').value = d.volumeBancalePerM3;
  $('tempoSosta').value = d.tempoSostaMin;
  $('tolleranzaRitardo').value = d.tolleranzaRitardoMin;
  $('maxGiroOre').value = d.maxGiroOre;
  $('rientroDeposito').checked = d.rientroDeposito;
}

// ---------------------------------------------------------------------------
// AVVIO
// ---------------------------------------------------------------------------
(async function init(){
  await loadConfig();
  applyDefaults();
  initMap();
  wireUpUI();
  await carica();
})();
