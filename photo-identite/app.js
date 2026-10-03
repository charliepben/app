import {
  NORME, PX_MM, W, H, FONDS,
  geometrie, affinerCrane, cadrageAuto, transformation, appliquerTransfo, zoneUtile,
  rendrePhoto, mesures, angles, planche, jpeg, PLANCHE, versPhoto, affinerMasque, nettoyerBords, dentsVisibles,
  NORMES, choisirNorme, repereNorme, places,
} from './photo.js';
import { initAlbum, garder, rafraichir as rafraichirAlbum } from './album.js';
import { MOTEURS, segmenter } from './detourage.js';

// Les modeles sont charges depuis les CDN officiels, puis gardes en cache.
const MP_VERSION = '1.0.1';
const MP_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const MP_MODELE = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const DETOURAGE_MODELE = 'isnet_fp16';
const COTE_MAX_SOURCE = 4000;   // au-dela, on reduit : inutile pour du 600 dpi
const COTE_MAX_DETOURAGE = 1600;

const $ = (id) => document.getElementById(id);
const vues = ['vue-accueil', 'vue-progression', 'vue-editeur'];
const montrer = (id) => vues.forEach((v) => $(v).classList.toggle('cache', v !== id));

function erreur(msg) {
  const e = $('erreur');
  e.textContent = msg;
  e.classList.toggle('cache', !msg);
}

// ---------------------------------------------------------------- Progression
// Deux barres : le telechargement des modeles (octets reels, une seule fois) et
// le traitement de la photo. Le detourage ne donne pas d'avancement : la barre
// avance selon la duree mesuree la fois precedente sur cet appareil, et ralentit
// a l'approche de la fin si le calcul dure plus que prevu.
const ETAPES = {   // part de la barre de traitement
  lecture: [0, 0.05],
  visage: [0.05, 0.15],
  detourage: [0.15, 0.85],
  finitions: [0.85, 1],
};
const progres = {
  fichiers: new Map(),    // cle -> [fait, total]
  etape: null, t0: 0, duree: 1, minuterie: null, valeur: 0,

  depart() {
    this.fichiers.clear();
    this.valeur = 0;
    $('bloc-telechargement').classList.add('cache');
    $('barre-traitement').style.width = '0%';
    $('pct-traitement').textContent = '0 %';
    for (const li of $('etapes').children) li.className = '';
    clearInterval(this.minuterie);
    this.minuterie = setInterval(() => this.animer(), 200);
  },
  fin() { clearInterval(this.minuterie); this.poser(1); },

  telechargement(cle, fait, total) {
    if (!total) return;
    const avant = this.fichiers.get(cle);
    this.fichiers.set(cle, [fait, total]);
    if (!avant && fait >= total) return;        // deja en cache : rien a montrer
    let f = 0, t = 0;
    for (const [a, b] of this.fichiers.values()) { f += a; t += b; }
    const bloc = $('bloc-telechargement');
    bloc.classList.remove('cache');
    $('barre-telechargement').style.width = `${(100 * f) / t}%`;
    $('pct-telechargement').textContent = `${Math.floor((100 * f) / t)} %`;
    $('detail-telechargement').textContent = f >= t
      ? `✓ ${(t / 1e6).toFixed(0)} Mo téléchargés, gardés sur le téléphone.`
      : `${(f / 1e6).toFixed(1).replace('.', ',')} / ${(t / 1e6).toFixed(0)} Mo — une seule fois, ensuite ils restent sur le téléphone.`;
    if (f < t) this.t0 = performance.now();      // le detourage ne demarre qu'apres
  },
  telechargeEnCours() {
    for (const [a, b] of this.fichiers.values()) if (a < b) return true;
    return false;
  },

  etapeDebut(nom, dureeEstimee = 1) {
    const lis = [...$('etapes').children];
    const i = lis.findIndex((li) => li.dataset.etape === nom);
    lis.forEach((li, k) => { li.className = k < i ? 'fait' : k === i ? 'en-cours' : ''; });
    this.etape = nom; this.t0 = performance.now(); this.duree = Math.max(0.5, dureeEstimee);
    this.poser(ETAPES[nom][0]);
  },
  animer() {
    if (!this.etape || this.telechargeEnCours()) return;
    const [a, b] = ETAPES[this.etape];
    const t = (performance.now() - this.t0) / 1000 / this.duree;
    // lineaire jusqu'a 85 % de l'etape a la duree prevue, puis de plus en plus lent
    const f = t < 1 ? 0.85 * t : 0.85 + 0.14 * (1 - Math.exp(-(t - 1) * 1.5));
    this.poser(a + (b - a) * f);
  },
  poser(v) {
    if (v < this.valeur) return;
    this.valeur = v;
    $('barre-traitement').style.width = `${(v * 100).toFixed(1)}%`;
    $('pct-traitement').textContent = `${Math.floor(v * 100)} %`;
  },
};

// Duree du detourage mesuree sur cet appareil, pour la prochaine estimation
const cleDuree = () => `photo-identite-duree-${moteurDetourage()}`;
function dureeDetourage() {
  try { return +localStorage.getItem(cleDuree()) || 20; } catch { return 20; }
}
function noterDureeDetourage(s) {
  try { localStorage.setItem(cleDuree(), String(Math.round(s * 10) / 10)); } catch { /* facultatif */ }
}

