// Mes photos : les photos validees sont gardees sur l'appareil (IndexedDB, rien
// n'est envoye), et on compose des planches 10x15 en choisissant combien de
// chaque photo y mettre. Plusieurs personnes peuvent partager une planche.

import { planche, jpeg, PLANCHE } from './photo.js';

const BASE = 'photo-identite', TABLE = 'photos';
const PLACES = PLANCHE.cols * PLANCHE.rangs;   // 8 emplacements par planche

// ---------------------------------------------------------------- Stockage
function ouvrir() {
  return new Promise((ok, ko) => {
    const req = indexedDB.open(BASE, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(TABLE, { keyPath: 'id' });
    req.onsuccess = () => ok(req.result);
    req.onerror = () => ko(req.error);
  });
}

async function table(mode, action) {
  const db = await ouvrir();
  return new Promise((ok, ko) => {
    const tx = db.transaction(TABLE, mode);
    const req = action(tx.objectStore(TABLE));
    tx.oncomplete = () => { db.close(); ok(req?.result); };
    tx.onerror = () => { db.close(); ko(tx.error); };
  });
}

export const lister = async () => ((await table('readonly', (t) => t.getAll())) || []).sort((a, b) => b.date - a.date);
const enregistrer = (photo) => table('readwrite', (t) => t.put(photo));
const supprimer = (id) => table('readwrite', (t) => t.delete(id));

export async function garder(blob, nom) {
  // demande au navigateur de ne pas effacer ces donnees pour faire de la place
  try { await navigator.storage?.persist?.(); } catch { /* facultatif */ }
  const photo = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, nom: nom.trim(), date: Date.now(), blob };
  await enregistrer(photo);
  return photo;
}

// ---------------------------------------------------------------- Interface
const $ = (id) => document.getElementById(id);
const echapper = (t) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let photos = [];
const urls = new Map();          // id -> URL de la vignette
let quantites = {};              // id -> nombre d'exemplaires sur la planche
try { quantites = JSON.parse(localStorage.getItem('photo-identite-quantites') || '{}'); } catch { /* vide */ }
const memoriser = () => { try { localStorage.setItem('photo-identite-quantites', JSON.stringify(quantites)); } catch { /* facultatif */ } };

let outils = null;   // { telecharger(file), imprimer(files), partager(files) | null }

export async function initAlbum(o) {
  outils = o;
  $('album-liste').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-action]');
    if (!b) return;
    const id = b.closest('li').dataset.id;
    const action = b.dataset.action;
    if (action === 'plus' || action === 'moins') {
      quantites[id] = Math.min(PLACES * 4, Math.max(0, (quantites[id] || 0) + (action === 'plus' ? 1 : -1)));
      b.closest('li').querySelector('output').textContent = quantites[id];
      memoriser();
      afficherPlanches();
      return;
    }
    if (action === 'supprimer') {
      const p = photos.find((x) => x.id === id);
      if (!confirm(`Supprimer la photo${p?.nom ? ` de ${p.nom}` : ''} ?`)) return;
      await supprimer(id);
      delete quantites[id];
    }
    memoriser();
    await rafraichir();
  });
  $('album-liste').addEventListener('change', async (e) => {
    if (!e.target.matches('input[data-nom]')) return;
    const p = photos.find((x) => x.id === e.target.closest('li').dataset.id);
    if (!p) return;
    p.nom = e.target.value.trim();
    await enregistrer(p);
    afficherPlanches();
  });
  $('album-remplir').addEventListener('click', () => {
    // repartit les 8 emplacements entre les photos choisies (ou toutes)
    const choisies = photos.filter((p) => quantites[p.id] > 0);
    const liste = choisies.length ? choisies : photos;
    liste.forEach((p, i) => { quantites[p.id] = Math.floor(PLACES / liste.length) + (i < PLACES % liste.length ? 1 : 0); });
    memoriser();
    rafraichir();
  });
  $('album-vider').addEventListener('click', () => { quantites = {}; memoriser(); rafraichir(); });
  $('album-noms').addEventListener('change', afficherPlanches);
  $('album-telecharger').addEventListener('click', async () => { for (const f of await fichiersPlanches()) outils.telecharger(f); });
  $('album-imprimer').addEventListener('click', async () => outils.imprimer(await fichiersPlanches()));
  if (outils.partager) {
    $('album-partager').classList.remove('cache');
    $('album-partager').addEventListener('click', async () => outils.partager(await fichiersPlanches()));
  }
  await rafraichir();
}

