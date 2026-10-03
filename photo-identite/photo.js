// Traitement d'image pour la photo d'identite : geometrie du visage, cadrage
// aux normes ANTS (ISO/IEC 19794-5), lumiere, fond, planche 10x15.
// Aucune dependance : ce module ne fait que du calcul sur des canvas.

// ---------------------------------------------------------------- Normes
// Photo 35 x 45 mm. Tete (menton -> sommet du crane, HORS chevelure) : 32 a 36 mm.
// Fond uni et clair, blanc interdit. Yeux : 50 a 70 % de la hauteur depuis le bas.
export const NORME = {
  largeur: 35,
  hauteur: 45,
  teteMin: 32,
  teteMax: 36,
  teteCible: 34,
  teteSilhouette: 35, // repere = haut visible de cheveux courts ou plaques
  teteVolume: 34.5,   // repere = crane estime sous des cheveux qui depassent
  margeHaut: 3.5,      // sommet du crane -> bord haut, par defaut
  margeHautMax: 5,     // au-dela, les yeux passent sous 50 % de la hauteur
  yeuxBasMin: 0.5,     // ligne des yeux, en fraction de la hauteur depuis le bas
  yeuxBasMax: 0.7,
};

export const DPI_TRAVAIL = 600;
export const PX_MM = DPI_TRAVAIL / 25.4;
export const W = Math.round(NORME.largeur * PX_MM);   // 827
export const H = Math.round(NORME.hauteur * PX_MM);   // 1063

export const FONDS = {
  gris: { nom: 'Gris clair', rgb: [214, 216, 219] },
  bleu: { nom: 'Bleu clair', rgb: [200, 219, 236] },
};

// Points du maillage MediaPipe Face Landmarker (478 points).
const IRIS_A = 468, IRIS_B = 473, MENTON = 152, FRONT = 10;
export const OVALE = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379,
  378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];

// Sommet de la tete, en fraction de la distance pupilles -> menton (point 152)
// au-dessus des pupilles. Le crane (sans cheveux) tombe entre 0,8 et 0,95.
const K_CRANE = 0.85;      // estimation quand la silhouette est inutilisable
const K_PLAFOND = 0.9;     // au-dessus, ce sont des cheveux qui depassent
const K_SILHOUETTE_MIN = 0.7;

// ---------------------------------------------------------------- Geometrie
const rot = (x, y, a) => ({ x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) });

// pts : 478 points en pixels de l'image source. Renvoie un repere "redresse" :
// origine entre les pupilles, axe x le long des yeux, unites = pixels source.
export function geometrie(pts) {
  let a = pts[IRIS_A], b = pts[IRIS_B];
  if (a.x > b.x) [a, b] = [b, a];
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const pivot = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const versR = (p) => rot(p.x - pivot.x, p.y - pivot.y, -angle);
  const versS = (u) => { const r = rot(u.x, u.y, angle); return { x: r.x + pivot.x, y: r.y + pivot.y }; };

  const menton = versR(pts[MENTON]);
  const front = versR(pts[FRONT]);
  const ovale = OVALE.map((i) => versR(pts[i]));
  const xs = ovale.map((p) => p.x);
  const gauche = Math.min(...xs), droite = Math.max(...xs);
  const crane = -K_CRANE * menton.y;

  return {
    angle, pivot, versR, versS,
    menton: menton.y,
    front: front.y,
    craneEstime: crane,
    crane,                     // affine ensuite avec le detourage
    hautCheveux: crane,
    mode: 'estime',
    yeux: [versR(a), versR(b)],
    mentonX: menton.x,
    centreX: (gauche + droite) / 2,
    largeurVisage: droite - gauche,
    ecartYeux: Math.hypot(b.x - a.x, b.y - a.y),
    ovale,
  };
}

