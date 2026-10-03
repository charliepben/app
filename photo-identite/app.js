import {
  NORME, PX_MM, W, H, FONDS,
  geometrie, affinerCrane, cadrageAuto, transformation, appliquerTransfo, zoneUtile,
  rendrePhoto, mesures, angles, planche, jpeg, PLANCHE, versPhoto,
} from './photo.js';

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

function progression(etape, fraction = null, detail = '') {
  $('etape').textContent = etape;
  $('detail').textContent = detail;
  if (fraction !== null) $('barre').style.width = `${Math.round(fraction * 100)}%`;
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

const DEFAUTS = { dx: 0, dy: 0, rot: 0, crane: 0, lumiere: 0, ombres: 0.8, reflets: 0.6, temperature: 0, nettete: 0.35, fond: 'gris' };

// ---------------------------------------------------------------- Chargement des modeles
let landmarker = null;
async function chargerLandmarker() {
  if (landmarker) return landmarker;
  const { FaceLandmarker, FilesetResolver } = await import('./vendor/vision_bundle.mjs');
  const fileset = await FilesetResolver.forVisionTasks(MP_WASM);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: MP_MODELE, delegate },
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
    progress: (cle, fait, total) => onProgres?.(cle, fait, total),
  });
  let sortie;
  try {
    sortie = await segmentForeground(entree, config(navigator.gpu ? 'gpu' : 'cpu'));
  } catch (e) {
    if (!navigator.gpu) throw e;
    sortie = await segmentForeground(entree, config('cpu'));
  }
  const data = new Uint8ClampedArray(await sortie.arrayBuffer());
  const m = document.createElement('canvas'); m.width = w; m.height = h;
  m.getContext('2d').putImageData(new ImageData(data, w, h), 0, 0);
  const alphaEn = (p) => {
    const px = Math.round((p.x - zone.x) * k), py = Math.round((p.y - zone.y) * k);
    if (px < 0 || py < 0 || px >= w || py >= h) return 0;
    return data[(py * w + px) * 4 + 3];
  };
  return { canvas: m, alphaEn };
}

