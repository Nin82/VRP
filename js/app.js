// ============================================================================
// Tabellone Ritiri — app.js
// Modello: TU assegni un ritiro a un driver (click-to-assign), l'app verifica
// all'istante se regge (capacità, pianale, orari) e — se il driver ha già
// qualcosa in giornata che non ci sta insieme — apre da sola un secondo giro
// (ritorno in deposito, poi riparte) invece di forzare un unico giro continuo.
// Nessun algoritmo decide da solo chi fa cosa: l'automazione qui è solo verifica.
// ============================================================================

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
let CONFIG = null;
async function loadConfig(){
  const resp = await fetch('./config.json');
  CONFIG = await resp.json();
}

// ---------------------------------------------------------------------------
// STATO
// ---------------------------------------------------------------------------
let deposito = { via:"", cap:"", citta:"", lat:null, lng:null };
let ritiri = [];        // {id, cliente, indirizzo, cap, localita, orario, orarioEntro, quantita, volumeDichiarato, metriLineari, bancaliStandard, biliciRichiesti, bisognaOrario, assegnaA, lat, lng, approssimato, cittaSospetta}
let ritiroIdSeq = 1;
let flotta = [];        // {id, nome, orarioPartenza, fineDisponibilita}
let mezzoIdSeq = 1;
let giriConfermati = []; // {idConferma, flottaId, nome, stops, partenzaMin, minuti, endLat, endLng, ritiriIds}
let confermaIdSeq = 1;
const geocodeCache = {};

let map, markersLayer, routeLinesLayer;
let ritiroSelezionatoId = null;

// ---------------------------------------------------------------------------
// UTILITY
// ---------------------------------------------------------------------------
function $(id){ return document.getElementById(id); }
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function setStatus(msg, isErr){
  const el = $('globalStatus');
  el.textContent = msg; el.className = 'status-line' + (isErr?' err':'');
}
function toMinutes(hhmm){
  if(!hhmm) return null;
  const [h,m] = String(hhmm).split(':').map(Number);
  if(isNaN(h)) return null;
  return h*60+m;
}
function fmtClock(minRaw){
  const totalMin = Math.round(minRaw);
  const h = Math.floor(totalMin/60)%24, m = totalMin%60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}
function haversineKm(lat1,lng1,lat2,lng2){
  const R=6371, toRad=x=>x*Math.PI/180;
  const dLat=toRad(lat2-lat1), dLng=toRad(lng2-lng1);
  const a=Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ids dei ritiri già dentro un giro confermato: esclusi da OGNI ricalcolo attivo,
// così un giro confermato non può più essere "visto" (e quindi ri-confermato,
// o disassegnato per errore) dal tabellone — è congelato per davvero.
function idsRitiriConfermati(){
  return new Set(giriConfermati.flatMap(g => g.ritiriIds.map(String)));
}

// da chiamare dopo OGNI mutazione che tocca ritiri/flotta: rimuove riferimenti
// a id che non esistono più (giri confermati orfani, assegnazioni a mezzi cancellati)
// e ricalcola tutte le colonne driver — lo stato mostrato è sempre coerente,
// mai serve ricaricare la pagina per "ripulire" qualcosa.
async function ricalcolaTuttoLoStato(){
  const idRitiriEsistenti = new Set(ritiri.map(r=>String(r.id)));
  const idFlottaEsistenti = new Set(flotta.map(f=>String(f.id)));
  const primaLen = giriConfermati.length;
  giriConfermati = giriConfermati.filter(g =>
    idFlottaEsistenti.has(String(g.flottaId)) && g.ritiriIds.every(id=>idRitiriEsistenti.has(String(id)))
  );
  if(giriConfermati.length !== primaLen) salva();

  for(const d of flotta) await ricalcolaColonnaDriver(d);
  renderConfermati();
  renderTabellone();
  if(map) renderMappa();
}

// ---------------------------------------------------------------------------
// PERSISTENZA
// ---------------------------------------------------------------------------
function salva(){
  try{
    localStorage.setItem('tabellone-ritiri:v1', JSON.stringify({
      deposito, ritiri, ritiroIdSeq, flotta, mezzoIdSeq, giriConfermati, confermaIdSeq
    }));
  }catch(e){ console.warn('salvataggio locale fallito', e); }
}
function carica(){
  try{
    const raw = localStorage.getItem('tabellone-ritiri:v1');
    if(raw){
      const d = JSON.parse(raw);
      deposito = d.deposito || deposito;
      ritiri = d.ritiri || [];
      ritiroIdSeq = d.ritiroIdSeq || (ritiri.length+1);
      flotta = d.flotta || [];
      mezzoIdSeq = d.mezzoIdSeq || (flotta.length+1);
      giriConfermati = d.giriConfermati || [];
      confermaIdSeq = d.confermaIdSeq || (giriConfermati.length+1);
    }
  }catch(e){ console.warn('lettura locale fallita', e); }
  if(flotta.length === 0){
    flotta = [{ id: mezzoIdSeq++, nome:'', orarioPartenza: CONFIG.defaults.primoMezzoOrarioPartenza, fineDisponibilita:'' }];
  }
  $('depositoVia').value = deposito.via || "";
  $('depositoCap').value = deposito.cap || "";
  $('depositoCitta').value = deposito.citta || "";
  if(deposito.lat) setStatus(`deposito geolocalizzato ✓`, false);
}

// ---------------------------------------------------------------------------
// GEOCODING — multilivello con verifica città
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
  let hit = null, precisione = 'esatto';

  if(via){
    const h = await nominatimStructured({ street: via, postalcode: cap||'', city: citta||'', country });
    if(h && verifiedCity(citta, extractCity(h))) hit = h;
  }
  if(!hit && via){
    await sleep(delay);
    const h = await nominatimFreeform(`${via}, ${cap||''} ${citta||''}, ${country}`);
    if(h && verifiedCity(citta, extractCity(h))) hit = h;
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
  if(!hit) throw new Error(`indirizzo non trovato: ${via||''} ${cap||''} ${citta||''}`.trim());

  const res = {
    lat: parseFloat(hit.lat), lng: parseFloat(hit.lon), precisione,
    cittaTrovata: extractCity(hit),
    cittaSospetta: citta ? !cityMatches(citta, extractCity(hit)) : false
  };
  geocodeCache[key] = res;
  return res;
}
async function osrmTable(coords){
  const coordStr = coords.map(c => `${c[1]},${c[0]}`).join(';');
  const resp = await fetch(`${CONFIG.endpoints.osrmTable}/${coordStr}?annotations=duration`);
  if(!resp.ok) throw new Error('OSRM fallito');
  const data = await resp.json();
  if(data.code !== 'Ok') throw new Error('OSRM: ' + data.code);
  return data;
}
async function osrmRoute(coords){
  const coordStr = coords.map(c => `${c[1]},${c[0]}`).join(';');
  const resp = await fetch(`https://router.project-osrm.org/route/v1/driving/${coordStr}?overview=full&geometries=geojson`);
  if(!resp.ok) throw new Error('OSRM route fallito');
  const data = await resp.json();
  if(data.code !== 'Ok') throw new Error('OSRM: ' + data.code);
  return data.routes[0];
}

// ---------------------------------------------------------------------------
// IMPORT FILE (Excel / CSV)
// ---------------------------------------------------------------------------
function normalizeHeader(h){ return String(h||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim(); }
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
    return `${String(v.getUTCHours()).padStart(2,'0')}:${String(v.getUTCMinutes()).padStart(2,'0')}`;
  }
  if(typeof v === 'number'){
    const totalMin = Math.round(v * 24 * 60);
    return `${String(Math.floor(totalMin/60)%24).padStart(2,'0')}:${String(totalMin%60).padStart(2,'0')}`;
  }
  const s = String(v).trim();
  const m = s.match(/(\d{1,2})[:.](\d{2})/);
  return m ? `${m[1].padStart(2,'0')}:${m[2]}` : s;
}
function contaPezzi(biliciRichiesti){
  if(!biliciRichiesti || biliciRichiesti <= 0) return 0;
  const interi = Math.floor(biliciRichiesti);
  const fraz = biliciRichiesti - interi;
  return interi + (fraz > 1e-6 ? 1 : 0);
}