// Trouve le sommet de la tete sur le detourage. On part du front (dans le
// visage, donc opaque) et on monte colonne par colonne jusqu'a sortir de la
// silhouette : un objet du decor detoure par erreur au-dessus ne gene pas.
// alphaEnSource(p) : opacite (0-255) du detourage au point p de l'image source.
//
// Norme : tete mesuree « du menton au sommet du crane, hors cheveux qui
// depassent ». Trois cas :
//  - silhouette plausible (cheveux courts ou plaques, crane rase) : c'est le
//    haut de la tete visible qui sert de repere ;
//  - silhouette trop haute (volume, chignon) : on revient a l'anatomie ;
//  - silhouette introuvable ou trop basse : estimation anatomique.
export function affinerCrane(geo, alphaEnSource) {
  const hTete = geo.menton - geo.craneEstime;
  const alphaEn = (u) => alphaEnSource(geo.versS(u));
  const pas = Math.max(0.5, hTete / 400);
  const sortie = Math.max(2, Math.round(hTete * 0.015 / pas));   // ~1,5 % de la tete hors masque = bord
  const plafond = -1.6 * geo.menton;
  const hauts = [];
  for (let k = -4; k <= 4; k++) {
    const x = geo.centreX + (k / 4) * geo.largeurVisage * 0.22;
    if (alphaEn({ x, y: geo.front }) <= 128) continue;
    let y = geo.front, dehors = 0, haut = null;
    while (y > plafond) {
      y -= pas;
      if (alphaEn({ x, y }) > 128) { dehors = 0; haut = y; } else if (++dehors >= sortie) break;
    }
    if (haut !== null && y > plafond) hauts.push(haut);
  }
  if (hauts.length < 5) { geo.mode = 'estime'; return geo; }
  hauts.sort((p, q) => p - q);
  const haut = hauts[Math.floor(hauts.length / 2)];
  const k = -haut / geo.menton;
  geo.hautCheveux = haut;
  if (k < K_SILHOUETTE_MIN) { geo.mode = 'estime'; return geo; }
  geo.mode = k <= K_PLAFOND ? 'silhouette' : 'volume';
  geo.crane = -Math.min(k, K_PLAFOND) * geo.menton;
  // Taille visee : 35 mm quand le repere est le haut visible de cheveux courts
  // (le crane est ~1 mm dessous) ; 34,5 mm quand il est plafonne, ce qui centre
  // la tolerance pour un crane reel entre 0,8 et 0,95.
  const f = Math.min(1, Math.max(0, (k - 0.85) / (K_PLAFOND - 0.85)));
  geo.teteCible = NORME.teteSilhouette + (NORME.teteVolume - NORME.teteSilhouette) * f;
  return geo;
}

// ---------------------------------------------------------------- Cadrage
// Choisit taille de tete et marge haute pour que la tete fasse 34 mm, que les
// cheveux ne soient pas coupes si possible, et que les yeux restent dans la zone.
export function cadrageAuto(geo) {
  // Taille choisie par affinerCrane selon le repere (voir plus haut). Les
  // cheveux qui depassent encore sont coupes par le bord, ce qui est admis.
  const hTeteU = geo.menton - geo.crane;
  const cheveuxU = Math.max(0, geo.crane - geo.hautCheveux);
  const tete = geo.teteCible ?? NORME.teteCible;
  const marge = Math.min(NORME.margeHautMax, Math.max(NORME.margeHaut, cheveuxU * (tete / hTeteU) + 0.6));
  return { tete, marge };
}

// Transformation source -> photo (pixels de travail), avec les reglages manuels.
// r : { tete (mm), marge (mm), dx (mm), dy (mm), rot (degres), crane (mm de correction) }
export function transformation(geo, r) {
  const crane = geo.crane - (r.crane || 0) * ((geo.menton - geo.crane) / r.tete);
  const hTeteU = geo.menton - crane;
  const s = (r.tete * PX_MM) / hTeteU;
  const angle = geo.angle + ((r.rot || 0) * Math.PI) / 180;
  const tx = W / 2 + (r.dx || 0) * PX_MM - s * geo.centreX;
  const ty = r.marge * PX_MM + (r.dy || 0) * PX_MM - s * crane;
  return { s, angle, drot: angle - geo.angle, tx, ty, pivot: geo.pivot, craneU: crane };
}