// Telechargement avec avancement (modele du visage)
async function telechargerAvecProgres(url, cle) {
  const rep = await fetch(url);
  if (!rep.ok) throw new Error(`Téléchargement impossible (${rep.status})`);
  const total = +rep.headers.get('content-length') || 0;
  if (!rep.body || !total) return new Uint8Array(await rep.arrayBuffer());
  const lecteur = rep.body.getReader();
  const morceaux = [];
  let fait = 0;
  for (;;) {
    const { done, value } = await lecteur.read();
    if (done) break;
    morceaux.push(value); fait += value.length;
    progres.telechargement(cle, fait, total);
  }
  progres.telechargement(cle, fait, fait);
  const buf = new Uint8Array(fait);
  let o = 0;
  for (const m of morceaux) { buf.set(m, o); o += m.length; }
  return buf;
}

// ---------------------------------------------------------------- Etat
const etat = {
  source: null,       // canvas de l'image d'origine (orientee, reduite)
  geo: null,
  masque: null,       // canvas du detourage (zone de la source)
  zone: null,
  infos: null,        // blendshapes, angles, nombre de visages
  auto: null,         // reglages automatiques
  reglages: null,
  rendu: null,
  avant: false,
};

const DEFAUTS = { dx: 0, dy: 0, rot: 0, crane: 0, lumiere: 0, ombres: 1, reflets: 0.6, meches: 0.8, temperature: 0, nettete: 0.35, fond: 'gris' };