function processWorkbook(data){
  const wb = XLSX.read(data, { type:'array', cellDates:true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header:1, raw:true, defval:'' });
  if(rows.length < 2){ setStatus('Il file non contiene righe di dati.', true); return; }
  const headers = rows[0];
  const syn = CONFIG.headerSynonyms;
  const iCliente = matchColumn(headers, syn.cliente);
  const iIndirizzo = matchColumn(headers, syn.indirizzo);
  const iCap = matchColumn(headers, syn.cap);
  const iLocalita = matchColumn(headers, syn.localita);
  const iOrario = matchColumn(headers, syn.orario);
  const iOrarioEntro = matchColumn(headers, syn.orarioEntro);
  const iMetriLineari = matchColumn(headers, syn.metriLineari);
  const iBiliciRichiesti = matchColumn(headers, syn.biliciRichiesti);
  const iVolume = matchColumn(headers, syn.volume);
  const iBancali = matchColumn(headers, syn.bancali);

  if(iCliente === -1 || iIndirizzo === -1){
    setStatus('Colonne non riconosciute: servono almeno "Cliente" e "Indirizzo".', true);
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
    const biliciRichiesti = iBiliciRichiesti !== -1 ? parseItalianNumber(row[iBiliciRichiesti]) : 0;
    let quantita = 0, bancaliStandard = 0, volumeDichiarato = false;
    if(iVolume !== -1 && parseItalianNumber(row[iVolume]) > 0){ quantita = parseItalianNumber(row[iVolume]); volumeDichiarato = true; }
    else if(iBancali !== -1){ bancaliStandard = parseItalianNumber(row[iBancali]); quantita = bancaliStandard * volumeBancale; }

    const pezzi = contaPezzi(biliciRichiesti);
    if(pezzi >= 2){
      const interi = Math.floor(biliciRichiesti), fraz = biliciRichiesti - interi;
      for(let k=0;k<interi;k++){
        nuovi.push({ id: ritiroIdSeq++, cliente:`${cliente} (bilico ${k+1}/${pezzi})`, indirizzo, cap, localita,
          orario:'', orarioEntro:'', quantita:0, volumeDichiarato:false, metriLineari:0, bancaliStandard:0, biliciRichiesti:1,
          bisognaOrario:true, assegnaA:null, lat:null, lng:null, approssimato:false });
      }
      if(fraz > 1e-6){
        nuovi.push({ id: ritiroIdSeq++, cliente:`${cliente} (bilico ${pezzi}/${pezzi})`, indirizzo, cap, localita,
          orario:'', orarioEntro:'', quantita:0, volumeDichiarato:false, metriLineari:0, bancaliStandard:0, biliciRichiesti:fraz,
          bisognaOrario:true, assegnaA:null, lat:null, lng:null, approssimato:false });
      }
    } else {
      nuovi.push({ id: ritiroIdSeq++, cliente, indirizzo, cap, localita, orario, orarioEntro, quantita, volumeDichiarato, metriLineari,
        bancaliStandard, biliciRichiesti, bisognaOrario:false, assegnaA:null, lat:null, lng:null, approssimato:false });
    }
  }

  if(nuovi.length === 0){ setStatus('Nessun ritiro valido trovato nel file.', true); return; }
  if(ritiri.length > 0){
    const sostituisci = confirm(`Ci sono già ${ritiri.length} ritiri caricati. Sostituirli con i ${nuovi.length} del nuovo file?\n(Annulla per accodarli invece)`);
    ritiri = sostituisci ? nuovi : ritiri.concat(nuovi);
  } else {
    ritiri = nuovi;
  }
  setStatus(`Caricati ${nuovi.length} ritiri dal file.`, false);
  renderRitiri();
  ricalcolaTuttoLoStato();
  salva();

  const daProgrammare = nuovi.filter(r => r.bisognaOrario);
  if(daProgrammare.length) avviaCodaMaschereBilici(daProgrammare);
}
function handleFile(file){
  const reader = new FileReader();
  reader.onload = (e) => {
    try{ processWorkbook(new Uint8Array(e.target.result)); }
    catch(err){ console.error(err); setStatus('Errore lettura file: ' + err.message, true); }
  };
  reader.readAsArrayBuffer(file);
}
function processFlottaWorkbook(data){
  const wb = XLSX.read(data, { type:'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header:1, raw:true, defval:'' });
  if(rows.length < 2){ setStatus('Il file flotta non contiene righe di dati.', true); return; }
  const headers = rows[0];
  const syn = CONFIG.headerSynonyms;
  const iNome = matchColumn(headers, syn.nomeMezzo);
  const iOrario = matchColumn(headers, syn.orarioPartenzaMezzo);
  const iFineDisp = matchColumn(headers, syn.fineDisponibilitaMezzo);

  const nuovi = [];
  for(let r=1;r<rows.length;r++){
    const row = rows[r];
    if(!row || row.every(c => c === '' || c === undefined || c === null)) continue;
    const nome = iNome !== -1 ? String(row[iNome]||'').trim() : '';
    const orarioPartenza = iOrario !== -1 ? normalizeOrario(row[iOrario]) : '';
    const fineDisponibilita = iFineDisp !== -1 ? normalizeOrario(row[iFineDisp]) : '';
    if(!orarioPartenza) continue;
    nuovi.push({ id: mezzoIdSeq++, nome, orarioPartenza, fineDisponibilita });
  }
  if(nuovi.length === 0){ setStatus("Nessun mezzo valido (serve almeno l'orario di partenza).", true); return; }
  if(flotta.length > 0){
    const sostituisci = confirm(`Ci sono già ${flotta.length} mezzi. Sostituirli con i ${nuovi.length} del file?\n(Annulla per accodarli invece)`);
    flotta = sostituisci ? nuovi : flotta.concat(nuovi);
  } else { flotta = nuovi; }
  setStatus(`Caricati ${nuovi.length} mezzi dal file.`, false);
  renderFlotta();
  ricalcolaTuttoLoStato();
  salva();
}
function handleFileFlotta(file){
  const reader = new FileReader();
  reader.onload = (e) => {
    try{ processFlottaWorkbook(new Uint8Array(e.target.result)); }
    catch(err){ console.error(err); setStatus('Errore lettura file flotta: ' + err.message, true); }
  };
  reader.readAsArrayBuffer(file);
}

// maschera sequenziale: un cliente alla volta, chiede l'orario di ciascun bilico.
function avviaCodaMaschereBilici(pezzi){
  const perCliente = {};
  pezzi.forEach(r => {
    const nomeBase = r.cliente.replace(/\s*\(bilico \d+\/\d+\)\s*$/,'');
    (perCliente[nomeBase] = perCliente[nomeBase] || []).push(r);
  });
  mostraProssimaMaschera(Object.entries(perCliente).map(([nome, pezzi]) => ({ nome, pezzi })));
}
function mostraProssimaMaschera(coda){
  if(coda.length === 0) return;
  const item = coda[0], resto = coda.slice(1);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-card">
      <h3 style="margin-top:0;">${escapeHtml(item.nome)} — ${item.pezzi.length} bilici</h3>
      <div class="status-line" style="margin-bottom:12px;">Inserisci pronto-dalle/entro-le per ciascuno, poi premi Conferma. Se salti, restano "in attesa" finché non li imposti a mano nella scheda Ritiri.</div>
      ${item.pezzi.map((p,i)=>`
        <div class="row" style="margin-bottom:8px;">
          <div class="field"><label>Bilico ${i+1} — Pronto dalle</label><input type="time" data-mi="${i}" data-mc="orario"></div>
          <div class="field"><label>Entro le</label><input type="time" data-mi="${i}" data-mc="orarioEntro"></div>
        </div>
      `).join('')}
      <div class="row" style="margin-top:8px;">
        <button class="btn-ghost" id="maskSkipBtn" style="border:1px solid var(--border);">Salta per ora</button>
        <button class="btn-ghost" id="maskConfirmBtn" style="border:1px solid var(--ok);color:var(--ok);">✓ Conferma e salva orari</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const chiudi = () => { overlay.remove(); mostraProssimaMaschera(resto); };
  overlay.querySelector('#maskSkipBtn').addEventListener('click', chiudi);
  overlay.querySelector('#maskConfirmBtn').addEventListener('click', ()=>{
    let almenoUno = false;
    item.pezzi.forEach((p,i)=>{
      const rOrario = overlay.querySelector(`[data-mi="${i}"][data-mc="orario"]`).value;
      const rEntro = overlay.querySelector(`[data-mi="${i}"][data-mc="orarioEntro"]`).value;
      const ritiro = ritiri.find(x=>x.id===p.id);
      if(ritiro && rOrario){ ritiro.orario = rOrario; ritiro.orarioEntro = rEntro; ritiro.bisognaOrario = false; almenoUno = true; }
    });
    salva();
    renderRitiri();      // aggiorna SUBITO l'etichetta rossa "in attesa" -> normale
    renderTabellone();   // fa comparire subito i pezzi programmati tra i "da assegnare"
    if(!almenoUno) alert('Nessun orario inserito: i bilici restano in attesa. Puoi impostarli più tardi dalla scheda Ritiri.');
    chiudi();
  });
}

// ---------------------------------------------------------------------------
// CAPACITÀ
// ---------------------------------------------------------------------------
// metri lineari effettivi: sempre calcolabili, è il vincolo fisico "vero" per
// merce pallettizzata (spazio a terra) — a differenza del volume, che per i
// bancali è solo una STIMA usata per il riepilogo, non un limite fisico affidabile
function effectiveML(r, capacitaM3, capacitaLineareM, mlPerBancale){
  if(r.metriLineari && r.metriLineari > 0) return r.metriLineari;
  if(r.bancaliStandard && r.bancaliStandard > 0) return r.bancaliStandard * mlPerBancale;
  return (r.quantita||0) / (capacitaM3/capacitaLineareM);
}

// ---------------------------------------------------------------------------
// SEGMENTAZIONE IN GIRI
// ---------------------------------------------------------------------------
function costruisciGiriDriver(ritiriOrdinati, durMin, partenzaMinimaAssoluta, tempoSostaMin, maxAttesaMin){
  const giri = [];
  let i = 0;
  let prossimaPartenzaMinima = partenzaMinimaAssoluta;

  while(i < ritiriOrdinati.length){
    const primo = ritiriOrdinati[i];
    const travelDep = durMin[0][primo._matIdx];
    const readyPrimo = toMinutes(primo.orario);
    let partenza = prossimaPartenzaMinima;
    if(readyPrimo !== null) partenza = Math.max(partenza, readyPrimo - travelDep);

    let cursor = partenza + travelDep, waited0 = false;
    if(readyPrimo !== null && cursor < readyPrimo){ cursor = readyPrimo; waited0 = true; }
    const stops = [{ ritiro: primo, arrivo: fmtClock(cursor), waited: waited0, late:false }];
    cursor += tempoSostaMin;
    let prevMat = primo._matIdx;
    i++;

    while(i < ritiriOrdinati.length){
      const next = ritiriOrdinati[i];
      const arrivoDiretto = cursor + durMin[prevMat][next._matIdx];
      const readyNext = toMinutes(next.orario);
      if(readyNext !== null && arrivoDiretto < readyNext){
        if((readyNext - arrivoDiretto) > maxAttesaMin) break;
      }
      cursor = arrivoDiretto;
      let waited = false;
      if(readyNext !== null && cursor < readyNext){ cursor = readyNext; waited = true; }
      stops.push({ ritiro: next, arrivo: fmtClock(cursor), waited, late:false });
      cursor += tempoSostaMin;
      prevMat = next._matIdx;
      i++;
    }

    const rientro = cursor + durMin[prevMat][0];
    giri.push({ partenzaMin: partenza, partenzaTesto: fmtClock(partenza), stops, rientroMin: rientro, rientroTesto: fmtClock(rientro) });
    prossimaPartenzaMinima = rientro;
  }
  return giri;
}

// ---------------------------------------------------------------------------
// TABELLONE — rendering
// ---------------------------------------------------------------------------
function ritiriNonAssegnati(){
  const idConfermati = idsRitiriConfermati();
  return ritiri.filter(r => !r.assegnaA && !r.bisognaOrario && !idConfermati.has(String(r.id)));
}

// suggerimento di abbinamento: tra i ritiri NON assegnati, quali sono geograficamente
// vicini (linea d'aria, è solo un suggerimento) e potrebbero stare sullo stesso giro.
// La verifica VERA (orari, capacità reale) resta quella di tentaAssegnazione.
function trovaAbbinabili(ritiro, tuttiGliAltri){
  if(!ritiro.lat) return [];
  const SOGLIA_KM = 20;
  return tuttiGliAltri
    .filter(r => r.id !== ritiro.id && r.lat)
    .map(r => ({ ritiro:r, km: haversineKm(ritiro.lat, ritiro.lng, r.lat, r.lng) }))
    .filter(x => x.km <= SOGLIA_KM)
    .sort((a,b)=> a.km-b.km)
    .slice(0,3);
}

function renderRitiriTabellone(){
  const lista = ritiriNonAssegnati();
  $('tabelloneRitiri').innerHTML = `<div class="tab-col-head">Da assegnare (${lista.length})</div>` + lista.map(r => {
    const abbinabili = trovaAbbinabili(r, lista);
    return `
    <div class="tab-ritiro-card ${ritiroSelezionatoId===r.id?'selezionato':''}" data-tab-ritiro="${r.id}">
      <div class="tab-ritiro-cliente">${escapeHtml(r.cliente)}</div>
      <div class="tab-ritiro-meta">${r.quantita.toFixed(1)}m³${r.biliciRichiesti?` · ${r.biliciRichiesti} bilici`:''} · ${r.orario||'—'}–${r.orarioEntro||'—'}</div>
      ${!r.lat && r._geoFallita ? `<div class="tab-ritiro-warn">⚠ indirizzo non trovato</div>` : ''}
      ${abbinabili.length ? `<div class="tab-ritiro-abbina">🔗 vicino a: ${abbinabili.map(a=>`${escapeHtml(a.ritiro.cliente)} (${a.km.toFixed(0)}km)`).join(', ')}</div>` : ''}
    </div>`;
  }).join('');
}
function renderDriversTabellone(){
  $('tabelloneDrivers').innerHTML = flotta.map(d => {
    const cache = d._routeCache || { giri: [], statoTesto: `libero dalle ${d.orarioPartenza}` };
    return `
    <div class="tab-driver-col ${ritiroSelezionatoId?'selezionabile':''}" data-tab-driver="${d.id}" title="${ritiroSelezionatoId?'Clicca per assegnare qui':''}">
      <div class="tab-driver-head">${escapeHtml(d.nome||'(senza nome)')}</div>
      <div class="tab-driver-stato">${cache.statoTesto}</div>
      ${cache.giri.map((g,gi)=>`
        <div class="tab-giro-block">
          <div class="tab-giro-label">
            <span>Giro ${gi+1} — ${g.partenzaTesto}→${g.rientroTesto}</span>
            <span class="tab-giro-conferma" data-conferma-driver="${d.id}" data-conferma-giro="${gi}" title="Blocca questo giro: sparisce da qui e va tra i confermati">✓ conferma</span>
          </div>
          ${g.stops.map((s,i)=>`
            <div class="tab-stop-card ${s.late?'late':''}" data-tab-unassign="${s.ritiro.id}" title="Clicca per togliere">
              <span class="tab-stop-idx">${i+1}</span>
              <span class="tab-stop-cliente">${escapeHtml(s.ritiro.cliente)}</span>
              <span class="tab-stop-arrivo">${s.arrivo}${s.late?' ⚠':(s.waited?' ⏳':'')}</span>
            </div>
          `).join('')}
        </div>
      `).join('')}
    </div>`;
  }).join('');
}
function renderTabellone(){ renderRitiriTabellone(); renderDriversTabellone(); }

function renderConfermati(){
  $('confermatiCount').textContent = `(${giriConfermati.length})`;
  if(giriConfermati.length === 0){ $('confermatiList').innerHTML = `<div class="empty-hint">nessun giro confermato ancora</div>`; return; }
  $('confermatiList').innerHTML = giriConfermati.map(g => `
    <div style="padding:6px 0;border-bottom:1px solid var(--border-soft);">
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="flex:1;font-size:11.5px;"><b>${escapeHtml(g.nome)}</b> — ${fmtClock(g.partenzaMin)}-${fmtClock(g.partenzaMin+g.minuti)}</span>
        <button class="btn-danger" data-annulla-conferma="${g.idConferma}" title="Annulla conferma">×</button>
      </div>
      <div style="font-size:10.5px;color:var(--text-muted);margin-top:2px;">${g.stops.map(s=>escapeHtml(s.ritiro.cliente)).join(', ')}</div>
    </div>
  `).join('');
  $('confermatiList').querySelectorAll('[data-annulla-conferma]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      if(!confirm('Annullare la conferma? I ritiri torneranno tra i "da assegnare".')) return;
      const g = giriConfermati.find(x=>x.idConferma===parseInt(btn.dataset.annullaConferma));
      if(g){
        // libera davvero i ritiri: tornano nel pool non assegnato, non restano
        // agganciati al driver in uno stato limbo
        g.ritiriIds.forEach(rid=>{
          const r = ritiri.find(x=>String(x.id)===String(rid));
          if(r) r.assegnaA = null;
        });
      }
      giriConfermati = giriConfermati.filter(x=>x.idConferma!==parseInt(btn.dataset.annullaConferma));
      salva();
      ricalcolaTuttoLoStato();
    });
  });
}