export function appliquerTransfo(ctx, t) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.translate(t.tx, t.ty);
  ctx.scale(t.s, t.s);
  ctx.rotate(-t.angle);
  ctx.translate(-t.pivot.x, -t.pivot.y);
}

// Repere redresse -> pixels de la photo
export function versPhoto(t, u) {
  const r = rot(u.x, u.y, -t.drot);
  return { x: t.tx + t.s * r.x, y: t.ty + t.s * r.y };
}

// Pixels de la photo -> pixels de l'image source
export function depuisPhoto(t, x, y) {
  const r = rot((x - t.tx) / t.s, (y - t.ty) / t.s, t.angle);
  return { x: r.x + t.pivot.x, y: r.y + t.pivot.y };
}

// Rectangle de la source a detourer : le cadre de la photo, elargi pour laisser
// de la marge aux reglages manuels.
export function zoneUtile(t, imgW, imgH, marge = 0.25) {
  const mx = W * marge, my = H * marge;
  const coins = [[-mx, -my], [W + mx, -my], [-mx, H + my], [W + mx, H + my]].map(([x, y]) => depuisPhoto(t, x, y));
  const x0 = Math.max(0, Math.floor(Math.min(...coins.map((c) => c.x))));
  const y0 = Math.max(0, Math.floor(Math.min(...coins.map((c) => c.y))));
  const x1 = Math.min(imgW, Math.ceil(Math.max(...coins.map((c) => c.x))));
  const y1 = Math.min(imgH, Math.ceil(Math.max(...coins.map((c) => c.y))));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ---------------------------------------------------------------- Outils image
// Flou de boite separable (3 passes ~ gaussienne), sur un Float32Array w*h.
function flouBoite(src, w, h, r, tmp) {
  r = Math.max(1, Math.round(r));
  const out = tmp || new Float32Array(w * h);
  const norm = 1 / (2 * r + 1);
  // horizontal src -> out
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[o + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      out[o + x] = acc * norm;
      acc += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)];
    }
  }
  // vertical out -> src
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += out[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      src[y * w + x] = acc * norm;
      acc += out[Math.min(h - 1, y + r + 1) * w + x] - out[Math.max(0, y - r) * w + x];
    }
  }
  return src;
}

export function flou(arr, w, h, sigma) {
  // 3 boites de rayon r ~ gaussienne de sigma
  const r = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2));
  const tmp = new Float32Array(w * h);
  for (let i = 0; i < 3; i++) flouBoite(arr, w, h, r, tmp);
  return arr;
}