// ---------------------------------------------------------------- Chargement des modeles
let landmarker = null;
async function chargerLandmarker() {
  if (landmarker) return landmarker;
  const { FaceLandmarker, FilesetResolver } = await import('./vendor/vision_bundle.mjs');
  const [fileset, modele] = await Promise.all([
    FilesetResolver.forVisionTasks(MP_WASM),
    telechargerAvecProgres(MP_MODELE, 'visage'),
  ]);
  const options = (delegate) => ({
    baseOptions: { modelAssetBuffer: modele, delegate },
    runningMode: 'IMAGE',
    numFaces: 3,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
  // CPU : sur une seule image c'est rapide, et le GPU donne parfois des repères
  // faux sur mobile.
  landmarker = await FaceLandmarker.createFromOptions(fileset, options('CPU'));
  return landmarker;
}

let detourage = null;
async function chargerDetourage() {
  if (!detourage) detourage = await import('./vendor/background-removal.mjs');
  return detourage;
}

// ---------------------------------------------------------------- Lecture de l'image
async function lireImage(fichier) {
  let img;
  try {
    img = await createImageBitmap(fichier, { imageOrientation: 'from-image' });
  } catch {
    img = await new Promise((ok, ko) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => ko(new Error("Ce fichier n'est pas une image lisible (le format HEIC n'est pas lu par tous les navigateurs : exportez en JPEG)."));
      i.src = URL.createObjectURL(fichier);
    });
  }
  const w0 = img.width, h0 = img.height;
  const k = Math.min(1, COTE_MAX_SOURCE / Math.max(w0, h0));
  const c = document.createElement('canvas');
  c.width = Math.round(w0 * k); c.height = Math.round(h0 * k);
  const x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  x.drawImage(img, 0, 0, c.width, c.height);
  if (img.close) img.close();
  return c;
}

// ---------------------------------------------------------------- Analyse
async function detecterVisage(source) {
  const lm = await chargerLandmarker();
  const k = Math.min(1, 1600 / Math.max(source.width, source.height));
  const c = document.createElement('canvas');
  c.width = Math.round(source.width * k); c.height = Math.round(source.height * k);
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  const res = lm.detect(c);
  const n = res.faceLandmarks?.length || 0;
  if (!n) return null;
  // Visage le plus grand
  let meilleur = 0, taille = -1;
  res.faceLandmarks.forEach((pts, i) => {
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const t = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    if (t > taille) { taille = t; meilleur = i; }
  });
  const pts = res.faceLandmarks[meilleur].map((p) => ({ x: p.x * source.width, y: p.y * source.height }));
  const bs = {};
  for (const cat of res.faceBlendshapes?.[meilleur]?.categories || []) bs[cat.categoryName] = cat.score;
  const mat = res.facialTransformationMatrixes?.[meilleur]?.data;
  return { pts, bs, angles: angles(mat), visages: n };
}

// Moteur de detourage : rmbg (BRIA RMBG-1.4, par defaut : le plus propre sur
// les cheveux, et son calcul tourne hors de l'ecran), isnet (IMG.LY) ou modnet
// (voir detourage.js). Choix par ?detourage=... dans l'adresse, garde ensuite.
const MOTEUR_DEFAUT = 'rmbg';
function moteurDetourage() {
  const valide = (m) => m === 'isnet' || !!MOTEURS[m];
  const demande = new URLSearchParams(location.search).get('detourage');
  try {
    if (demande && valide(demande)) localStorage.setItem('photo-identite-moteur', demande);
    const m = localStorage.getItem('photo-identite-moteur');
    return m && valide(m) ? m : MOTEUR_DEFAUT;
  } catch {
    return demande && valide(demande) ? demande : MOTEUR_DEFAUT;
  }
}

async function detourer(source, zone, onProgres) {
  const { segmentForeground } = await chargerDetourage();
  const k = Math.min(1, COTE_MAX_DETOURAGE / Math.max(zone.w, zone.h));
  const w = Math.max(1, Math.round(zone.w * k)), h = Math.max(1, Math.round(zone.h * k));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.imageSmoothingQuality = 'high';
  x.drawImage(source, zone.x, zone.y, zone.w, zone.h, 0, 0, w, h);
  const pixels = x.getImageData(0, 0, w, h).data;
  const entree = new Blob([pixels], { type: `image/x-rgba8;width=${w};height=${h}` });

  const config = (device) => ({
    model: DETOURAGE_MODELE,
    device,
    output: { format: 'image/x-rgba8' },
    proxyToWorker: true,   // calcul hors de l'ecran : la barre de progression reste fluide
    progress: (cle, fait, total) => onProgres?.(cle, fait, total),
  });
  let data;
  const moteur = moteurDetourage();
  if (moteur !== 'isnet') {
    const { ort } = await chargerDetourage();
    data = new Uint8ClampedArray(await segmenter(ort, moteur, pixels, w, h, (fait, total) => onProgres?.(`/models/${moteur}`, fait, total)));
    onProgres?.('fin', 1, 1);
  } else {
    let sortie;
    try {
      sortie = await segmentForeground(entree, config(navigator.gpu ? 'gpu' : 'cpu'));
    } catch (e) {
      if (!navigator.gpu) throw e;
      sortie = await segmentForeground(entree, config('cpu'));
    }
    data = new Uint8ClampedArray(await sortie.arrayBuffer());
  }
  affinerMasque(pixels, data, w, h);
  const m = document.createElement('canvas'); m.width = w; m.height = h;
  m.getContext('2d').putImageData(new ImageData(data, w, h), 0, 0);
  const alphaEn = (p) => {
    const px = Math.round((p.x - zone.x) * k), py = Math.round((p.y - zone.y) * k);
    if (px < 0 || py < 0 || px >= w || py >= h) return 0;
    return data[(py * w + px) * 4 + 3];
  };
  // Retire ce qui est colle au-dessus de la tete sans etre des cheveux
  // (coussin, dossier), puis remet le masque a jour.
  const nettoyer = (geo) => {
    const versU = (px, py) => geo.versR({ x: px / k + zone.x, y: py / k + zone.y });
    if (nettoyerBords(pixels, data, w, h, versU, geo)) {
      m.getContext('2d').putImageData(new ImageData(data, w, h), 0, 0);
    }
  };
  return { canvas: m, alphaEn, nettoyer };
}

// source : image deja lue (changement de norme). On ne relit pas le fichier :
// sur Android, un fichier choisi ou pris en photo n'est souvent plus lisible
// une fois le selecteur referme.
async function traiter(fichier, sourceDejaLue = null) {
  erreur('');
  montrer('vue-progression');
  try {
    progres.depart();
    progres.etapeDebut('lecture', 0.5);
    const source = sourceDejaLue || await lireImage(fichier);

    progres.etapeDebut('visage', landmarker ? 1 : 3);
    const visage = await detecterVisage(source);
    if (!visage) throw new Error("Aucun visage n'a été trouvé. Prenez une photo de face, bien éclairée, la tête entière dans l'image.");

    const geo = geometrie(visage.pts);
    let auto = cadrageAuto(geo);
    // Zone a detourer : le cadre le plus large possible, pas celui de la
    // premiere estimation. Le cadrage final peut reduire la tete (coiffure
    // haute, enfant) et les curseurs vont jusqu'a 32 mm : tout ce qui sortirait
    // de la zone detouree serait pris pour du fond (epaules coupees net).
    const tLarge = transformation({ ...geo, crane: Math.min(geo.crane, -1.2 * geo.menton) }, { ...DEFAUTS, tete: NORME.teteMin, marge: 7 });
    let zone = zoneUtile(tLarge, source.width, source.height, 0.3);

    progres.etapeDebut('detourage', dureeDetourage());
    const suivi = (cle, fait, total) => { if (cle !== 'fin') progres.telechargement(cle, fait, total); };
    const tDebut = performance.now();
    let masque = await detourer(source, zone, suivi);
    // duree du seul calcul (le telechargement remet t0 a jour tant qu'il dure)
    noterDureeDetourage((performance.now() - Math.max(tDebut, progres.t0)) / 1000);

    progres.etapeDebut('finitions', 2);
    await new Promise((ok) => setTimeout(ok, 30));   // laisse la barre s'afficher
    masque.nettoyer(geo);
    affinerCrane(geo, masque.alphaEn);
    repereNorme(geo);
    auto = cadrageAuto(geo);

    // Garde-fou : si le cadre final deborde quand meme de la zone detouree,
    // on refait le detourage sur une zone qui le contient.
    const tFinal = transformation(geo, { ...DEFAUTS, ...auto, tete: Math.min(auto.tete, NORME.teteMin) });
    const besoin = zoneUtile(tFinal, source.width, source.height, 0.12);
    if (besoin.x < zone.x || besoin.y < zone.y || besoin.x + besoin.w > zone.x + zone.w || besoin.y + besoin.h > zone.y + zone.h) {
      const x0 = Math.min(zone.x, besoin.x), y0 = Math.min(zone.y, besoin.y);
      zone = { x: x0, y: y0, w: Math.max(zone.x + zone.w, besoin.x + besoin.w) - x0, h: Math.max(zone.y + zone.h, besoin.y + besoin.h) - y0 };
      masque = await detourer(source, zone, suivi);
      masque.nettoyer(geo);
    }

    Object.assign(etat, {
      source, geo, masque: masque.canvas, zone,
      infos: { ...visage, hauteurTetePx: geo.menton - geo.crane, dents: dentsVisibles(source, visage.pts) },
      auto,
      reglages: { ...DEFAUTS, ...auto, fond: fondNorme() },
    });
    progres.fin();
    synchroniserCurseurs();
    $('garder-ok').classList.add('cache');
    $('garder-nom').value = '';
    montrer('vue-editeur');
    rendre();
  } catch (e) {
    console.error(e);
    clearInterval(progres.minuterie);
    montrer('vue-accueil');
    erreur(e?.message || String(e));
  }
}

// ---------------------------------------------------------------- Rendu
let rendeEnAttente = false, planchePlanifiee = null;
function rendre() {
  if (rendeEnAttente) return;
  rendeEnAttente = true;
  requestAnimationFrame(() => {
    rendeEnAttente = false;
    const { source, masque, zone, geo, reglages } = etat;
    if (!source) return;
    const rendu = rendrePhoto({ source, masque, zone, geo, reglages, fond: FONDS[reglages.fond].rgb });
    etat.rendu = rendu;
    dessinerApercu();
    dessinerGabarit();
    afficherControles();
    clearTimeout(planchePlanifiee);
    planchePlanifiee = setTimeout(majPlanche, 250);
  });
}

function dessinerApercu() {
  const c = $('photo');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  if (etat.avant) {
    x.fillStyle = '#888'; x.fillRect(0, 0, W, H);
    x.imageSmoothingQuality = 'high';
    appliquerTransfo(x, etat.rendu.t);
    x.drawImage(etat.source, 0, 0);
    x.setTransform(1, 0, 0, 1, 0, 0);
  } else {
    x.drawImage(etat.rendu.canvas, 0, 0);
  }
}

function dessinerGabarit() {
  const c = $('gabarit');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  if ($('btn-gabarit').getAttribute('aria-pressed') !== 'true') return;
  const m = mesures(etat.geo, etat.rendu.t);
  const mm = (v) => v * PX_MM;
  const ligne = (y, couleur, tirets = []) => {
    x.strokeStyle = couleur; x.setLineDash(tirets); x.beginPath(); x.moveTo(0, mm(y)); x.lineTo(W, mm(y)); x.stroke();
  };
  const e = W / 827;   // echelle : les reperes gardent la meme taille a l'ecran quelle que soit la norme
  x.lineWidth = 2.5 * e;
  // Zone des yeux (ISO : 50 a 70 % de la hauteur depuis le bas)
  x.fillStyle = 'rgba(31,79,163,0.07)';
  x.fillRect(0, mm(NORME.hauteur * (1 - NORME.yeuxBasMax)), W, mm(NORME.hauteur * (NORME.yeuxBasMax - NORME.yeuxBasMin)));
  // Zone ou doit tomber le menton pour une tete de 32 a 36 mm
  x.fillStyle = 'rgba(23,128,61,0.16)';
  x.fillRect(0, mm(m.crane + NORME.teteMin), W, mm(NORME.teteMax - NORME.teteMin));
  // Axe vertical
  x.strokeStyle = 'rgba(31,79,163,0.55)'; x.setLineDash([10 * e, 8 * e]); x.beginPath(); x.moveTo(W / 2, 0); x.lineTo(W / 2, H); x.stroke();
  ligne(m.crane, '#1f4fa3', []);
  ligne(m.menton, '#17803d', []);
  ligne(m.yeux, 'rgba(31,79,163,0.5)', [4, 6]);
  x.setLineDash([]);

  // Points detectes : pupilles, menton, sommet de la tete
  const t = etat.rendu.t, geo = etat.geo;
  const point = (u, couleur, r = 9 * e) => {
    const p = versPhoto(t, u);
    x.lineWidth = 3 * e; x.strokeStyle = '#fff'; x.fillStyle = couleur;
    x.beginPath(); x.arc(p.x, p.y, r, 0, 2 * Math.PI); x.fill(); x.stroke();
  };
  for (const u of geo.yeux) point(u, '#1f4fa3', 7);
  point({ x: geo.mentonX, y: geo.menton }, '#17803d');
  point({ x: geo.centreX, y: t.craneU }, '#1f4fa3');

  // Etiquettes
  x.font = `600 ${Math.round(26 * e)}px -apple-system, Segoe UI, Roboto, sans-serif`;
  const etiquette = (txt, y, couleur) => {
    const l = x.measureText(txt).width + 16 * e;
    x.fillStyle = 'rgba(255,255,255,0.85)'; x.fillRect(10 * e, y - 17 * e, l, 32 * e);
    x.fillStyle = couleur; x.fillText(txt, 18 * e, y + 8 * e);
  };
  etiquette(NORME.mesure === 'cheveux' || etat.geo.mode === 'silhouette' ? 'haut de la tête' : 'sommet du crâne', mm(m.crane), '#1f4fa3');
  etiquette(`menton · tête ${m.tete.toFixed(1).replace('.', ',')} mm`, mm(m.menton), '#17803d');
}

function majPlanche() {
  if (!etat.rendu) return;
  const p = planche(etat.rendu.canvas);
  p.toBlob((b) => {
    const img = $('planche');
    if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
    img.dataset.url = URL.createObjectURL(b);
    img.src = img.dataset.url;
  }, 'image/jpeg', 0.85);
}

// ---------------------------------------------------------------- Controles de conformite
function afficherControles() {
  const { infos, rendu, geo } = etat;
  const m = mesures(geo, rendu.t);
  const lignes = [];
  const ajouter = (niveau, titre, detail = '') => lignes.push({ niveau, titre, detail });
  const f = (v, d = 1) => v.toFixed(d).replace('.', ',');

  ajouter(infos.visages === 1 ? 'ok' : 'warn',
    infos.visages === 1 ? 'Un seul visage' : `${infos.visages} visages détectés`,
    infos.visages === 1 ? '' : 'Seul le plus grand est utilisé ; la personne doit être seule sur la photo.');

  const plage = `${f(NORME.teteMin)} à ${f(NORME.teteMax)} mm`;
  const modes = NORME.mesure === 'cheveux' ? {
    silhouette: `Mesurée du menton au haut des cheveux, comme le veut la norme américaine (${plage}).`,
    volume: `Mesurée du menton au haut des cheveux, comme le veut la norme américaine (${plage}).`,
    estime: `Haut de la tête mal visible : estimé d'après les yeux et le menton. Vérifiez sur le gabarit. Norme : ${plage}.`,
  } : {
    silhouette: `Mesurée jusqu'au haut de la tête détectée ; sous les cheveux, environ 1 mm de moins. Norme : ${plage}.`,
    volume: `Cheveux volumineux détectés : mesurée jusqu'au crâne estimé sous les cheveux, comme le veut la norme (${plage}).`,
    estime: `Haut de la tête mal visible : crâne estimé d'après les yeux et le menton. Vérifiez sur le gabarit. Norme : ${plage}.`,
  };
  ajouter(m.tete >= NORME.teteMin && m.tete <= NORME.teteMax ? (geo.mode === 'estime' ? 'warn' : 'ok') : 'bad',
    `Hauteur de la tête : ${f(m.tete)} mm`, modes[geo.mode]);

  const yeux = m.yeuxBas;
  ajouter(yeux >= NORME.yeuxBasMin && yeux <= NORME.yeuxBasMax ? 'ok' : 'warn',
    NORME.mesure === 'cheveux' ? `Yeux à ${f(yeux * NORME.hauteur)} mm du bas` : `Ligne des yeux à ${Math.round(yeux * 100)} % de la hauteur`,
    NORME.mesure === 'cheveux' ? `Norme : entre ${f(NORME.yeuxBasMin * NORME.hauteur)} et ${f(NORME.yeuxBasMax * NORME.hauteur)} mm.` : 'Recommandé : entre 50 et 70 % depuis le bas.');

  ajouter(Math.abs(m.centre - NORME.largeur / 2) <= 1 ? 'ok' : 'warn', 'Visage centré horizontalement');

  const quoi = NORME.mesure === 'cheveux' ? 'Haut de la tête' : 'Haut du crâne';
  ajouter(m.crane >= 0 ? 'ok' : 'bad', m.crane >= 0 ? `${quoi} dans le cadre` : `Le ${quoi.toLowerCase()} sort du cadre`);
  if (m.crane >= 0 && m.cheveux < -0.5) {
    ajouter('warn', 'Haut des cheveux coupé',
      'Admis par la norme, qui mesure le crâne et non la coiffure. Pour une photo plus jolie : reprenez-la à hauteur des yeux et à 1,5 m. Prise d\'en haut ou de près, le dessus de la tête paraît plus gros.');
  }

  const roulis = Math.abs((geo.angle * 180) / Math.PI);
  const a = infos.angles;
  if (a) {
    const face = Math.abs(a.lacet) <= 8 && Math.abs(a.tangage) <= 10;
    ajouter(face ? 'ok' : 'warn', face ? 'Tête de face' : 'Tête tournée ou penchée',
      `${face ? '' : 'Regardez droit l\'objectif, menton ni levé ni baissé. '}Inclinaison corrigée automatiquement : ${f(roulis)}°.`);
  }

  const bs = infos.bs;
  if (bs.eyeBlinkLeft !== undefined) {
    const ouverts = Math.max(bs.eyeBlinkLeft, bs.eyeBlinkRight) < 0.5;
    ajouter(ouverts ? 'ok' : 'bad', ouverts ? 'Yeux ouverts' : 'Yeux fermés ou plissés');
    const sourire = Math.max(bs.mouthSmileLeft || 0, bs.mouthSmileRight || 0);
    const bouche = (bs.jawOpen || 0) > 0.15;
    if (NORME.sourireAdmis) {
      // Etats-Unis : expression neutre ou sourire naturel, bouche fermee
      ajouter(bouche ? 'bad' : 'ok', bouche ? 'Bouche ouverte' : (sourire >= 0.35 ? 'Sourire naturel (admis)' : 'Expression neutre, bouche fermée'),
        bouche ? 'La norme demande la bouche fermée : reprenez la photo.' : '');
    } else {
      const neutre = sourire < 0.35 && !bouche;
      ajouter(neutre ? 'ok' : 'bad', neutre ? 'Expression neutre, bouche fermée' : (sourire >= 0.35 ? 'Sourire détecté' : 'Bouche ouverte'),
        neutre ? '' : 'La norme exige une expression neutre, bouche fermée, sans sourire : reprenez la photo.');
    }
  }

  // Dents : la bouche doit etre fermee (France) ; aux Etats-Unis le sourire
  // naturel est admis mais la bouche fermee reste demandee.
  if (infos.dents) {
    const d = infos.dents;
    if (d.visible) {
      ajouter('bad', 'Dents visibles',
        NORME.sourireAdmis ? 'La norme demande la bouche fermée, même en souriant : reprenez la photo lèvres jointes.'
          : 'Interdit : la bouche doit être fermée, sans sourire. Reprenez la photo lèvres jointes, visage détendu.');
    } else {
      ajouter(d.entrouverte ? 'warn' : 'ok', d.entrouverte ? 'Lèvres entrouvertes' : 'Dents non visibles, lèvres jointes',
        d.entrouverte ? 'Pas de dents visibles, mais la bouche paraît légèrement ouverte : mieux vaut lèvres jointes.' : '');
    }
  }

  const px = infos.hauteurTetePx;
  const besoin = (NORME.teteCible / 25.4) * 300;   // pixels de tete pour 300 dpi
  ajouter(px >= besoin ? 'ok' : px >= besoin * 0.7 ? 'warn' : 'bad',
    px >= besoin ? 'Résolution suffisante' : 'Résolution un peu faible',
    `${Math.round(px)} px de tête dans la photo d'origine (${Math.round(besoin)} px pour un tirage net). ${px >= besoin ? '' : 'Rapprochez-vous ou zoomez.'}`);

  ajouter(rendu.hors < 0.02 ? 'ok' : 'warn', rendu.hors < 0.02 ? 'Cadre complet' : 'Photo d\'origine trop serrée',
    rendu.hors < 0.02 ? '' : 'Le bas du cadre (épaules) manque dans la photo d\'origine : il est complété par le fond. Reculez un peu.');

  if (Math.abs(rendu.balance?.c || 0) > 0.05) {
    ajouter('ok', 'Dominante de couleur corrigée',
      rendu.balance.c > 0 ? 'Lumière jaune-orangée (lampe d\'intérieur) neutralisée.' : 'Lumière bleutée (ombre, écran) neutralisée.');
  }
  if (rendu.gain > 1.6) ajouter('warn', 'Photo d\'origine sombre', 'Éclaircie automatiquement ; une photo mieux éclairée donnera un rendu plus naturel.');

  if (NORME.id === 'us') {
    ajouter('ok', 'Fond blanc uni', 'Fond remplacé, sans ombre portée (blanc ou blanc cassé exigé).');
    ajouter('info', 'À vérifier vous-même',
      'Pas de lunettes (interdites depuis 2016), pas de couvre-chef, cheveux hors des yeux, pas de reflet sur le visage, photo de moins de 6 mois.');
  } else {
    ajouter('ok', `Fond uni ${FONDS[etat.reglages.fond].nom.toLowerCase()}`, 'Fond remplacé, sans ombre portée (le blanc est interdit).');
    ajouter('info', 'À vérifier vous-même',
      'Pas de couvre-chef, cheveux hors des yeux, pas de reflet sur le visage ni sur d\'éventuelles lunettes (montures fines, ne cachant pas les yeux), photo de moins de 6 mois.');
  }

  const symb = { ok: '✓', warn: '!', bad: '✕', info: 'i' };
  $('controles').innerHTML = lignes.map((l) =>
    `<li class="${l.niveau}"><span class="icone">${symb[l.niveau]}</span><div>${l.titre}${l.detail ? `<small>${l.detail}</small>` : ''}</div></li>`).join('');
  const pire = lignes.some((l) => l.niveau === 'bad') ? 'bad' : lignes.some((l) => l.niveau === 'warn') ? 'warn' : 'ok';
  const b = $('bilan');
  b.className = `bilan ${pire}`;
  b.textContent = { ok: 'Photo conforme aux critères vérifiables automatiquement.', warn: 'Conforme, avec des points d\'attention.', bad: 'Non conforme : voir les points en rouge.' }[pire];
}

// ---------------------------------------------------------------- Curseurs
const CURSEURS = {
  tete: (v) => `${v.toFixed(1).replace('.', ',')} mm`,
  crane: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1).replace('.', ',')} mm`,
  dy: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1).replace('.', ',')} mm`,
  dx: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1).replace('.', ',')} mm`,
  rot: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1).replace('.', ',')}°`,
  lumiere: (v) => `${v > 0 ? '+' : ''}${v.toFixed(2).replace('.', ',')}`,
  ombres: (v) => `${Math.round(v * 100)} %`,
  reflets: (v) => `${Math.round(v * 100)} %`,
  meches: (v) => `${Math.round(v * 100)} %`,
  temperature: (v) => (Math.abs(v) < 0.01 ? 'neutre' : `${v > 0 ? '+' : ''}${Math.round(v * 100)}`),
  nettete: (v) => `${Math.round(v * 100)} %`,
};

