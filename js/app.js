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
let ritiri = [];       // {id, cliente, indirizzo, cap, localita, orario, quantita(m3), lat, lng, approssimato, cittaSospetta, cittaTrovata}
let ritiroIdSeq = 1;
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
    await window.storage?.set('ottimizzatore-ritiri:v3', JSON.stringify({ deposito, ritiri, ritiroIdSeq }));
  }catch(e){}
}
async function carica(){
  try{
    const res = await window.storage?.get('ottimizzatore-ritiri:v3');
    if(res && res.value){
      const d = JSON.parse(res.value);
      deposito = d.deposito || deposito;
      ritiri = d.ritiri || [];
      ritiroIdSeq = d.ritiroIdSeq || (ritiri.length+1);
    }
  }catch(e){}
  $('depositoVia').value = deposito.via || "";
  $('depositoCap').value = deposito.cap || "";
  $('depositoCitta').value = deposito.citta || "";
  if(deposito.lat) setStatus('depositoStatus', `geolocalizzato ✓ — ${deposito.geoDisplay||''}`, false);
  renderRitiri();
  renderMarkersBase();
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
    let quantita = 0;
    if(iVolume !== -1) quantita = parseItalianNumber(row[iVolume]);
    else if(iBancali !== -1) quantita = parseItalianNumber(row[iBancali]) * volumeBancale;
    nuovi.push({ id: ritiroIdSeq++, cliente, indirizzo, cap, localita, orario, quantita, lat:null, lng:null, approssimato:false });
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
function checkFeasibleAndCost(routeStops, durMin, ritiriArr, tempoSostaMin, partenzaMin, tolleranzaMin){
  let cursor = partenzaMin, prev = 0, totalTravel = 0;
  for(const idx of routeStops){
    const travel = durMin[prev][idx];
    cursor += travel; totalTravel += travel;
    const reqMin = toMinutes(ritiriArr[idx-1].orario);
    if(reqMin !== null && cursor > reqMin + tolleranzaMin) return { feasible:false };
    cursor += tempoSostaMin;
    prev = idx;
  }
  return { feasible:true, addedCost: totalTravel };
}

function buildRoutesVRPTW(ritiriArr, durMin, capacitaM3PerMezzo, maxMezzi, tempoSostaMin, partenzaMin, tolleranzaMin){
  let unrouted = ritiriArr.map((r,i)=>i+1);
  const routes = [];
  while(unrouted.length>0 && routes.length<maxMezzi){
    let seed = unrouted.reduce((b,i)=> durMin[0][i]>durMin[0][b]?i:b, unrouted[0]);
    let route = { stops:[seed], carico: ritiriArr[seed-1].quantita||0 };
    unrouted = unrouted.filter(i=>i!==seed);
    let improved = true;
    while(improved){
      improved = false;
      let bestC=null, bestPos=null, bestCost=Infinity;
      for(const cand of unrouted){
        const qty = ritiriArr[cand-1].quantita||0;
        if(route.carico+qty > capacitaM3PerMezzo) continue;
        for(let pos=0; pos<=route.stops.length; pos++){
          const trial = [...route.stops.slice(0,pos), cand, ...route.stops.slice(pos)];
          const chk = checkFeasibleAndCost(trial, durMin, ritiriArr, tempoSostaMin, partenzaMin, tolleranzaMin);
          if(chk.feasible && chk.addedCost < bestCost){ bestCost=chk.addedCost; bestC=cand; bestPos=pos; }
        }
      }
      if(bestC!==null){
        route.stops.splice(bestPos,0,bestC);
        route.carico += ritiriArr[bestC-1].quantita||0;
        unrouted = unrouted.filter(i=>i!==bestC);
        improved = true;
      }
    }
    routes.push(route);
  }
  return { routes, nonAssegnati: unrouted.map(i=>ritiriArr[i-1]) };
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
      <span class="${r.cittaSospetta ? 'geo-sospetta' : (r.lat ? (r.approssimato ? 'geo-approx' : 'geo-ok') : 'geo-pending')}"
            title="${r.cittaSospetta ? 'città trovata diversa da quella dichiarata: '+(r.cittaTrovata||'?') : (r.approssimato?'geolocalizzato in modo approssimato':'')}">●</span>
      <span class="rname" title="${escapeHtml(r.indirizzo)} ${escapeHtml(r.cap||'')} ${escapeHtml(r.localita||'')}">${escapeHtml(r.cliente)}</span>
      <span class="rmeta">${r.quantita ? r.quantita.toFixed(1)+'m³' : ''}</span>
      <span class="rmeta">${r.orario||''}</span>
      <button class="btn-danger" data-del="${r.id}">×</button>
    </div>
  `).join('');
  scrollBox.querySelectorAll('[data-del]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      ritiri = ritiri.filter(r => r.id !== parseInt(btn.dataset.del));
      renderRitiri(); renderMarkersBase(); salva();
    });
  });
}

function renderResults(risultati, nonGeolocalizzati, nonAssegnati, daVerificare, capacitaM3PerMezzo, maxMezzi){
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
    <div class="vresult" style="${r.overLimit ? 'border-color:var(--danger)':''}">
      <div class="vhead">
        <span class="swatch" style="background:${r.colore}"></span>
        <span class="vname">${r.nome}</span>
      </div>
      <div class="stats">
        <span><b>${r.carico.toFixed(1)}</b> m³ (${pct}%)</span>
        <span><b>${r.km.toFixed(0)}</b> km</span>
        <span><b>${Math.round(r.minuti)}</b> min</span>
        <span><b>${r.stops.length}</b> tappe</span>
      </div>
      ${avvisi.length ? `<div style="color:var(--danger);font-size:11px;margin-bottom:8px;">${avvisi.join('<br>')}</div>` : ''}
      <ul class="stoplist">
        ${r.stops.map((s,i)=>`
          <li>
            <span class="idx">${i+1}</span>
            <span class="stime ${s.late?'late':''}">${s.arrivo}</span>
            <span class="sname" title="${escapeHtml(s.ritiro.indirizzo)}${s.ritiro.approssimato?' (geoloc. approssimata)':''}">${escapeHtml(s.ritiro.cliente)}${s.ritiro.approssimato?' ~':''}</span>
            <span class="sreq">${s.ritiro.orario ? 'atteso '+s.ritiro.orario : ''}</span>
          </li>
        `).join('')}
      </ul>
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
      <div class="vresult" style="border-color:var(--danger)">
        <div class="vhead"><span class="vname" style="color:var(--danger)">NON ASSEGNABILI (${nonAssegnati.length})</span></div>
        <ul class="stoplist">
          ${nonAssegnati.map(r=>`<li><span class="sname">${escapeHtml(r.cliente)} — ${r.quantita.toFixed(1)} m³, orario ${r.orario||'—'}</span></li>`).join('')}
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
    const maxMezzi = parseInt($('numMezzi').value) || 1;
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
    const capacitaBancali = parseFloat($('capacitaBancali').value) || CONFIG.defaults.capacitaBancali;
    const volumeBancale = parseFloat($('volumeBancale').value) || CONFIG.defaults.volumeBancalePerM3;
    const capacitaM3PerMezzo = capacitaBancali * volumeBancale;
    const tempoSostaMin = parseFloat($('tempoSosta').value) || CONFIG.defaults.tempoSostaMin;
    const tolleranzaMin = parseFloat($('tolleranzaRitardo').value) || CONFIG.defaults.tolleranzaRitardoMin;
    const maxGiroMin = (parseFloat($('maxGiroOre').value) || CONFIG.defaults.maxGiroOre) * 60;
    const [oh, om] = $('orarioPartenza').value.split(':').map(Number);
    const partenzaMin = oh*60+om;
    const rientro = $('rientroDeposito').checked;

    const { routes, nonAssegnati } = buildRoutesVRPTW(ritiriValidi, durMin, capacitaM3PerMezzo, maxMezzi, tempoSostaMin, partenzaMin, tolleranzaMin);

    const risultati = [];
    routesLayer.clearLayers();
    markersLayer.clearLayers();
    renderMarkersBase();

    for(let vi=0; vi<routes.length; vi++){
      const route = routes[vi];
      if(route.stops.length === 0) continue;
      setStatus('optStatus', `Ottimizzo percorso: Mezzo ${vi+1}...`, false);

      const refinedStops = constrainedTwoOpt(route.stops, durMin, ritiriValidi, tempoSostaMin, partenzaMin, tolleranzaMin);
      let order = [0, ...refinedStops];
      if(rientro) order = [...order, 0];

      const routeCoords = order.map(gi => gi===0 ? [deposito.lat, deposito.lng] : [ritiriValidi[gi-1].lat, ritiriValidi[gi-1].lng]);
      let geomData = null;
      try{ geomData = await osrmRoute(routeCoords); }catch(e){}

      let cursorMin = partenzaMin;
      const stopsWithTime = [];
      for(let k=1;k<order.length;k++){
        const gi = order[k];
        if(gi === 0) break;
        cursorMin += durMin[order[k-1]][gi];
        const arrivo = fmtClock(cursorMin);
        const ritiroObj = ritiriValidi[gi-1];
        let late = false;
        const reqMin = toMinutes(ritiroObj.orario);
        if(reqMin !== null && cursorMin > reqMin + tolleranzaMin) late = true;
        stopsWithTime.push({ ritiro: ritiroObj, arrivo, late });
        cursorMin += tempoSostaMin;
      }

      const totalDistM = geomData ? geomData.distance : routeLength(order, fullDist);
      const totalDurSec = geomData ? geomData.duration : routeLength(order, fullDur);
      const minutiTotali = totalDurSec/60 + (stopsWithTime.length*tempoSostaMin);

      risultati.push({
        nome: `Mezzo ${vi+1}`, colore: CONFIG.palette[vi % CONFIG.palette.length],
        stops: stopsWithTime, carico: route.carico,
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

    renderResults(risultati, nonGeolocalizzati, nonAssegnati, daVerificare, capacitaM3PerMezzo, maxMezzi);

    if(risultati.length){
      const allCoords = risultati.flatMap(r => r.stops.map(s=>[s.ritiro.lat, s.ritiro.lng]));
      allCoords.push([deposito.lat, deposito.lng]);
      map.fitBounds(allCoords, { padding:[40,40] });
    }

    const problemi = [];
    if(daVerificare.length) problemi.push(`${daVerificare.length} indirizzo/i con città sospetta`);
    if(nonGeolocalizzati.length) problemi.push(`${nonGeolocalizzati.length} non geolocalizzabile/i`);
    if(nonAssegnati.length) problemi.push(`${nonAssegnati.length} non assegnabile/i (capacità o orari incompatibili)`);
    const troppiLunghi = risultati.filter(r=>r.overLimit).length;
    if(troppiLunghi) problemi.push(`${troppiLunghi} mezzo/i oltre il limite orario`);
    const riepilogo = `Usati ${risultati.length} mezzi su ${maxMezzi} disponibili.`;
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
    const quantita = parseFloat($('mQuantita').value) || 0;
    if(!cliente || !indirizzo){ alert('Compila almeno cliente e indirizzo.'); return; }
    ritiri.push({ id: ritiroIdSeq++, cliente, indirizzo, cap, localita, orario, quantita, lat:null, lng:null, approssimato:false });
    ['mCliente','mIndirizzo','mCap','mLocalita','mOrario','mQuantita'].forEach(id => $(id).value = '');
    renderRitiri(); salva();
  });

  $('optimizeBtn').addEventListener('click', eseguiOttimizzazione);
}

function applyDefaults(){
  const d = CONFIG.defaults;
  $('capacitaBancali').value = d.capacitaBancali;
  $('volumeBancale').value = d.volumeBancalePerM3;
  $('tempoSosta').value = d.tempoSostaMin;
  $('tolleranzaRitardo').value = d.tolleranzaRitardoMin;
  $('maxGiroOre').value = d.maxGiroOre;
  $('orarioPartenza').value = d.orarioPartenza;
  $('numMezzi').value = d.maxMezzi;
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