const lin = new Float32Array(256).map((_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
const versSRGB = (v) => { v = v <= 0 ? 0 : v >= 1 ? 1 : v; return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055); };

function percentile(valeurs, p) {
  if (!valeurs.length) return 0;
  const tri = Float32Array.from(valeurs).sort();
  return tri[Math.min(tri.length - 1, Math.floor(p * tri.length))];
}

// ---------------------------------------------------------------- Rendu
// source : canvas/bitmap de l'image entiere ; masque : canvas du detourage
// (zone source {x,y}) ; reglages : voir app. Renvoie un canvas W x H.
export function rendrePhoto({ source, masque, zone, geo, reglages: r, fond }) {
  const t = transformation(geo, r);
  const cImg = document.createElement('canvas'); cImg.width = W; cImg.height = H;
  const cMsk = document.createElement('canvas'); cMsk.width = W; cMsk.height = H;
  const xi = cImg.getContext('2d', { willReadFrequently: true });
  const xm = cMsk.getContext('2d', { willReadFrequently: true });
  for (const c of [xi, xm]) { c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high'; }
  appliquerTransfo(xi, t); xi.drawImage(source, 0, 0);
  appliquerTransfo(xm, t); xm.drawImage(masque, zone.x, zone.y, zone.w, zone.h);

  // Ovale du visage, pour mesurer et corriger la lumiere
  const cOv = document.createElement('canvas'); cOv.width = W; cOv.height = H;
  const xo = cOv.getContext('2d', { willReadFrequently: true });
  xo.fillStyle = '#fff'; xo.beginPath();
  geo.ovale.forEach((u, i) => { const p = versPhoto(t, u); i ? xo.lineTo(p.x, p.y) : xo.moveTo(p.x, p.y); });
  xo.closePath(); xo.fill();

  const img = xi.getImageData(0, 0, W, H);
  const d = img.data;
  const md = xm.getImageData(0, 0, W, H).data;
  const od = xo.getImageData(0, 0, W, H).data;
  const N = W * H;

  // --- Alpha : leger resserrement du bord pour eviter le liseré de l'ancien fond
  const A = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = md[i * 4 + 3] / 255;
    A[i] = Math.min(1, Math.max(0, (a - 0.08) / 0.84));
  }

  // --- Couleurs en lineaire
  const R = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N);
  for (let i = 0; i < N; i++) { R[i] = lin[d[i * 4]]; G[i] = lin[d[i * 4 + 1]]; B[i] = lin[d[i * 4 + 2]]; }

  // --- Decontamination des bords : la couleur des pixels semi-transparents est
  // tiree vers celle du sujet voisin (sinon les cheveux gardent la teinte du mur).
  {
    const wgt = new Float32Array(N), fr = new Float32Array(N), fg = new Float32Array(N), fb = new Float32Array(N);
    for (let i = 0; i < N; i++) { const q = A[i] ** 4; wgt[i] = q; fr[i] = R[i] * q; fg[i] = G[i] * q; fb[i] = B[i] * q; }
    const sig = 3;
    flou(wgt, W, H, sig); flou(fr, W, H, sig); flou(fg, W, H, sig); flou(fb, W, H, sig);
    for (let i = 0; i < N; i++) {
      const a = A[i];
      if (a <= 0.001 || a >= 0.98 || wgt[i] < 1e-4) continue;
      const m = Math.sqrt(1 - a);
      R[i] += (fr[i] / wgt[i] - R[i]) * m;
      G[i] += (fg[i] / wgt[i] - G[i]) * m;
      B[i] += (fb[i] / wgt[i] - B[i]) * m;
    }
  }

  // --- Poids du visage (ovale adouci) et zone d'influence (visage + cou + oreilles)
  const largV = geo.largeurVisage * t.s;
  const Fv = new Float32Array(N), Zone = new Float32Array(N);
  for (let i = 0; i < N; i++) { Fv[i] = (od[i * 4 + 3] / 255) * A[i]; Zone[i] = od[i * 4 + 3] / 255; }
  flou(Fv, W, H, largV * 0.03);
  flou(Zone, W, H, largV * 0.25);
  let zMax = 0; for (let i = 0; i < N; i++) zMax = Math.max(zMax, Zone[i]);
  for (let i = 0; i < N; i++) Zone[i] = Math.min(1, (Zone[i] / (zMax || 1)) * 1.6) * A[i];

  const L = new Float32Array(N);
  for (let i = 0; i < N; i++) L[i] = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];

  // --- Exposition : le point le plus clair du sujet (hors reflets) vers ~ 0.80 lineaire
  const sujet = [], visage = [];
  for (let i = 0; i < N; i += 3) {
    if (A[i] > 0.9) sujet.push(L[i]);
    if (Fv[i] > 0.8) visage.push(L[i]);
  }
  const p99 = percentile(sujet, 0.99);
  const autoGain = p99 > 0 ? Math.min(1.8, Math.max(0.95, 0.8 / p99)) : 1;
  const gain = autoGain * 2 ** (r.lumiere || 0);

  // --- Ombres : on mesure l'eclairage basse frequence du visage et on le rend
  // plus uniforme (moitie de visage dans l'ombre, ombre sous les yeux / le menton).
  const force = r.ombres ?? 0.6;
  let ratio = null;
  if (force > 0 && visage.length > 100) {
    const num = new Float32Array(N), den = new Float32Array(N);
    for (let i = 0; i < N; i++) { num[i] = L[i] * Fv[i]; den[i] = Fv[i]; }
    const sig = largV * 0.16;
    flou(num, W, H, sig); flou(den, W, H, sig);
    const bas = [];
    for (let i = 0; i < N; i += 3) if (Fv[i] > 0.8 && den[i] > 1e-3) bas.push(num[i] / den[i]);
    const cible = percentile(bas, 0.8);
    ratio = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      if (Zone[i] < 0.01 || den[i] < 1e-3) { ratio[i] = 1; continue; }
      const low = num[i] / den[i];
      let k = (cible / Math.max(low, 1e-4)) ** force;
      k = Math.min(3, Math.max(0.75, k));
      ratio[i] = 1 + (k - 1) * Zone[i];
    }
  }

  // --- Temperature (chaud/froid), en gains par canal
  const temp = r.temperature || 0;
  const gR = 1 + 0.08 * temp, gB = 1 - 0.08 * temp;

  // --- Composition sur le fond, avec courbe douce pour les hautes lumieres
  const [fr, fg, fb] = fond.map((c) => lin[c]);
  const doux = (v) => (v < 0.75 ? v : 0.75 + (1 - Math.exp(-(v - 0.75) / 0.25)) * 0.25);
  for (let i = 0; i < N; i++) {
    const a = A[i];
    const k = gain * (ratio ? ratio[i] : 1);
    const pr = doux(R[i] * k * gR), pg = doux(G[i] * k), pb = doux(B[i] * k * gB);
    R[i] = pr * a + fr * (1 - a);
    G[i] = pg * a + fg * (1 - a);
    B[i] = pb * a + fb * (1 - a);
  }

  // --- Nettete legere (on a reechantillonne), uniquement sur le sujet
  {
    const lum = new Float32Array(N);
    for (let i = 0; i < N; i++) lum[i] = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
    const fl = Float32Array.from(lum); flou(fl, W, H, 1.2);
    const q = r.nettete ?? 0.35;
    for (let i = 0; i < N; i++) {
      const det = (lum[i] - fl[i]) * q * A[i];
      R[i] += det; G[i] += det; B[i] += det;
    }
  }

  for (let i = 0; i < N; i++) {
    d[i * 4] = versSRGB(R[i]); d[i * 4 + 1] = versSRGB(G[i]); d[i * 4 + 2] = versSRGB(B[i]); d[i * 4 + 3] = 255;
  }
  xi.setTransform(1, 0, 0, 1, 0, 0);
  xi.putImageData(img, 0, 0);

  const hors = horsSource(t, source.width, source.height);

  return { canvas: cImg, t, gain: autoGain, hors };
}