function synchroniserCurseurs() {
  for (const cle of Object.keys(CURSEURS)) {
    $(`r-${cle}`).value = etat.reglages[cle];
    afficherValeur(cle);
  }
  for (const input of document.querySelectorAll('input[name="fond"]')) input.checked = input.value === etat.reglages.fond;
}

// Reglages en boutons - / + (et pas en curseurs : sur telephone, faire
// defiler la page en passant le doigt sur un curseur le deplacait sans le
// vouloir). Maintenir le bouton appuye repete. « auto » = valeur choisie par
// l'appli.
const PAS = { tete: 0.2, crane: 0.2, dy: 0.2, dx: 0.2, rot: 0.2, lumiere: 0.05, ombres: 0.1, reflets: 0.1, meches: 0.1, temperature: 0.1, nettete: 0.1 };
const valeurAuto = (cle) => (etat.auto && cle in etat.auto ? etat.auto[cle] : DEFAUTS[cle]);
function afficherValeur(cle) {
  const v = +etat.reglages[cle];
  const auto = Math.abs(v - valeurAuto(cle)) < 1e-6;
  $(`o-${cle}`).innerHTML = `${CURSEURS[cle](v)}${auto ? ' <span class="auto">auto</span>' : ''}`;
}
function changer(cle, sens) {
  const input = $(`r-${cle}`);
  const v = Math.round((+etat.reglages[cle] + sens * PAS[cle]) * 1000) / 1000;
  const borne = Math.min(+input.max, Math.max(+input.min, v));
  if (borne === etat.reglages[cle]) return;
  etat.reglages[cle] = borne;
  input.value = borne;
  afficherValeur(cle);
  rendre();
}
for (const cle of Object.keys(CURSEURS)) {
  const input = $(`r-${cle}`);
  input.classList.add('cache');
  const sortie = $(`o-${cle}`);
  const boite = document.createElement('div');
  boite.className = 'pas-reglage';
  const bouton = (sens, texte, aria) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = texte; b.setAttribute('aria-label', aria);
    let repete = null, attente = null;
    const stop = () => { clearTimeout(attente); clearInterval(repete); attente = repete = null; };
    b.addEventListener('click', () => changer(cle, sens));
    b.addEventListener('pointerdown', () => { stop(); attente = setTimeout(() => { repete = setInterval(() => changer(cle, sens), 90); }, 450); });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, stop);
    return b;
  };
  boite.append(bouton(-1, '−', 'Moins'), sortie, bouton(1, '+', 'Plus'));
  input.parentNode.appendChild(boite);
}