// ---------------------------------------------------------------------------
// RICALCOLO DI UN DRIVER — SOLO i ritiri non ancora confermati entrano qui
// ---------------------------------------------------------------------------
async function ricalcolaColonnaDriver(driver){
  const idConfermati = idsRitiriConfermati();
  const suoiRitiri = ritiri.filter(r => r.assegnaA === driver.id && r.lat && !idConfermati.has(String(r.id)));
  if(suoiRitiri.length === 0){
    driver._routeCache = { giri: [], statoTesto: `libero dalle ${driver.orarioPartenza}` };
    return;
  }
  if(!deposito.lat){ driver._routeCache = { giri: [], statoTesto: 'geolocalizza il deposito prima' }; return; }

  let table;
  try{ table = await osrmTable([[deposito.lat,deposito.lng], ...suoiRitiri.map(r=>[r.lat,r.lng])]); }
  catch(e){ driver._routeCache = { giri: [], statoTesto: 'errore di calcolo distanze' }; return; }
  const durMin = table.durations.map(row=>row.map(v=>v/60));

  const tempoSostaMin = parseFloat($('tempoSosta').value) || CONFIG.defaults.tempoSostaMin;
  const tolleranzaMin = parseFloat($('tolleranzaRitardo').value) || CONFIG.defaults.tolleranzaRitardoMin;
  const fineTurnoMin = toMinutes($('fineTurno').value) || toMinutes(CONFIG.defaults.fineTurno);
  const maxAttesaMin = parseFloat($('maxAttesaMin').value) || CONFIG.defaults.maxAttesaMin;

  const suoiGiriConfermati = giriConfermati.filter(g => g.flottaId === driver.id);
  const partenzaBase = suoiGiriConfermati.length
    ? Math.max(...suoiGiriConfermati.map(g=>g.partenzaMin+g.minuti))
    : toMinutes(driver.orarioPartenza);

  const ordinati = suoiRitiri
    .map((r,i)=>({ ...r, _matIdx: i+1 }))
    .sort((a,b)=> toMinutes(a.orarioEntro||a.orario||'23:59') - toMinutes(b.orarioEntro||b.orario||'23:59'));

  const giri = costruisciGiriDriver(ordinati, durMin, partenzaBase, tempoSostaMin, maxAttesaMin);
  giri.forEach(g => g.stops.forEach(s=>{
    const deadline = (toMinutes(s.ritiro.orarioEntro) !== null) ? toMinutes(s.ritiro.orarioEntro) : fineTurnoMin;
    s.late = toMinutes(s.arrivo) > deadline + tolleranzaMin;
  }));

  const ultimoRientro = giri.length ? giri[giri.length-1].rientroTesto : driver.orarioPartenza;
  driver._routeCache = {
    giri,
    statoTesto: giri.length ? `${giri.length} giro/i attivi · libero dalle ${ultimoRientro}` : `libero dalle ${driver.orarioPartenza}`
  };
}