// Part du bas du cadre (epaules) qui tombe hors de l'image d'origine. Le haut
// n'est que du fond : peu importe qu'il manque.
function horsSource(t, sw, sh) {
  let n = 0, tot = 0;
  for (let y = H / 2; y < H; y += 20) for (let x = 0; x < W; x += 20) {
    tot++;
    const p = depuisPhoto(t, x, y);
    if (p.x < 0 || p.y < 0 || p.x >= sw || p.y >= sh) n++;
  }
  return n / tot;
}

// ---------------------------------------------------------------- Mesures
// Position (en mm, depuis le haut de la photo) du crane, du menton, des yeux.
export function mesures(geo, t) {
  const crane = versPhoto(t, { x: geo.centreX, y: t.craneU }).y / PX_MM;
  const menton = versPhoto(t, { x: geo.centreX, y: geo.menton }).y / PX_MM;
  const yeux = versPhoto(t, { x: geo.centreX, y: 0 }).y / PX_MM;
  const centre = versPhoto(t, { x: geo.centreX, y: 0 }).x / PX_MM;
  const cheveux = versPhoto(t, { x: geo.centreX, y: geo.hautCheveux }).y / PX_MM;
  return { crane, menton, yeux, centre, cheveux, tete: menton - crane, yeuxBas: (NORME.hauteur - yeux) / NORME.hauteur };
}