function afficherFonds() {
  $('fonds').innerHTML = NORME.fonds.map((cle) => [cle, FONDS[cle]]).map(([cle, f]) =>
    `<label><input type="radio" name="fond" value="${cle}"><span class="pastille" style="background:rgb(${f.rgb.join(',')})"></span>${f.nom}</label>`).join('');
}
const fondNorme = () => (etat.reglages && NORME.fonds.includes(etat.reglages.fond) ? etat.reglages.fond : NORME.fonds[0]);
$('fonds').addEventListener('change', (e) => { etat.reglages.fond = e.target.value; rendre(); });

$('btn-reinit').addEventListener('click', () => {
  etat.reglages = { ...DEFAUTS, ...etat.auto, fond: etat.reglages.fond };
  synchroniserCurseurs();
  rendre();
});

$('btn-gabarit').addEventListener('click', (e) => {
  const b = e.currentTarget;
  b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
  dessinerGabarit();
});

const avant = (v) => { if (!etat.rendu || etat.avant === v) return; etat.avant = v; $('btn-avant').setAttribute('aria-pressed', String(v)); dessinerApercu(); };
$('btn-avant').addEventListener('pointerdown', () => avant(true));
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) $('btn-avant').addEventListener(ev, () => avant(false));
$('btn-avant').addEventListener('contextmenu', (e) => e.preventDefault());