// ---------------------------------------------------------------------------
// TENTATIVO DI ASSEGNAZIONE
// ---------------------------------------------------------------------------
async function tentaAssegnazione(ritiroId, driverId){
  const ritiro = ritiri.find(r=>r.id===ritiroId);
  const driver = flotta.find(f=>f.id===driverId);
  if(!ritiro || !driver) return;

  setStatus(`Verifico ${ritiro.cliente} su ${driver.nome||'mezzo'}...`, false);

  if(!deposito.lat){
    deposito.via = $('depositoVia').value.trim();
    deposito.cap = $('depositoCap').value.trim();
    deposito.citta = $('depositoCitta').value.trim();
    if(!deposito.cap && !deposito.citta){ alert('Inserisci almeno CAP o città del deposito.'); return; }
    try{
      const g = await geocodeMultilivello({ via: deposito.via, cap: deposito.cap, citta: deposito.citta });
      deposito.lat=g.lat; deposito.lng=g.lng;
      setStatus(`deposito geolocalizzato${g.precisione==='approssimato'?' (approssimato)':' ✓'}`, g.precisione==='approssimato');
    }catch(e){ alert('Impossibile geolocalizzare il deposito: '+e.message); return; }
  }
  if(!ritiro.lat){
    try{
      const g = await geocodeMultilivello({ via: ritiro.indirizzo, cap: ritiro.cap, citta: ritiro.localita });
      ritiro.lat=g.lat; ritiro.lng=g.lng; ritiro.approssimato = g.precisione==='approssimato'; ritiro.cittaSospetta = g.cittaSospetta;
    }catch(e){ ritiro._geoFallita = true; renderTabellone(); alert('Impossibile geolocalizzare '+ritiro.cliente+': '+e.message); return; }
  }
  const idConfermati = idsRitiriConfermati();
  const suoiEsistenti = ritiri.filter(r => r.assegnaA === driverId && !idConfermati.has(String(r.id)));
  for(const r of suoiEsistenti){
    if(!r.lat){
      try{
        const g = await geocodeMultilivello({ via: r.indirizzo, cap: r.cap, citta: r.localita });
        r.lat=g.lat; r.lng=g.lng; r.approssimato = g.precisione==='approssimato';
      }catch(e){ /* resta senza coordinate */ }
    }
  }
  salva();

  const esistentiValidi = suoiEsistenti.filter(r=>r.lat);
  let table;
  try{ table = await osrmTable([[deposito.lat,deposito.lng], ...esistentiValidi.map(r=>[r.lat,r.lng]), [ritiro.lat, ritiro.lng]]); }
  catch(e){ alert('Errore di calcolo distanze: '+e.message); return; }
  const durMin = table.durations.map(row=>row.map(v=>v/60));

  const capacitaM3 = parseFloat($('capacitaUtileM3').value) || CONFIG.defaults.capacitaUtileM3;
  const capacitaLineareM = parseFloat($('capacitaLineareM').value) || CONFIG.defaults.capacitaLineareM;
  const mlPerBancale = parseFloat($('metriLineariPerBancale').value) || CONFIG.defaults.metriLineariPerBancale;
  const tempoSostaMin = parseFloat($('tempoSosta').value) || CONFIG.defaults.tempoSostaMin;
  const tolleranzaMin = parseFloat($('tolleranzaRitardo').value) || CONFIG.defaults.tolleranzaRitardoMin;
  const fineTurnoMin = toMinutes($('fineTurno').value) || toMinutes(CONFIG.defaults.fineTurno);
  const maxAttesaMin = parseFloat($('maxAttesaMin').value) || CONFIG.defaults.maxAttesaMin;

  const suoiGiriConfermati = giriConfermati.filter(g => g.flottaId === driverId);
  const partenzaBase = suoiGiriConfermati.length
    ? Math.max(...suoiGiriConfermati.map(g=>g.partenzaMin+g.minuti))
    : toMinutes(driver.orarioPartenza);

  const ordinatiConCandidato = [...esistentiValidi, ritiro]
    .map(r => ({ ...r, _matIdx: esistentiValidi.includes(r) ? esistentiValidi.indexOf(r)+1 : esistentiValidi.length+1 }))
    .sort((a,b)=> toMinutes(a.orarioEntro||a.orario||'23:59') - toMinutes(b.orarioEntro||b.orario||'23:59'));

  const giri = costruisciGiriDriver(ordinatiConCandidato, durMin, partenzaBase, tempoSostaMin, maxAttesaMin);
  const giroDelCandidato = giri.find(g => g.stops.some(s=>s.ritiro.id===ritiro.id));
  const stopCandidato = giroDelCandidato.stops.find(s=>s.ritiro.id===ritiro.id);

  // il volume DICHIARATO è un vincolo fisico vero; il volume stimato dai bancali no —
  // per quello conta il pianale (ml), calibrato sul numero reale di posizioni pallet
  const volumeDichiaratoGiro = giroDelCandidato.stops.reduce((s,x)=> s + (x.ritiro.volumeDichiarato ? (x.ritiro.quantita||0) : 0), 0);
  const mlGiro = giroDelCandidato.stops.reduce((s,x)=> s+effectiveML(x.ritiro,capacitaM3,capacitaLineareM,mlPerBancale), 0);
  if(volumeDichiaratoGiro > capacitaM3){
    alert(`Non c'è spazio nel giro delle ${giroDelCandidato.partenzaTesto}: ${volumeDichiaratoGiro.toFixed(1)} m³ dichiarati supererebbero i ${capacitaM3} m³ del mezzo.`);
    return;
  }
  if(mlGiro > capacitaLineareM){
    alert(`Pianale pieno nel giro delle ${giroDelCandidato.partenzaTesto}: ${mlGiro.toFixed(1)} ml supererebbero i ${capacitaLineareM} ml disponibili.`);
    return;
  }
  const deadlineCand = (toMinutes(ritiro.orarioEntro) !== null) ? toMinutes(ritiro.orarioEntro) : fineTurnoMin;
  if(toMinutes(stopCandidato.arrivo) > deadlineCand + tolleranzaMin){
    alert(`${ritiro.cliente} chiude alle ${ritiro.orarioEntro || 'fine turno ' + fmtClock(fineTurnoMin)}, ma in questo giro ${driver.nome||'il mezzo'} arriverebbe solo alle ${stopCandidato.arrivo}.`);
    return;
  }
  if(driver.fineDisponibilita){
    const limite = toMinutes(driver.fineDisponibilita);
    const fineUltimoGiro = giri[giri.length-1].rientroMin;
    if(fineUltimoGiro > limite){
      if(!confirm(`${driver.nome||'Questo driver'} è disponibile solo fino alle ${driver.fineDisponibilita}, ma con questa assegnazione finirebbe alle ${fmtClock(fineUltimoGiro)}.\n\nAssegnare comunque?`)) return;
    }
  }

  ritiro.assegnaA = driverId;
  salva();
  await ricalcolaColonnaDriver(driver);
  ritiroSelezionatoId = null;
  renderTabellone();
  setStatus(`${ritiro.cliente} assegnato a ${driver.nome||'mezzo'}.`, false);
}