// Lacet / tangage / roulis (degres) a partir de la matrice MediaPipe (colonne-major).
export function angles(m) {
  if (!m) return null;
  const R = (i, j) => m[j * 4 + i];
  const tangage = (Math.atan2(R(2, 1), R(2, 2)) * 180) / Math.PI;
  const lacet = (Math.asin(Math.max(-1, Math.min(1, -R(2, 0)))) * 180) / Math.PI;
  const roulis = (Math.atan2(R(1, 0), R(0, 0)) * 180) / Math.PI;
  return { lacet, tangage, roulis };
}

// ---------------------------------------------------------------- Planche 10x15
// Format reel des tirages "10x15" en labo : 4 x 6 pouces = 101,6 x 152,4 mm.
export const PLANCHE = { largeurMM: 152.4, hauteurMM: 101.6, dpi: 300, cols: 4, rangs: 2 };

export function planche(photo, { couleurTraits = '#9aa0a6', legende = '' } = {}) {
  const { largeurMM, hauteurMM, dpi, cols, rangs } = PLANCHE;
  const k = dpi / 25.4;
  const c = document.createElement('canvas');
  c.width = Math.round(largeurMM * k); c.height = Math.round(hauteurMM * k);   // 1800 x 1200
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  const gx = (largeurMM - cols * NORME.largeur) / (cols + 1);
  const gy = (hauteurMM - rangs * NORME.hauteur) / (rangs + 1);
  const xs = [], ys = [];
  for (let i = 0; i < cols; i++) xs.push(gx + i * (NORME.largeur + gx));
  for (let j = 0; j < rangs; j++) ys.push(gy + j * (NORME.hauteur + gy));
  // Traits de coupe : alignes sur les bords des photos, visibles dans les marges.
  x.strokeStyle = couleurTraits; x.lineWidth = 1;
  x.beginPath();
  for (const v of xs.flatMap((p) => [p, p + NORME.largeur])) { const px = Math.round(v * k) + 0.5; x.moveTo(px, 0); x.lineTo(px, c.height); }
  for (const v of ys.flatMap((p) => [p, p + NORME.hauteur])) { const py = Math.round(v * k) + 0.5; x.moveTo(0, py); x.lineTo(c.width, py); }
  x.stroke();
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
  for (const px of xs) for (const py of ys) {
    x.drawImage(photo, Math.round(px * k), Math.round(py * k), Math.round(NORME.largeur * k), Math.round(NORME.hauteur * k));
  }
  if (legende) {
    x.fillStyle = '#80868b'; x.font = `${Math.round(1.6 * k)}px sans-serif`; x.textBaseline = 'middle';
    x.fillText(legende, Math.round(gx * k), Math.round((hauteurMM - gy / 2) * k));
  }
  return c;
}

// ---------------------------------------------------------------- Export JPEG
// Ecrit la resolution (dpi) dans l'en-tete JFIF : le labo imprime alors a la
// bonne taille sans deviner.
export async function jpeg(canvas, dpi, qualite = 0.95) {
  const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', qualite));
  const buf = new Uint8Array(await blob.arrayBuffer());
  if (buf[2] === 0xff && buf[3] === 0xe0 && String.fromCharCode(...buf.slice(6, 10)) === 'JFIF') {
    buf[13] = 1; buf[14] = dpi >> 8; buf[15] = dpi & 255; buf[16] = dpi >> 8; buf[17] = dpi & 255;
  }
  return new Blob([buf], { type: 'image/jpeg' });
}