export async function rafraichir() {
  photos = await lister();
  for (const [id, url] of urls) if (!photos.some((p) => p.id === id)) { URL.revokeObjectURL(url); urls.delete(id); }
  for (const p of photos) if (!urls.has(p.id)) urls.set(p.id, URL.createObjectURL(p.blob));
  for (const id of Object.keys(quantites)) if (!photos.some((p) => p.id === id)) delete quantites[id];

  $('album').classList.toggle('cache', photos.length === 0);
  const n = photos.length;
  $('album-compte').textContent = `${n} photo${n > 1 ? 's' : ''}`;
  const date = (t) => new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
  $('album-liste').innerHTML = photos.map((p) => `
    <li data-id="${p.id}">
      <img src="${urls.get(p.id)}" alt="">
      <div class="album-infos">
        <input data-nom type="text" value="${echapper(p.nom || '')}" placeholder="Prénom" aria-label="Prénom">
        <small>${date(p.date)}</small>
      </div>
      <div class="pas">
        <button data-action="moins" aria-label="Une de moins">−</button>
        <output>${quantites[p.id] || 0}</output>
        <button data-action="plus" aria-label="Une de plus">+</button>
      </div>
      <button class="lien" data-action="supprimer" aria-label="Supprimer">Supprimer</button>
    </li>`).join('');
  afficherPlanches();
}

// Emplacements dans l'ordre de la liste : chaque personne regroupee.
function emplacements() {
  const liste = [];
  for (const p of photos) for (let k = 0; k < (quantites[p.id] || 0); k++) liste.push(p);
  return liste;
}

let images = new Map();   // id -> HTMLImageElement decodee
async function image(p) {
  if (!images.has(p.id)) {
    const img = new Image();
    img.src = urls.get(p.id);
    await img.decode();
    images.set(p.id, img);
  }
  return images.get(p.id);
}

async function canvasPlanches() {
  const liste = emplacements();
  const noms = $('album-noms').checked;
  const res = [];
  for (let d = 0; d < liste.length; d += PLACES) {
    const lot = liste.slice(d, d + PLACES);
    const cases = [];
    for (let i = 0; i < PLACES; i++) cases.push(lot[i] ? { image: await image(lot[i]), nom: noms ? lot[i].nom : '' } : null);
    res.push(planche(cases));
  }
  return res;
}

let tour = 0;
async function afficherPlanches() {
  const moi = ++tour;
  const total = emplacements().length;
  const nb = Math.ceil(total / PLACES);
  $('album-total').textContent = total
    ? `${total} photo${total > 1 ? 's' : ''} → ${nb} planche${nb > 1 ? 's' : ''} 10×15${total % PLACES ? ` (${PLACES - (total % PLACES)} emplacement${PLACES - (total % PLACES) > 1 ? 's' : ''} vide${PLACES - (total % PLACES) > 1 ? 's' : ''})` : ''}`
    : 'Choisissez combien de chaque photo mettre sur la planche avec + et −.';
  for (const id of ['album-telecharger', 'album-imprimer', 'album-partager']) $(id).disabled = !total;
  const conteneur = $('album-planches');
  if (!total) { conteneur.innerHTML = ''; return; }
  const canvases = await canvasPlanches();
  if (moi !== tour) return;
  conteneur.innerHTML = '';
  for (const c of canvases) {
    const img = document.createElement('img');
    img.alt = 'Planche 10 × 15';
    img.src = c.toDataURL('image/jpeg', 0.8);
    conteneur.appendChild(img);
  }
}

async function fichiersPlanches() {
  const canvases = await canvasPlanches();
  const jour = new Date().toISOString().slice(0, 10);
  const files = [];
  for (let i = 0; i < canvases.length; i++) {
    const suffixe = canvases.length > 1 ? `-${i + 1}` : '';
    files.push(new File([await jpeg(canvases[i], PLANCHE.dpi)], `planche-10x15-${jour}${suffixe}.jpg`, { type: 'image/jpeg' }));
  }
  return files;
}