function togliAssegnazione(ritiroId){
  const r = ritiri.find(x=>x.id===ritiroId);
  if(!r) return;
  const driverId = r.assegnaA;
  r.assegnaA = null;
  salva();
  const driver = flotta.find(f=>f.id===driverId);
  if(driver) ricalcolaColonnaDriver(driver).then(renderTabellone);
  else renderTabellone();
}

function confermaGiroDriver(driverId, giroIndex){
  const driver = flotta.find(f=>f.id===driverId);
  if(!driver || !driver._routeCache) return;
  const giro = driver._routeCache.giri[giroIndex];
  if(!giro) return;
  if(!confirm(`Confermare questo giro di ${driver.nome||'mezzo'} (${giro.stops.length} tappe: ${giro.stops.map(s=>s.ritiro.cliente).join(', ')})? Non verrà più toccato.`)) return;

  giriConfermati.push({
    idConferma: confermaIdSeq++, flottaId: driverId, nome: driver.nome||'mezzo',
    stops: giro.stops, partenzaMin: giro.partenzaMin, minuti: giro.rientroMin - giro.partenzaMin,
    endLat: deposito.lat, endLng: deposito.lng,
    ritiriIds: giro.stops.map(s=>s.ritiro.id)
  });
  salva();
  // il ricalcolo del driver ora esclude automaticamente questi ritiri (sono confermati):
  // il "conferma" per lo STESSO giro non può più comparire, perché quel giro non esiste
  // più tra quelli attivi — questo impedisce fisicamente il doppio click
  ricalcolaTuttoLoStato();
}