$('btn-nouvelle').addEventListener('click', () => { montrer('vue-accueil'); });

// ---------------------------------------------------------------- Glisser l'apercu pour deplacer
{
  let depart = null;
  const ap = $('apercu');
  // seulement quand « Ajuster a la main » est ouvert : sinon, faire defiler
  // la page avec le doigt sur l'apercu deplacait la photo
  const actif = () => !!etat.rendu && $('ajuster').open;
  const majToucher = () => { ap.style.touchAction = actif() ? 'none' : 'pan-y'; ap.classList.toggle('deplacable', actif()); };
  $('ajuster').addEventListener('toggle', majToucher);
  majToucher();
  ap.addEventListener('pointerdown', (e) => {
    if (!actif()) return;
    depart = { x: e.clientX, y: e.clientY, dx: etat.reglages.dx, dy: etat.reglages.dy };
    ap.setPointerCapture(e.pointerId);
  });
  ap.addEventListener('pointermove', (e) => {
    if (!depart) return;
    const mmParPx = NORME.largeur / ap.clientWidth;
    const borne = (v) => Math.max(-3, Math.min(3, Math.round(v * 10) / 10));
    etat.reglages.dx = borne(depart.dx + (e.clientX - depart.x) * mmParPx);
    etat.reglages.dy = borne(depart.dy + (e.clientY - depart.y) * mmParPx);
    synchroniserCurseurs();
    rendre();
  });
  for (const ev of ['pointerup', 'pointercancel']) ap.addEventListener(ev, () => { depart = null; });
}