async function traiter(fichier) {
  erreur('');
  montrer('vue-progression');
  try {
    progression('Lecture de la photo…', 0.03);
    const source = await lireImage(fichier);

    progression('Recherche du visage…', 0.08, 'Chargement du modèle de repères du visage');
    const visage = await detecterVisage(source);
    if (!visage) throw new Error("Aucun visage n'a été trouvé. Prenez une photo de face, bien éclairée, la tête entière dans l'image.");

    const geo = geometrie(visage.pts);
    let auto = cadrageAuto(geo);
    const t0 = transformation(geo, { ...DEFAUTS, ...auto });
    const zone = zoneUtile(t0, source.width, source.height, 0.3);

    progression('Détourage…', 0.15, 'Chargement du modèle de détourage');
    const masque = await detourer(source, zone, (cle, fait, total) => {
      if (cle.includes('/models/')) {
        progression('Téléchargement du modèle de détourage (une seule fois)…', 0.15 + 0.7 * (fait / total),
          `${(fait / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} Mo`);
      } else if (fait === total) {
        progression('Détourage en cours…', 0.88, 'Quelques secondes');
      }
    });

    progression('Lumière et cadrage…', 0.95);
    affinerCrane(geo, masque.alphaEn);
    auto = cadrageAuto(geo);

    Object.assign(etat, {
      source, geo, masque: masque.canvas, zone,
      infos: { ...visage, hauteurTetePx: geo.menton - geo.crane },
      auto,
      reglages: { ...DEFAUTS, ...auto },
    });
    synchroniserCurseurs();
    montrer('vue-editeur');
    rendre();
  } catch (e) {
    console.error(e);
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
  x.lineWidth = 2.5;
  // Zone des yeux (ISO : 50 a 70 % de la hauteur depuis le bas)
  x.fillStyle = 'rgba(31,79,163,0.07)';
  x.fillRect(0, mm(NORME.hauteur * (1 - NORME.yeuxBasMax)), W, mm(NORME.hauteur * (NORME.yeuxBasMax - NORME.yeuxBasMin)));
  // Zone ou doit tomber le menton pour une tete de 32 a 36 mm
  x.fillStyle = 'rgba(23,128,61,0.16)';
  x.fillRect(0, mm(m.crane + NORME.teteMin), W, mm(NORME.teteMax - NORME.teteMin));
  // Axe vertical
  x.strokeStyle = 'rgba(31,79,163,0.55)'; x.setLineDash([10, 8]); x.beginPath(); x.moveTo(W / 2, 0); x.lineTo(W / 2, H); x.stroke();
  ligne(m.crane, '#1f4fa3', []);
  ligne(m.menton, '#17803d', []);
  ligne(m.yeux, 'rgba(31,79,163,0.5)', [4, 6]);
  x.setLineDash([]);

  // Points detectes : pupilles, menton, sommet de la tete
  const t = etat.rendu.t, geo = etat.geo;
  const point = (u, couleur, r = 9) => {
    const p = versPhoto(t, u);
    x.lineWidth = 3; x.strokeStyle = '#fff'; x.fillStyle = couleur;
    x.beginPath(); x.arc(p.x, p.y, r, 0, 2 * Math.PI); x.fill(); x.stroke();
  };
  for (const u of geo.yeux) point(u, '#1f4fa3', 7);
  point({ x: geo.mentonX, y: geo.menton }, '#17803d');
  point({ x: geo.centreX, y: t.craneU }, '#1f4fa3');

  // Etiquettes
  x.font = '600 26px -apple-system, Segoe UI, Roboto, sans-serif';
  const etiquette = (txt, y, couleur) => {
    const l = x.measureText(txt).width + 16;
    x.fillStyle = 'rgba(255,255,255,0.85)'; x.fillRect(10, y - 17, l, 32);
    x.fillStyle = couleur; x.fillText(txt, 18, y + 8);
  };
  etiquette(etat.geo.mode === 'silhouette' ? 'haut de la tête' : 'sommet du crâne', mm(m.crane), '#1f4fa3');
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

  const modes = {
    silhouette: 'Mesurée jusqu\'au haut de la tête détectée ; sous les cheveux, environ 1 mm de moins. Norme : 32 à 36 mm.',
    volume: 'Cheveux volumineux détectés : mesurée jusqu\'au crâne estimé sous les cheveux, comme le veut la norme (32 à 36 mm).',
    estime: 'Haut de la tête mal visible : crâne estimé d\'après les yeux et le menton. Vérifiez sur le gabarit. Norme : 32 à 36 mm.',
  };
  ajouter(m.tete >= NORME.teteMin && m.tete <= NORME.teteMax ? (geo.mode === 'estime' ? 'warn' : 'ok') : 'bad',
    `Hauteur de la tête : ${f(m.tete)} mm`, modes[geo.mode]);

  const yeux = m.yeuxBas;
  ajouter(yeux >= NORME.yeuxBasMin && yeux <= NORME.yeuxBasMax ? 'ok' : 'warn',
    `Ligne des yeux à ${Math.round(yeux * 100)} % de la hauteur`, 'Recommandé : entre 50 et 70 % depuis le bas.');

  ajouter(Math.abs(m.centre - NORME.largeur / 2) <= 1 ? 'ok' : 'warn', 'Visage centré horizontalement');

  ajouter(m.crane >= 0 ? 'ok' : 'bad', m.crane >= 0 ? 'Haut du crâne dans le cadre' : 'Le haut du crâne sort du cadre');

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
    const neutre = sourire < 0.35 && !bouche;
    ajouter(neutre ? 'ok' : 'bad', neutre ? 'Expression neutre, bouche fermée' : (sourire >= 0.35 ? 'Sourire détecté' : 'Bouche ouverte'),
      neutre ? '' : 'La norme exige une expression neutre, bouche fermée, sans sourire : reprenez la photo.');
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

  ajouter('ok', `Fond uni ${FONDS[etat.reglages.fond].nom.toLowerCase()}`, 'Fond remplacé, sans ombre portée (le blanc est interdit).');
  ajouter('info', 'À vérifier vous-même',
    'Pas de couvre-chef, cheveux hors des yeux, pas de reflet sur le visage ni sur d\'éventuelles lunettes (montures fines, ne cachant pas les yeux), photo de moins de 6 mois.');

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
  temperature: (v) => (Math.abs(v) < 0.01 ? 'neutre' : `${v > 0 ? '+' : ''}${Math.round(v * 100)}`),
  nettete: (v) => `${Math.round(v * 100)} %`,
};

function synchroniserCurseurs() {
  for (const [cle, fmt] of Object.entries(CURSEURS)) {
    $(`r-${cle}`).value = etat.reglages[cle];
    $(`o-${cle}`).textContent = fmt(+etat.reglages[cle]);
  }
  for (const input of document.querySelectorAll('input[name="fond"]')) input.checked = input.value === etat.reglages.fond;
}

for (const [cle, fmt] of Object.entries(CURSEURS)) {
  $(`r-${cle}`).addEventListener('input', (e) => {
    const v = +e.target.value;
    etat.reglages[cle] = v;
    $(`o-${cle}`).textContent = fmt(v);
    rendre();
  });
}

$('fonds').innerHTML = Object.entries(FONDS).map(([cle, f]) =>
  `<label><input type="radio" name="fond" value="${cle}"><span class="pastille" style="background:rgb(${f.rgb.join(',')})"></span>${f.nom}</label>`).join('');
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
  ap.addEventListener('pointerdown', (e) => {
    if (!etat.rendu) return;
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
    planche: new File([await jpeg(p, PLANCHE.dpi)], `photo-identite-10x15-${horodatage()}.jpg`, { type: 'image/jpeg' }),
    photo: new File([await jpeg(etat.rendu.canvas, 600)], `photo-identite-35x45-${horodatage()}.jpg`, { type: 'image/jpeg' }),
  };
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

$('btn-imprimer').addEventListener('click', async () => {
  const f = await fichiers();
  const url = URL.createObjectURL(f.planche);
  const w = window.open('', '_blank');
  if (!w) { telecharger(f.planche); return; }
  w.document.write(`<!DOCTYPE html><html><head><title>Planche 10x15</title><style>
    @page { size: ${PLANCHE.largeurMM}mm ${PLANCHE.hauteurMM}mm; margin: 0; }
    html, body { margin: 0; padding: 0; }
    img { width: ${PLANCHE.largeurMM}mm; height: ${PLANCHE.hauteurMM}mm; display: block; }
  </style></head><body><img src="${url}" onload="setTimeout(() => print(), 200)"></body></html>`);
  w.document.close();
});

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

// Pour les tests automatises
window.__photoIdentite = { etat, traiter };