// ---------------------------------------------------------------------------
// RENDERING — flotta e ritiri (sidebar)
// ---------------------------------------------------------------------------
function renderFlotta(){
  $('flottaCount').textContent = `(${flotta.length})`;
  $('flottaList').innerHTML = flotta.map((m,i) => `
    <div style="padding:6px 0;border-bottom:1px solid var(--border-soft);">
      <div style="display:flex;align-items:center;gap:8px;">
        <input type="text" data-mezzo-nome="${m.id}" value="${escapeHtml(m.nome||'')}" placeholder="Mezzo ${i+1} / autista" style="flex:1;">
        <input type="time" data-mezzo-orario="${m.id}" value="${m.orarioPartenza}" style="width:90px;" title="Orario di partenza">
        <button class="btn-danger" data-del-mezzo="${m.id}">×</button>
      </div>
      <div style="margin-top:4px;">
        <input type="time" data-mezzo-finedisp="${m.id}" value="${m.fineDisponibilita||''}" style="width:90px;" title="Disponibile fino alle (vuoto = tutto il turno)">
        <span style="font-size:10px;color:var(--text-dim);margin-left:6px;">disponibile fino alle (vuoto = tutto il turno)</span>
      </div>
    </div>
  `).join('');
  $('flottaList').querySelectorAll('[data-mezzo-nome]').forEach(inp=>{
    inp.addEventListener('change', ()=>{
      const m = flotta.find(x=>x.id===parseInt(inp.dataset.mezzoNome));
      if(m){ m.nome = inp.value.trim(); salva(); renderTabellone(); }
    });
  });
  $('flottaList').querySelectorAll('[data-mezzo-orario]').forEach(inp=>{
    inp.addEventListener('change', ()=>{
      const m = flotta.find(x=>x.id===parseInt(inp.dataset.mezzoOrario));
      if(m){ m.orarioPartenza = inp.value; salva(); ricalcolaColonnaDriver(m).then(renderTabellone); }
    });
  });
  $('flottaList').querySelectorAll('[data-mezzo-finedisp]').forEach(inp=>{
    inp.addEventListener('change', ()=>{
      const m = flotta.find(x=>x.id===parseInt(inp.dataset.mezzoFinedisp));
      if(m){ m.fineDisponibilita = inp.value; salva(); }
    });
  });
  $('flottaList').querySelectorAll('[data-del-mezzo]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      if(flotta.length<=1){ alert('Deve restare almeno un mezzo.'); return; }
      const id = parseInt(btn.dataset.delMezzo);
      if(ritiri.some(r=>r.assegnaA===id) && !confirm('Questo mezzo ha ritiri assegnati: verranno liberati. Continuare?')) return;
      ritiri.forEach(r=>{ if(r.assegnaA===id) r.assegnaA=null; });
      flotta = flotta.filter(m=>m.id!==id);
      renderFlotta(); salva();
      ricalcolaTuttoLoStato();
    });
  });
}