// ---------------------------------------------------------------- Exports
const horodatage = () => new Date().toISOString().slice(0, 10);

async function fichiers() {
  const p = planche(etat.rendu.canvas);
  return {
    planche: new File([await jpeg(p, PLANCHE.dpi)], `photo-identite-${NORME.id}-10x15-${horodatage()}.jpg`, { type: 'image/jpeg' }),
    photo: new File([await jpeg(etat.rendu.canvas, 600)], `photo-identite-${NORME.id === 'us' ? '2x2in' : '35x45'}-${horodatage()}.jpg`, { type: 'image/jpeg' }),
  };
}

// Impression d'une ou plusieurs planches, une par page 10x15
function imprimer(files) {
  const urlsPlanches = files.map((f) => URL.createObjectURL(f));
  const w = window.open('', '_blank');
  if (!w) { files.forEach(telecharger); return; }
  w.document.write(`<!DOCTYPE html><html><head><title>Planche 10x15</title><style>
    @page { size: ${PLANCHE.largeurMM}mm ${PLANCHE.hauteurMM}mm; margin: 0; }
    html, body { margin: 0; padding: 0; }
    img { width: ${PLANCHE.largeurMM}mm; height: ${PLANCHE.hauteurMM}mm; display: block; page-break-after: always; }
  </style></head><body>${urlsPlanches.map((u) => `<img src="${u}">`).join('')}
  <script>Promise.all([...document.images].map((i) => i.decode())).then(() => setTimeout(() => print(), 200));<\/script></body></html>`);
  w.document.close();
}