function renderRitiri(){
  $('ritiriCount').textContent = `(${ritiri.length})`;
  const scrollBox = $('ritiriScroll'), summary = $('fileSummary');
  if(ritiri.length === 0){ scrollBox.style.display='none'; summary.style.display='none'; return; }
  summary.style.display = 'flex';
  $('fileSummaryText').textContent = `${ritiri.length} ritiri · ${ritiri.reduce((s,r)=>s+r.quantita,0).toFixed(1)} m³ totali`;
  scrollBox.style.display = 'block';
  scrollBox.innerHTML = ritiri.map(r => `
    <div class="ritiro-row">
      <div class="rtop">
        <span class="${r.cittaSospetta?'geo-sospetta':(r.lat?(r.approssimato?'geo-approx':'geo-ok'):'geo-pending')}">●</span>
        <input type="text" data-rid="${r.id}" data-rfield="cliente" value="${escapeHtml(r.cliente)}" placeholder="Cliente">
        <button class="btn-danger" data-del="${r.id}">×</button>
      </div>
      <div class="manual-toggle" data-toggle-ritiro="${r.id}" style="margin:2px 0 0 20px;${r.bisognaOrario?'color:var(--danger);text-decoration:none;':''}">
        ${r.bisognaOrario ? '⏳ IN ATTESA DI ORARIO — click per impostare' : `${r.quantita.toFixed(1)}m³${r.biliciRichiesti?` · ${r.biliciRichiesti} bilici`:''} · ${r.orario||'—'}–${r.orarioEntro||'—'}${r.assegnaA ? ' · assegnato' : ''} · modifica`}
      </div>
      <div class="manual-form" id="ritiroDetail-${r.id}">
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
          <input type="number" step="0.1" class="rqty" data-rid="${r.id}" data-rfield="metriLineari" value="${r.metriLineari||0}" title="Metri lineari (0 = automatico)">
          <input type="number" step="0.5" class="rqty" data-rid="${r.id}" data-rfield="biliciRichiesti" value="${r.biliciRichiesti||0}" title="Bilici dedicati">
          <span class="rmeta" style="align-self:center;">m³ / ml / bilici</span>
        </div>
        ${r.bisognaOrario ? `<button class="btn-ghost" style="border:1px solid var(--ok);color:var(--ok);width:100%;" data-conferma-orario="${r.id}">✓ Conferma orario e sblocca</button>` : ''}
      </div>
    </div>
  `).join('');
  scrollBox.querySelectorAll('[data-toggle-ritiro]').forEach(t=>{
    t.addEventListener('click', ()=> $(`ritiroDetail-${t.dataset.toggleRitiro}`).classList.toggle('show'));
  });
  scrollBox.querySelectorAll('[data-del]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      ritiri = ritiri.filter(r => r.id !== parseInt(btn.dataset.del));
      salva();
      renderRitiri();
      ricalcolaTuttoLoStato();
    });
  });
  scrollBox.querySelectorAll('[data-conferma-orario]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const r = ritiri.find(x=>x.id===parseInt(btn.dataset.confermaOrario));
      if(!r) return;
      if(!r.orario && !r.orarioEntro){ alert('Imposta almeno un orario prima di confermare.'); return; }
      r.bisognaOrario = false;
      salva();
      renderRitiri();
      renderTabellone();
    });
  });
  scrollBox.querySelectorAll('[data-rfield]').forEach(inp=>{
    inp.addEventListener('change', ()=>{
      const r = ritiri.find(x=>x.id===parseInt(inp.dataset.rid));
      if(!r) return;
      const field = inp.dataset.rfield;
      let riaggiornaLista = false;
      if(['quantita','metriLineari','biliciRichiesti'].includes(field)){
        const v = parseFloat(inp.value);
        r[field] = isNaN(v) ? 0 : v;
        if(field === 'quantita' && v > 0) r.volumeDichiarato = true;
      } else {
        const val = inp.value.trim();
        const cambiaIndirizzo = ['indirizzo','cap','localita'].includes(field) && val !== (r[field]||'');
        r[field] = val;
        if((field === 'orario' || field === 'orarioEntro') && val && r.bisognaOrario){
          // basta UN orario per sbloccare: se manca l'altro, resta comunque libero da assegnare
          if(r.orario || r.orarioEntro){ r.bisognaOrario = false; riaggiornaLista = true; }
        }
        if(cambiaIndirizzo){ r.lat=null; r.lng=null; r.approssimato=false; r.cittaSospetta=false; r._geoFallita=false; }
      }
      salva();
      if(riaggiornaLista){ renderRitiri(); renderTabellone(); }
      else $('fileSummaryText').textContent = `${ritiri.length} ritiri · ${ritiri.reduce((s,x)=>s+x.quantita,0).toFixed(1)} m³ totali`;
    });
  });
}

// ---------------------------------------------------------------------------
// MAPPA — marker + tragitto reale (OSRM) per ogni giro attivo, colorati per driver
// ---------------------------------------------------------------------------
async function renderMappa(){
  if(!map) return;
  markersLayer.clearLayers();
  routeLinesLayer.clearLayers();
  if(deposito.lat){
    L.circleMarker([deposito.lat, deposito.lng], { radius:8, color:'#E8E6E0', weight:2, fillColor:'#14181C', fillOpacity:1 })
      .bindTooltip('Deposito').addTo(markersLayer);
  }
  for(let vi=0; vi<flotta.length; vi++){
    const d = flotta[vi];
    const colore = CONFIG.palette[vi % CONFIG.palette.length];
    const giri = (d._routeCache && d._routeCache.giri) || [];
    for(const g of giri){
      g.stops.forEach((s,i) => {
        L.circleMarker([s.ritiro.lat, s.ritiro.lng], {
          radius:7, color: s.late ? '#C75146' : '#14181C', weight: s.late?2.5:1.5, fillColor: colore, fillOpacity:1
        }).bindTooltip(`${d.nome||'mezzo'} #${i+1}: ${s.ritiro.cliente} — arrivo ${s.arrivo}`).addTo(markersLayer);
      });
      // il tragitto è quello STRADALE REALE (OSRM), lo stesso usato per i calcoli di orario —
      // qui lo disegniamo, non lo ricalcoliamo con criteri diversi
      try{
        const coords = [[deposito.lat,deposito.lng], ...g.stops.map(s=>[s.ritiro.lat,s.ritiro.lng]), [deposito.lat,deposito.lng]];
        const route = await osrmRoute(coords);
        L.geoJSON(route.geometry, { style:{ color: colore, weight:3, opacity:0.7 } }).addTo(routeLinesLayer);
      }catch(e){ /* disegno del tragitto opzionale, non blocca la mappa se fallisce */ }
    }
  }
  ritiriNonAssegnati().forEach(r=>{
    if(r.lat) L.circleMarker([r.lat, r.lng], { radius:5, color:'#5C6570', weight:1, fillColor:'#20272F', fillOpacity:1 })
      .bindTooltip(`${r.cliente} (non assegnato)`).addTo(markersLayer);
  });
}

// ---------------------------------------------------------------------------
// EVENTI UI
// ---------------------------------------------------------------------------
function wireUpTabs(){
  document.querySelectorAll('.tab-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
      btn.classList.add('active');
      $(`tab${btn.dataset.tab.charAt(0).toUpperCase()+btn.dataset.tab.slice(1)}`).classList.add('active');
    });
  });
  document.querySelectorAll('.main-tab-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('.main-tab-btn').forEach(b=>b.classList.remove('active'));
      document.querySelectorAll('.main-tab-panel').forEach(p=>p.classList.remove('active'));
      btn.classList.add('active');
      document.querySelector(`.main-tab-panel[data-maintabpanel="${btn.dataset.maintab}"]`).classList.add('active');
      if(btn.dataset.maintab === 'mappa'){ setTimeout(()=>{ map.invalidateSize(); renderMappa(); }, 50); }
    });
  });
}

function wireUpUI(){
  wireUpTabs();
  ['depositoVia','depositoCap','depositoCitta'].forEach(id=>{
    $(id).addEventListener('change', ()=>{
      deposito.via = $('depositoVia').value.trim();
      deposito.cap = $('depositoCap').value.trim();
      deposito.citta = $('depositoCitta').value.trim();
      deposito.lat = null; deposito.lng = null;
      setStatus("deposito da geolocalizzare (avviene alla prima assegnazione)", false);
      salva();
    });
  });

  const dropzone = $('dropzone'), fileInput = $('fileInput');
  dropzone.addEventListener('click', ()=> fileInput.click());
  fileInput.addEventListener('change', (e)=>{ if(e.target.files[0]) handleFile(e.target.files[0]); fileInput.value=''; });
  ['dragover','dragenter'].forEach(evt => dropzone.addEventListener(evt, (e)=>{ e.preventDefault(); dropzone.classList.add('drag'); }));
  ['dragleave','drop'].forEach(evt => dropzone.addEventListener(evt, (e)=>{ e.preventDefault(); dropzone.classList.remove('drag'); }));
  dropzone.addEventListener('drop', (e)=>{ const f=e.dataTransfer.files[0]; if(f) handleFile(f); });

  const dzFlotta = $('dropzoneFlotta'), fiFlotta = $('fileInputFlotta');
  dzFlotta.addEventListener('click', ()=> fiFlotta.click());
  fiFlotta.addEventListener('change', (e)=>{ if(e.target.files[0]) handleFileFlotta(e.target.files[0]); fiFlotta.value=''; });
  ['dragover','dragenter'].forEach(evt => dzFlotta.addEventListener(evt, (e)=>{ e.preventDefault(); dzFlotta.classList.add('drag'); }));
  ['dragleave','drop'].forEach(evt => dzFlotta.addEventListener(evt, (e)=>{ e.preventDefault(); dzFlotta.classList.remove('drag'); }));
  dzFlotta.addEventListener('drop', (e)=>{ const f=e.dataTransfer.files[0]; if(f) handleFileFlotta(f); });

  $('clearRitiriBtn').addEventListener('click', ()=>{
    if(confirm('Svuotare tutti i ritiri? Anche i giri confermati che li contengono verranno rimossi.')){
      ritiri = [];
      salva();
      renderRitiri();
      ricalcolaTuttoLoStato(); // ripulisce anche eventuali giri confermati orfani
    }
  });

  $('manualToggle').addEventListener('click', ()=> $('manualForm').classList.toggle('show'));
  $('addManualBtn').addEventListener('click', ()=>{
    const cliente = $('mCliente').value.trim();
    const indirizzo = $('mIndirizzo').value.trim();
    if(!cliente || !indirizzo){ alert('Compila almeno cliente e indirizzo.'); return; }
    const biliciRichiesti = parseFloat($('mBiliciRichiesti').value) || 0;
    const cap = $('mCap').value.trim(), localita = $('mLocalita').value.trim();
    const orario = $('mOrario').value, orarioEntro = $('mOrarioEntro').value;
    const quantitaInput = parseFloat($('mQuantita').value) || 0;
    const metriLineari = parseFloat($('mMetriLineari').value) || 0;

    const pezzi = contaPezzi(biliciRichiesti);
    if(pezzi >= 2){
      const interi = Math.floor(biliciRichiesti), fraz = biliciRichiesti - interi;
      const nuovi = [];
      for(let k=0;k<interi;k++) nuovi.push({ id: ritiroIdSeq++, cliente:`${cliente} (bilico ${k+1}/${pezzi})`, indirizzo, cap, localita,
        orario:'', orarioEntro:'', quantita:0, volumeDichiarato:false, metriLineari:0, bancaliStandard:0, biliciRichiesti:1, bisognaOrario:true, assegnaA:null, lat:null, lng:null, approssimato:false });
      if(fraz>1e-6) nuovi.push({ id: ritiroIdSeq++, cliente:`${cliente} (bilico ${pezzi}/${pezzi})`, indirizzo, cap, localita,
        orario:'', orarioEntro:'', quantita:0, volumeDichiarato:false, metriLineari:0, bancaliStandard:0, biliciRichiesti:fraz, bisognaOrario:true, assegnaA:null, lat:null, lng:null, approssimato:false });
      ritiri.push(...nuovi);
      salva();
      renderRitiri();
      renderTabellone();
      avviaCodaMaschereBilici(nuovi);
    } else {
      ritiri.push({ id: ritiroIdSeq++, cliente, indirizzo, cap, localita, orario, orarioEntro, quantita:quantitaInput, volumeDichiarato: quantitaInput>0, metriLineari,
        bancaliStandard:0, biliciRichiesti, bisognaOrario:false, assegnaA:null, lat:null, lng:null, approssimato:false });
      salva();
      renderRitiri();
      renderTabellone();
    }
    ['mCliente','mIndirizzo','mCap','mLocalita','mOrario','mOrarioEntro','mQuantita','mMetriLineari','mBiliciRichiesti'].forEach(id => $(id).value = '');
  });

  $('addMezzoBtn').addEventListener('click', ()=>{
    const ultimo = flotta[flotta.length-1];
    flotta.push({ id: mezzoIdSeq++, nome:'', orarioPartenza: ultimo?ultimo.orarioPartenza:CONFIG.defaults.primoMezzoOrarioPartenza, fineDisponibilita:'' });
    renderFlotta(); renderTabellone(); salva();
  });

  document.addEventListener('click', (e)=>{
    const confermaBtn = e.target.closest('[data-conferma-giro]');
    if(confermaBtn){
      confermaGiroDriver(parseInt(confermaBtn.dataset.confermaDriver), parseInt(confermaBtn.dataset.confermaGiro));
      return;
    }
    const un = e.target.closest('[data-tab-unassign]');
    if(un){ togliAssegnazione(parseInt(un.dataset.tabUnassign)); return; }

    const ritiroCard = e.target.closest('[data-tab-ritiro]');
    if(ritiroCard){
      const rid = parseInt(ritiroCard.dataset.tabRitiro);
      ritiroSelezionatoId = (ritiroSelezionatoId===rid) ? null : rid;
      renderTabellone();
      return;
    }
    const driverCol = e.target.closest('[data-tab-driver]');
    if(driverCol && ritiroSelezionatoId != null){
      tentaAssegnazione(ritiroSelezionatoId, parseInt(driverCol.dataset.tabDriver));
    }
  });
}

function applyDefaults(){
  const d = CONFIG.defaults;
  $('capacitaUtileM3').value = d.capacitaUtileM3;
  $('capacitaLineareM').value = d.capacitaLineareM;
  $('metriLineariPerBancale').value = d.metriLineariPerBancale;
  $('volumeBancale').value = d.volumeBancalePerM3;
  $('tempoSosta').value = d.tempoSostaMin;
  $('tolleranzaRitardo').value = d.tolleranzaRitardoMin;
  $('fineTurno').value = d.fineTurno;
  $('maxAttesaMin').value = d.maxAttesaMin;
}

function initMap(){
  map = L.map('map', { zoomControl:true }).setView([CONFIG.defaults.mapCenter.lat, CONFIG.defaults.mapCenter.lng], CONFIG.defaults.mapZoom);
  L.tileLayer(CONFIG.endpoints.osmTiles, { attribution:'&copy; OpenStreetMap contributors', maxZoom:18 }).addTo(map);
  markersLayer = L.layerGroup().addTo(map);
  routeLinesLayer = L.layerGroup().addTo(map);
}

// ---------------------------------------------------------------------------
// AVVIO
// ---------------------------------------------------------------------------
(async function init(){
  await loadConfig();
  applyDefaults();
  initMap();
  wireUpUI();
  carica();
  renderFlotta();
  renderRitiri();
  await ricalcolaTuttoLoStato();
})();