function telecharger(fichier) {
  const url = URL.createObjectURL(fichier);
  const a = document.createElement('a');
  a.href = url; a.download = fichier.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

$('btn-planche').addEventListener('click', async () => telecharger((await fichiers()).planche));
$('btn-photo').addEventListener('click', async () => telecharger((await fichiers()).photo));

if (navigator.canShare) {
  try {
    if (navigator.canShare({ files: [new File([new Blob(['x'], { type: 'image/jpeg' })], 'a.jpg', { type: 'image/jpeg' })] })) {
      $('btn-partager').classList.remove('cache');
    }
  } catch { /* partage de fichiers non pris en charge */ }
}
$('btn-partager').addEventListener('click', async () => {
  const f = await fichiers();
  try { await navigator.share({ files: [f.planche], title: 'Photo d\'identité 10×15' }); } catch { /* annule */ }
});

$('btn-imprimer').addEventListener('click', async () => imprimer([(await fichiers()).planche]));

// ---------------------------------------------------------------- Mes photos
$('form-garder').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!etat.rendu) return;
  const b = $('btn-garder');
  b.disabled = true;
  try {
    const nom = $('garder-nom').value;
    await garder(await jpeg(etat.rendu.canvas, 600), nom, NORME.id);
    await rafraichirAlbum();
    const ok = $('garder-ok');
    ok.textContent = `✓ Photo${nom.trim() ? ` de ${nom.trim()}` : ''} gardée dans « Mes photos », en bas de la page.`;
    ok.classList.remove('cache');
  } catch (err) {
    console.error(err);
    erreur("Impossible d'enregistrer la photo sur ce téléphone (mémoire pleine ou navigation privée ?).");
  } finally {
    b.disabled = false;
  }
});

let partageFichiers = null;
try {
  if (navigator.canShare?.({ files: [new File([new Blob(['x'], { type: 'image/jpeg' })], 'a.jpg', { type: 'image/jpeg' })] })) {
    partageFichiers = async (files) => { try { await navigator.share({ files, title: 'Planche photo d\'identité 10×15' }); } catch { /* annule */ } };
  }
} catch { /* partage de fichiers non pris en charge */ }
initAlbum({ telecharger, imprimer, partager: partageFichiers }).catch((err) => console.error('Mes photos indisponible', err));

// ---------------------------------------------------------------- Entree
function choisir(fichier) {
  if (!fichier) return;
  if (fichier.type && !fichier.type.startsWith('image/')) { erreur('Choisissez une image (JPEG, PNG…).'); return; }
  traiter(fichier);
}
for (const id of ['fichier', 'fichier-camera']) {
  $(id).addEventListener('change', (e) => { choisir(e.target.files[0]); e.target.value = ''; });
}
const depot = $('depot');
depot.addEventListener('dragover', (e) => { e.preventDefault(); depot.classList.add('survol'); });
depot.addEventListener('dragleave', () => depot.classList.remove('survol'));
depot.addEventListener('drop', (e) => { e.preventDefault(); depot.classList.remove('survol'); choisir(e.dataTransfer.files[0]); });

// ---------------------------------------------------------------- Norme
// France ou Etats-Unis : choix garde sur l'appareil. Changer de norme sur une
// photo en cours relance le traitement (cadrage et detourage different).
function appliquerNorme(id) {
  choisirNorme(id);
  try { localStorage.setItem('photo-identite-norme', NORME.id); } catch { /* facultatif */ }
  for (const b of document.querySelectorAll('#normes button')) b.setAttribute('aria-checked', String(b.dataset.norme === NORME.id));
  $('sous-titre').textContent = `${NORME.id === 'us' ? 'Norme américaine (passeport, visa)' : 'Norme française'} (${NORME.ref}) · ${NORME.format} · planche 10 × 15 prête à imprimer`;
  document.querySelector('.apercu').style.aspectRatio = `${NORME.largeur} / ${NORME.hauteur}`;
  const t = $('r-tete');
  t.min = NORME.teteMin; t.max = NORME.teteMax;
  const n = places();
  $('titre-planche').textContent = `Planche 10 × 15 — ${n} photo${n > 1 ? 's' : ''}`;
  $('largeur-regle').textContent = NORME.id === 'us' ? '51 mm (2 pouces)' : '35 mm';
  $('lib-crane').textContent = NORME.mesure === 'cheveux' ? 'Repère du haut de la tête' : 'Repère du sommet du crâne';
  $('note-repere').textContent = NORME.mesure === 'cheveux'
    ? 'Le repère bleu doit toucher le haut des cheveux : la norme américaine mesure la tête du menton au haut des cheveux (25 à 35 mm).'
    : 'Le repère bleu doit toucher le haut de la tête, sans compter les cheveux qui dépassent (volume, chignon) : c\'est de là que se mesurent les 32 à 36 mm jusqu\'au menton.';
  afficherFonds();
}
let normeInitiale = 'fr';
try { normeInitiale = localStorage.getItem('photo-identite-norme') || 'fr'; } catch { /* facultatif */ }
appliquerNorme(normeInitiale);
$('normes').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-norme]');
  if (!b || b.dataset.norme === NORME.id) return;
  appliquerNorme(b.dataset.norme);
  if (etat.source && !$('vue-editeur').classList.contains('cache')) traiter(null, etat.source);
});

// Pour les tests automatises
window.__photoIdentite = { etat, traiter };
