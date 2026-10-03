// Traitement d'image pour la photo d'identite : geometrie du visage, cadrage
// aux normes ANTS (ISO/IEC 19794-5), lumiere, fond, planche 10x15.
// Aucune dependance : ce module ne fait que du calcul sur des canvas.

// ---------------------------------------------------------------- Normes
// France (ANTS, ISO/IEC 19794-5) : photo 35 x 45 mm, tete du menton au sommet
// du crane HORS chevelure : 32 a 36 mm. Fond clair uni, blanc interdit. Yeux :
// 50 a 70 % de la hauteur depuis le bas.
// Etats-Unis (passeport, visa) : 2 x 2 pouces (50,8 mm), tete du menton au HAUT
// DES CHEVEUX : 1 a 1 3/8 pouce (25 a 35 mm), yeux a 1 1/8 - 1 3/8 pouce du bas
// (28 a 35 mm). Fond blanc ou blanc casse. Pas de lunettes ; sourire naturel admis.
export const NORMES = {
  fr: {
    id: 'fr', nom: 'France', drapeau: '🇫🇷', format: '35 × 45 mm', ref: 'ANTS · ISO/IEC 19794-5',
    largeur: 35,
    hauteur: 45,
    mesure: 'crane',     // la tete se mesure jusqu'au sommet du crane, cheveux exclus
    teteMin: 32,
    teteMax: 36,
    teteCible: 34,
    teteSilhouette: 35, // repere = haut visible de cheveux courts ou plaques
    teteVolume: 34.5,   // repere = crane estime sous des cheveux qui depassent
    margeHaut: 3.5,      // sommet du crane -> bord haut, par defaut
    margeHautMax: 6.5,   // au-dela, les yeux passent sous 50 % de la hauteur
    teteReduite: 33,     // plus petite tete visee pour garder une coiffure haute dans le cadre
    yeuxBasMin: 0.5,     // ligne des yeux, en fraction de la hauteur depuis le bas
    yeuxBasMax: 0.7,
    fonds: ['gris', 'bleu'],
    sourireAdmis: false,
    planche: { cols: 4, rangs: 2 },
  },
  us: {
    id: 'us', nom: 'États-Unis', drapeau: '🇺🇸', format: '2 × 2 pouces (51 × 51 mm)', ref: 'U.S. Department of State',
    largeur: 50.8,
    hauteur: 50.8,
    mesure: 'cheveux',   // la tete se mesure jusqu'au haut des cheveux
    teteMin: 25.4,
    teteMax: 34.9,
    teteCible: 30.5,
    margeHaut: 1.5,
    margeHautMax: 10,
    teteReduite: 26,
    yeuxBasMin: 28.6 / 50.8,
    yeuxBasMax: 34.9 / 50.8,
    yeuxCible: 31.5 / 50.8,  // les yeux placent la photo, la tete en decoule
    fonds: ['blanc'],
    sourireAdmis: true,
    planche: { cols: 2, rangs: 1 },
  },
};

// Norme en cours : objet modifie sur place (les modules qui l'importent voient
// le changement), W et H recalcules.
export const NORME = { ...NORMES.fr };
export const DPI_TRAVAIL = 600;
export const PX_MM = DPI_TRAVAIL / 25.4;
export let W = Math.round(NORME.largeur * PX_MM);   // 827
export let H = Math.round(NORME.hauteur * PX_MM);   // 1063

export function choisirNorme(id) {
  const n = NORMES[id] || NORMES.fr;
  for (const k of Object.keys(NORME)) delete NORME[k];
  Object.assign(NORME, n);
  W = Math.round(NORME.largeur * PX_MM);
  H = Math.round(NORME.hauteur * PX_MM);
  return NORME;
}

// Etats-Unis : la tete se mesure jusqu'au haut des cheveux. A appeler apres
// affinerCrane (qui a trouve le haut de la silhouette).
export function repereNorme(geo) {
  if (NORME.mesure !== 'cheveux') return geo;
  // haut des cheveux trouve sur le detourage ; sinon, crane estime + 4 % (cheveux courts)
  geo.crane = geo.mode === 'estime' ? geo.craneEstime - 0.04 * (geo.menton - geo.craneEstime) : geo.hautCheveux;
  geo.hautCheveux = geo.crane;
  geo.teteCible = NORME.teteCible;
  return geo;
}

export const FONDS = {
  gris: { nom: 'Gris clair', rgb: [214, 216, 219] },
  bleu: { nom: 'Bleu clair', rgb: [200, 219, 236] },
  blanc: { nom: 'Blanc', rgb: [250, 250, 248] },
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
// Ces rapports valent pour un adulte. Un enfant a un crane plus grand par
// rapport au visage : ses yeux sont plus bas dans la tete. Le maillage le voit
// au front (point 10) : sa hauteur au-dessus des pupilles vaut ~0,43 x la
// distance pupilles-menton chez l'adulte, ~0,52 chez un enfant de 6-8 ans.
// On met les rapports a l'echelle de cette mesure.
const FRONT_ADULTE = 0.43;
const proportion = (geo) => Math.min(1.3, Math.max(0.9, -geo.front / geo.menton / FRONT_ADULTE));

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
  const crane = -K_CRANE * Math.min(1.3, Math.max(0.9, -front.y / menton.y / FRONT_ADULTE)) * menton.y;

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
  const p = proportion(geo);
  const kMax = K_PLAFOND * p, court = 0.85 * p;
  geo.proportion = p;
  if (k < K_SILHOUETTE_MIN * p) { geo.mode = 'estime'; return geo; }
  geo.mode = k <= kMax ? 'silhouette' : 'volume';
  geo.crane = -Math.min(k, kMax) * geo.menton;
  // Taille visee : 35 mm quand le repere est le haut visible de cheveux courts
  // (le crane est ~1 mm dessous) ; 34,5 mm quand il est plafonne, ce qui centre
  // la tolerance pour un crane reel entre 0,8 et 0,95.
  const f = Math.min(1, Math.max(0, (k - court) / (kMax - court)));
  geo.teteCible = NORME.teteSilhouette + (NORME.teteVolume - NORME.teteSilhouette) * f;
  return geo;
}

// ---------------------------------------------------------------- Cadrage
// Choisit taille de tete et marge haute pour que la tete fasse 34 mm, que les
// cheveux ne soient pas coupes si possible, et que les yeux restent dans la zone.
export function cadrageAuto(geo) {
  // Taille choisie par affinerCrane selon le repere (voir plus haut). On garde
  // toute la chevelure dans le cadre avec 1 mm d'air : marge haute jusqu'a
  // 6,5 mm (les yeux restent au-dessus de 50 % de la hauteur), puis tete
  // reduite jusqu'a 33 mm (1 mm de securite sur le minimum de 32 mm). Au-dela
  // seulement, les cheveux sont coupes par le bord, ce qui est admis.
  const hTeteU = geo.menton - geo.crane;
  const cheveuxU = Math.max(0, geo.crane - geo.hautCheveux);
  const besoin = (t) => cheveuxU * (t / hTeteU) + 1;
  let tete = geo.teteCible ?? NORME.teteCible;
  if (NORME.yeuxCible) {
    // la ligne des yeux place la photo : marge = position des yeux - partie
    // de la tete au-dessus des yeux (repere redresse : yeux en y = 0)
    const auDessus = tete * (-geo.crane / hTeteU);
    const marge = Math.max(NORME.margeHaut, NORME.hauteur * (1 - NORME.yeuxCible) - auDessus);
    return { tete, marge };
  }
  if (besoin(tete) > NORME.margeHautMax && cheveuxU > 0) {
    tete = Math.max(NORME.teteReduite, ((NORME.margeHautMax - 1) * hTeteU) / cheveuxU);
  }
  const marge = Math.min(NORME.margeHautMax, Math.max(NORME.margeHaut, besoin(tete)));
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

const lisse = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Teinte (degres) et chroma dans le plan a*b* de CIELAB d'une couleur RVB lineaire (D65).
export const TEINTE_PEAU = [25, 63];   // peaux roses d'enfant (~26) a olive (~60)
export const CHROMA_PEAU_MAX = 30;
export function teinteChroma(r, g, b) {
  const X = 0.4124 * r + 0.3576 * g + 0.1805 * b;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
  const f = (v) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  const fx = f(X / 0.9505), fy = f(Y), fz = f(Z / 1.089);
  const a = 500 * (fx - fy), bb = 200 * (fy - fz);
  return [(Math.atan2(bb, a) * 180) / Math.PI, Math.hypot(a, bb)];
}

function percentile(valeurs, p) {
  if (!valeurs.length) return 0;
  const tri = Float32Array.from(valeurs).sort();
  return tri[Math.min(tri.length - 1, Math.floor(p * tri.length))];
}

// ---------------------------------------------------------------- Affinage du detourage
// Le modele de detourage rend un bord flou autour des cheveux (surtout blonds,
// sur un decor clair) : dans cette bande, le decor se melange a la chevelure.
// On recalcule l'opacite a partir des couleurs de l'image (matting par
// echantillonnage) : pour chaque pixel incertain, on estime la couleur du sujet
// F et celle du decor B tout pres, et l'opacite est la part de F dans le pixel :
//   I = a.F + (1 - a).B   =>   a = (I - B).(F - B) / |F - B|^2
// La ou F et B se ressemblent trop pour trancher, on garde l'avis du modele.
// pixels : RVBA de l'image ; alpha : RVBA du masque (canal A modifie en place).
export function affinerMasque(pixels, alpha, w, h) {
  const N = w * h;
  const R = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N), a0 = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    R[i] = lin[pixels[i * 4]]; G[i] = lin[pixels[i * 4 + 1]]; B[i] = lin[pixels[i * 4 + 2]];
    a0[i] = alpha[i * 4 + 3] / 255;
  }
  const echelle = Math.max(w, h) / 1000;

  // Zones sures : sujet (a > 0,97) et decor (a < 0,03), un peu retrecies pour
  // ne pas echantillonner dans le flou du modele.
  const sur = (test) => {
    const m = new Float32Array(N);
    for (let i = 0; i < N; i++) m[i] = test(a0[i]) ? 1 : 0;
    const e = Float32Array.from(m); flou(e, w, h, 2 * echelle);
    for (let i = 0; i < N; i++) m[i] = e[i] > 0.97 ? 1 : 0;
    return m;
  };
  const sujet = sur((a) => a > 0.97), decor = sur((a) => a < 0.03);

  // Couleur de reference la plus proche, cherchee a plusieurs echelles.
  const remplir = (m) => {
    const out = [new Float32Array(N), new Float32Array(N), new Float32Array(N)];
    const trouve = new Uint8Array(N);   // 1 a 4 : echelle a laquelle la reference a ete trouvee
    for (const [niveau, sig] of [[1, 4], [2, 12], [3, 36], [4, 100]]) {
      const ww = Float32Array.from(m), rr = new Float32Array(N), gg = new Float32Array(N), bb = new Float32Array(N);
      for (let i = 0; i < N; i++) { rr[i] = R[i] * m[i]; gg[i] = G[i] * m[i]; bb[i] = B[i] * m[i]; }
      const sg = sig * echelle;
      flou(ww, w, h, sg); flou(rr, w, h, sg); flou(gg, w, h, sg); flou(bb, w, h, sg);
      for (let i = 0; i < N; i++) {
        if (trouve[i] || ww[i] < 0.03) continue;
        out[0][i] = rr[i] / ww[i]; out[1][i] = gg[i] / ww[i]; out[2][i] = bb[i] / ww[i];
        trouve[i] = niveau;
      }
    }
    return { c: out, trouve };
  };
  const F = remplir(sujet), D = remplir(decor);

  for (let i = 0; i < N; i++) {
    const a = a0[i];
    if (a <= 0.01 || a >= 0.99 || sujet[i] || !F.trouve[i] || !D.trouve[i]) continue;
    const dr = F.c[0][i] - D.c[0][i], dg = F.c[1][i] - D.c[1][i], db = F.c[2][i] - D.c[2][i];
    const den = dr * dr + dg * dg + db * db;
    // ecart de couleur sujet / decor, et references prises assez pres : une
    // reference lointaine (le visage pour un vetement sur lequel le modele
    // hesite en entier) ne dit rien du pixel, on garde alors l'avis du modele
    const proche = (n) => (n <= 2 ? 1 : n === 3 ? 0.4 : 0);
    const conf = lisse(0.03, 0.12, Math.sqrt(den)) * proche(F.trouve[i]) * proche(D.trouve[i]);
    if (conf <= 0) continue;
    const ir = R[i] - D.c[0][i], ig = G[i] - D.c[1][i], ib = B[i] - D.c[2][i];
    let ac = (ir * dr + ig * dg + ib * db) / den;
    ac = Math.min(1, Math.max(0, ac));
    // le pixel colle-t-il au modele I = a.F + (1-a).B ? sinon (3e couleur,
    // comme une voiture rouge derriere des cheveux blonds) il est suspect
    const er = ir - ac * dr, eg = ig - ac * dg, eb = ib - ac * db;
    const residu = Math.sqrt(er * er + eg * eg + eb * eb);
    const fiable = conf * (1 - lisse(0.05, 0.2, residu));
    let an = a + (ac - a) * fiable * 0.85;
    // pixel qui ne ressemble ni au sujet ni au decor proche : on ne le garde que
    // si le modele en etait sur
    if (residu > 0.12 && conf > 0) an = Math.min(an, a * (1 - lisse(0.12, 0.3, residu) * Math.min(1, conf * 2)) + 0.2 * a);
    alpha[i * 4 + 3] = Math.round(Math.min(1, Math.max(0, an)) * 255);
  }
}

// ---------------------------------------------------------------- Objets colles au sujet
// Un coussin, une horloge, le dos d'un livre juste derriere la personne est
// parfois detoure avec elle. On apprend trois couleurs de reference sur l'image
// (CIELAB, clarte comprise) : cheveux (juste au-dessus du front), peau (joues)
// et vetements ou epaules (sous le menton). Une zone du contour qui ne
// ressemble a aucune des trois et qui touche l'exterieur de la silhouette est
// retiree, par passes depuis l'exterieur. Le crane et le visage sont proteges :
// un reflet ou une meche grise au milieu des cheveux reste.
// versU(x, y) : pixel du masque -> repere redresse du visage (voir geometrie).
export function nettoyerBords(pixels, alpha, w, h, versU, geo) {
  const N = w * h;
  const Lab = new Float32Array(N * 3);
  const f = (v) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  for (let i = 0; i < N; i++) {
    const r = lin[pixels[i * 4]], g = lin[pixels[i * 4 + 1]], b = lin[pixels[i * 4 + 2]];
    const fx = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.9505);
    const fy = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
    const fz = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.089);
    Lab[i * 3] = 116 * fy - 16; Lab[i * 3 + 1] = 500 * (fx - fy); Lab[i * 3 + 2] = 200 * (fy - fz);
  }
  const U = new Float32Array(N * 2);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = versU(x, y), i = y * w + x;
    U[i * 2] = u.x; U[i * 2 + 1] = u.y;
  }
  const M = geo.menton, Lv = geo.largeurVisage, cx = geo.centreX;
  const dE = (i, m) => Math.hypot(Lab[i * 3] - m[0], (Lab[i * 3 + 1] - m[1]) * 1.5, (Lab[i * 3 + 2] - m[2]) * 1.5);
  const modele = (dedans, exclure = null) => {
    const ech = [];
    for (let i = 0; i < N; i += 3) {
      if (alpha[i * 4 + 3] > 242 && dedans(U[i * 2] - cx, U[i * 2 + 1]) && !(exclure && exclure(i))) ech.push(i);
    }
    if (ech.length < 150) return null;
    const m = [0, 0, 0];
    for (const i of ech) { m[0] += Lab[i * 3]; m[1] += Lab[i * 3 + 1]; m[2] += Lab[i * 3 + 2]; }
    m[0] /= ech.length; m[1] /= ech.length; m[2] /= ech.length;
    const ecart = Math.max(8, percentile(ech.map((i) => dE(i, m)), 0.85));
    return { m, ecart };
  };
  const peau = modele((x, y) => y > 0.15 * M && y < 0.55 * M && Math.abs(x) < 0.3 * Lv);
  // au-dessus du front, sans la peau (frange, front degarni)
  const cheveux = modele((x, y) => y < geo.front && y > geo.front - 0.3 * M && Math.abs(x) < 0.3 * Lv,
    peau ? (i) => dE(i, peau.m) < 2 * peau.ecart : null);
  // vetements : sous le menton, sur toute la largeur des epaules, en deux
  // teintes (foncee / claire) pour un pull a rayures ou une chemise sous un pull
  const zoneHabits = (x, y) => y > 1.15 * M && y < 1.9 * M && Math.abs(x) < 1.2 * Lv;
  let medianeHabits = 50;
  {
    const ls = [];
    for (let i = 0; i < N; i += 7) if (alpha[i * 4 + 3] > 242 && zoneHabits(U[i * 2] - cx, U[i * 2 + 1])) ls.push(Lab[i * 3]);
    if (ls.length) medianeHabits = percentile(ls, 0.5);
  }
  const habitsF = modele((x, y) => zoneHabits(x, y), (i) => Lab[i * 3] > medianeHabits);
  const habitsC = modele((x, y) => zoneHabits(x, y), (i) => Lab[i * 3] <= medianeHabits);
  const habits = habitsF || habitsC;
  // en haut : cheveux ou peau ; plus bas, aussi vetements/epaules
  const haut = [cheveux, peau].filter(Boolean), bas = [cheveux, peau, habitsF, habitsC].filter(Boolean);
  if (!cheveux || !peau) return 0;

  const z = new Float32Array(N), Q = new Float32Array(N), dehors = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (alpha[i * 4 + 3] < 8) continue;
    const x = U[i * 2] - cx, y = U[i * 2 + 1];
    // protege : le crane (demi-ellipse au-dessus des yeux, jusqu'au crane
    // estime) et le visage ; ce sont forcement des cheveux ou de la peau
    const crane = y < 0 ? (x / (0.5 * Lv)) ** 2 + (y / geo.craneEstime) ** 2 < 1 : Math.abs(x) < 0.5 * Lv && y < 1.05 * M;
    if (crane) continue;
    // Sous les yeux, les epaules peuvent monter haut (enfant, epaules hautes) :
    // les vetements y sont permis des la mi-hauteur du visage, pas seulement
    // sous le menton. Sans couleur de vetements apprise, on ne touche pas au buste.
    const corps = y > 0.5 * M;
    if (corps && !habits) continue;
    let zi = Infinity;
    for (const md of (corps ? bas : haut)) zi = Math.min(zi, dE(i, md.m) / md.ecart);
    z[i] = zi;
    Q[i] = lisse(1.8, 3, zi);
  }
  const echelle = Math.hypot(versU(10, 0).x - versU(0, 0).x, versU(10, 0).y - versU(0, 0).y) / 10;
  const sig = (0.03 * M) / echelle;
  flou(Q, w, h, sig);
  const avant = new Uint8ClampedArray(N);
  for (let i = 0; i < N; i++) avant[i] = alpha[i * 4 + 3];
  let retires = 0;
  for (let passe = 0; passe < 6; passe++) {
    for (let i = 0; i < N; i++) dehors[i] = alpha[i * 4 + 3] < 25 ? 1 : 0;
    flou(dehors, w, h, sig * 0.5);
    let n = 0;
    for (let i = 0; i < N; i++) {
      if (!z[i] || alpha[i * 4 + 3] < 25) continue;
      const q = lisse(0.25, 0.5, Q[i]) * lisse(0.05, 0.15, dehors[i]) * lisse(1.5, 2.5, z[i]);
      if (q <= 0.02) continue;
      alpha[i * 4 + 3] = Math.round(alpha[i * 4 + 3] * (1 - q));
      n++;
    }
    retires += n;
    if (!n) break;
  }

  // Securite : le nettoyage vise de petits objets colles (coussin, livre). S'il
  // a efface une grande surface sous le visage, c'est qu'il a pris le buste
  // pour du decor : on annule tout ce qu'il a fait sous les yeux.
  let opaque = 0, efface = 0;
  for (let i = 0; i < N; i++) {
    opaque += avant[i];
    if (U[i * 2 + 1] > 0.5 * M) efface += avant[i] - alpha[i * 4 + 3];
  }
  if (efface > 0.03 * opaque) {
    for (let i = 0; i < N; i++) if (U[i * 2 + 1] > 0.5 * M) alpha[i * 4 + 3] = avant[i];
  }
  return retires;
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

  const largV = geo.largeurVisage * t.s;

  // --- Alpha : leger resserrement du bord pour eviter le liseré de l'ancien fond
  const A = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = md[i * 4 + 3] / 255;
    A[i] = Math.min(1, Math.max(0, (a - 0.08) / 0.84));
  }

  // --- Meches folles et ilots : un cheveu isole qui part loin de la chevelure,
  // ou un bout de decor detoure par erreur, n'a presque pas de « masse » opaque
  // autour de lui. On l'efface progressivement ; le bord de la chevelure, qui
  // touche une masse pleine, reste doux et intact. Comme un photographe qui
  // lisse la coiffure avant la prise de vue.
  const discipline = r.meches ?? 0.8;
  if (discipline > 0) {
    const masse = new Float32Array(N);
    for (let i = 0; i < N; i++) masse[i] = A[i] > 0.6 ? 1 : 0;
    flou(masse, W, H, largV * 0.03);
    for (let i = 0; i < N; i++) {
      if (A[i] <= 0) continue;
      const garde = lisse(0.22, 0.5, masse[i]);
      A[i] *= 1 - discipline * (1 - garde);
    }
  }

  // --- Couleurs en lineaire
  const R = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N);
  for (let i = 0; i < N; i++) { R[i] = lin[d[i * 4]]; G[i] = lin[d[i * 4 + 1]]; B[i] = lin[d[i * 4 + 2]]; }

  // --- Decontamination des bords : un pixel semi-transparent (cheveu fin, bord
  // flou) melange le sujet et l'ancien fond ; sur un fond sombre, les meches
  // ressortent sales. On remplace sa couleur par celle du sujet le plus proche,
  // cherchee a plusieurs echelles (3, 10, 30 px) pour que meme une meche loin de
  // la chevelure prenne la couleur des cheveux et non celle du decor.
  {
    const echelles = [3, 10, 30].map((sig) => {
      const w = new Float32Array(N), fr = new Float32Array(N), fg = new Float32Array(N), fb = new Float32Array(N);
      for (let i = 0; i < N; i++) { const q = A[i] > 0.85 ? A[i] ** 4 : 0; w[i] = q; fr[i] = R[i] * q; fg[i] = G[i] * q; fb[i] = B[i] * q; }
      flou(w, W, H, sig); flou(fr, W, H, sig); flou(fg, W, H, sig); flou(fb, W, H, sig);
      return { w, fr, fg, fb };
    });
    for (let i = 0; i < N; i++) {
      const a = A[i];
      if (a <= 0.001 || a >= 0.98) continue;
      // echelle la plus fine qui « voit » assez de sujet
      let e = null;
      for (const c of echelles) if (c.w[i] > 0.02) { e = c; break; }
      if (!e) e = echelles[2].w[i] > 1e-5 ? echelles[2] : null;
      if (!e) continue;
      const m = Math.min(1, (1 - a) * 1.6);
      R[i] += (e.fr[i] / e.w[i] - R[i]) * m;
      G[i] += (e.fg[i] / e.w[i] - G[i]) * m;
      B[i] += (e.fb[i] / e.w[i] - B[i]) * m;
    }
  }

  // --- Reflets colores du decor dans le bord du sujet : une voiture rouge ou de
  // la verdure vue a travers des cheveux blonds donne des pixels que le modele
  // croit opaques mais qui n'ont pas la couleur des cheveux. Pres du bord, on
  // compare la teinte (couleur a clarte egale) a celle du sujet plus a
  // l'interieur ; si elle s'en ecarte nettement, on prend la teinte du sujet en
  // gardant la clarte du pixel (le dessin des meches reste).
  {
    const inter = new Float32Array(N);
    for (let i = 0; i < N; i++) inter[i] = A[i] > 0.97 ? 1 : 0;
    flou(inter, W, H, largV * 0.025);
    for (let i = 0; i < N; i++) inter[i] = inter[i] > 0.97 ? 1 : 0;
    const fr = new Float32Array(N), fg = new Float32Array(N), fb = new Float32Array(N), ok = new Uint8Array(N);
    for (const sig of [6, 20, 60]) {
      const w = Float32Array.from(inter), rr = new Float32Array(N), gg = new Float32Array(N), bb = new Float32Array(N);
      for (let i = 0; i < N; i++) { rr[i] = R[i] * inter[i]; gg[i] = G[i] * inter[i]; bb[i] = B[i] * inter[i]; }
      flou(w, W, H, sig); flou(rr, W, H, sig); flou(gg, W, H, sig); flou(bb, W, H, sig);
      for (let i = 0; i < N; i++) {
        if (ok[i] || w[i] < 0.05) continue;
        fr[i] = rr[i] / w[i]; fg[i] = gg[i] / w[i]; fb[i] = bb[i] / w[i]; ok[i] = 1;
      }
    }
    for (let i = 0; i < N; i++) {
      if (A[i] < 0.01 || inter[i] || !ok[i]) continue;
      const l = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
      const lf = 0.2126 * fr[i] + 0.7152 * fg[i] + 0.0722 * fb[i];
      if (l < 1e-4 || lf < 1e-4) continue;
      const dr = R[i] / l - fr[i] / lf, dg = G[i] / l - fg[i] / lf, db = B[i] / l - fb[i] / lf;
      const q = lisse(0.2, 0.45, Math.sqrt(dr * dr + dg * dg + db * db));
      if (q <= 0) continue;
      const k = l / lf;
      R[i] += (fr[i] * k - R[i]) * q;
      G[i] += (fg[i] * k - G[i]) * q;
      B[i] += (fb[i] * k - B[i]) * q;
    }
  }

  // --- Poids du visage (ovale adouci) et zone d'influence (visage + cou + oreilles)
  const Fv = new Float32Array(N), Zone = new Float32Array(N);
  for (let i = 0; i < N; i++) { Fv[i] = (od[i * 4 + 3] / 255) * A[i]; Zone[i] = od[i * 4 + 3] / 255; }
  flou(Fv, W, H, largV * 0.03);
  flou(Zone, W, H, largV * 0.25);
  let zMax = 0; for (let i = 0; i < N; i++) zMax = Math.max(zMax, Zone[i]);
  for (let i = 0; i < N; i++) Zone[i] = Math.min(1, (Zone[i] / (zMax || 1)) * 1.6) * A[i];

  // --- Balance des blancs. La couleur de la peau varie peu d'une personne a
  // l'autre dans le plan a*b* de CIELAB : teinte entre 25 et 63 deg, saturation
  // (chroma) moderee ; seule la clarte change vraiment. Plage volontairement
  // large : une peau rose d'enfant ne doit pas etre prise pour une dominante. Une lampe d'interieur
  // pousse le visage vers le jaune-orange et le sature, l'ombre ou un ecran vers
  // le bleu-rose. On cherche les gains vert et bleu (adaptation chromatique de
  // von Kries, comme un appareil photo) qui ramenent le visage dans cette zone,
  // en bougeant le moins possible : une peau deja dedans n'est pas touchee.
  let balance = { teinte: null, chroma: null, c: 0 };
  {
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (let i = 0; i < N; i += 2) {
      const l = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
      if (Fv[i] > 0.8 && l > 0.01 && l < 0.9) { sr += R[i]; sg += G[i]; sb += B[i]; n++; }
    }
    if (n > 200) {
      sr /= n; sg /= n; sb /= n;
      const [t0, c0] = teinteChroma(sr, sg, sb);
      balance.teinte = t0; balance.chroma = c0;
      const cout = (kg, kb) => {
        const [t, c] = teinteChroma(sr, sg * kg, sb * kb);
        const dt = t > TEINTE_PEAU[1] ? t - TEINTE_PEAU[1] : t < TEINTE_PEAU[0] ? TEINTE_PEAU[0] - t : 0;
        const dc = Math.max(0, c - CHROMA_PEAU_MAX);
        return dt * dt + 4 * dc * dc + 40 * (Math.log(kg) ** 2 + Math.log(kb) ** 2);
      };
      let kg = 1, kb = 1, meilleur = cout(1, 1);
      for (let lg = -0.25; lg <= 0.2501; lg += 0.01) for (let lb = -0.4; lb <= 0.7001; lb += 0.01) {
        const v = cout(Math.exp(lg), Math.exp(lb));
        if (v < meilleur) { meilleur = v; kg = Math.exp(lg); kb = Math.exp(lb); }
      }
      const f = r.balance ?? 1;
      kg = kg ** f; kb = kb ** f;
      if (kg !== 1 || kb !== 1) {
        // gains normalises pour garder la luminance moyenne du visage
        const norm = (0.2126 * sr + 0.7152 * sg + 0.0722 * sb) / (0.2126 * sr + 0.7152 * sg * kg + 0.0722 * sb * kb);
        for (let i = 0; i < N; i++) { R[i] *= norm; G[i] *= kg * norm; B[i] *= kb * norm; }
      }
      // c > 0 : on a refroidi (dominante chaude), c < 0 : rechauffe
      balance.c = Math.log(kb) - Math.log(kg) * 0.5;
      balance.gains = [kg, kb];
    }
  }

  const L = new Float32Array(N);
  for (let i = 0; i < N; i++) L[i] = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];

  // --- Reflets (front, nez, pommettes qui brillent). Une brillance est plus
  // claire ET plus blanche que la peau du visage : un front simplement bien
  // eclaire garde sa couleur, il n'est pas touche. Les pixels brillants sont
  // ramenes vers la couleur moyenne de la peau, a une clarte comprimee.
  const brillance = r.reflets ?? 0.6;
  if (brillance > 0) {
    const sat = (i) => { const mx = Math.max(R[i], G[i], B[i]); return mx > 1e-4 ? (mx - Math.min(R[i], G[i], B[i])) / mx : 0; };
    const lums = [], sats = [];
    let sr = 0, sg = 0, sb = 0, sl = 0;
    for (let i = 0; i < N; i += 2) {
      if (Fv[i] <= 0.8) continue;
      lums.push(L[i]); sats.push(sat(i));
      sr += R[i]; sg += G[i]; sb += B[i]; sl += L[i];
    }
    if (lums.length > 200) {
      const lRef = percentile(lums, 0.6), satRef = percentile(sats, 0.5);
      const cr = sr / sl, cg = sg / sl, cb = sb / sl;   // couleur moyenne de la peau, a luminance 1
      for (let i = 0; i < N; i++) {
        const z = Fv[i];
        if (z < 0.05) continue;
        const exces = L[i] / lRef;
        if (exces < 1.1) continue;
        let q = lisse(1.1, 1.45, exces) * lisse(0.15, 0.6, 1 - sat(i) / Math.max(satRef, 1e-3));
        q *= z * brillance;
        if (q <= 0) continue;
        const lc = lRef * (1.1 + 0.25 * (exces - 1.1));   // clarte comprimee, le relief reste
        R[i] += (cr * lc - R[i]) * q;
        G[i] += (cg * lc - G[i]) * q;
        B[i] += (cb * lc - B[i]) * q;
        L[i] = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
      }
    }
  }

  // --- Exposition : le point le plus clair du sujet (hors reflets) vers ~ 0.80 lineaire
  const sujet = [], visage = [];
  for (let i = 0; i < N; i += 3) {
    if (A[i] > 0.9) sujet.push(L[i]);
    if (Fv[i] > 0.8) visage.push(L[i]);
  }
  const p99 = percentile(sujet, 0.99);
  const autoGain = p99 > 0 ? Math.min(1.8, Math.max(0.95, 0.8 / p99)) : 1;
  const gain = autoGain * 2 ** (r.lumiere || 0);

  // --- Ombres. Un visage est a peu pres symetrique : si une moitie est plus
  // sombre que l'autre a hauteur egale, c'est l'eclairage (fenetre de cote),
  // pas le visage. On mesure l'eclairage basse frequence, on le compare a celui
  // du point miroir (par rapport a l'axe du visage) et on eclaircit le cote
  // sombre pour rejoindre le cote clair. Le modele naturel du visage (nez,
  // pommettes, menton) est garde ; seule une petite part de l'ombre generale
  // (sous le menton, orbites) est en plus adoucie.
  const force = r.ombres ?? 1;
  let ratio = null;
  if (force > 0 && visage.length > 100) {
    const num = new Float32Array(N), den = new Float32Array(N);
    for (let i = 0; i < N; i++) { num[i] = L[i] * Fv[i]; den[i] = Fv[i]; }
    // echelle large : un eclairage de cote est un degrade sur tout le visage ;
    // plus fin, on confondrait le relief d'une joue avec une ombre
    const sig = largV * 0.25;
    flou(num, W, H, sig); flou(den, W, H, sig);
    const bas = new Float32Array(N);
    for (let i = 0; i < N; i++) bas[i] = den[i] > 1e-3 ? num[i] / den[i] : 0;
    const vals = [];
    for (let i = 0; i < N; i += 3) if (Fv[i] > 0.8 && bas[i] > 0) vals.push(bas[i]);
    const cible = percentile(vals, 0.7);
    const axe = versPhoto(t, { x: geo.centreX, y: 0 }).x;
    ratio = new Float32Array(N);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const low = bas[i];
      if (Zone[i] < 0.01 || low <= 0) { ratio[i] = 1; continue; }
      const xm = Math.round(2 * axe - x);
      const lm = xm >= 0 && xm < W ? bas[y * W + xm] : 0;
      const sym = lm > 0 ? Math.min(1.7, Math.max(1, lm / low)) : 1;   // seul le cote sombre bouge
      const plat = Math.max(1, cible / low);                   // ombre generale, adoucie a 30 %
      let k = sym ** force * plat ** (0.3 * force);
      k = Math.min(1.9, k);
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
      const det = (lum[i] - fl[i]) * q * A[i] * A[i];   // pas sur les bords fins : halo
      R[i] += det; G[i] += det; B[i] += det;
    }
  }

  for (let i = 0; i < N; i++) {
    d[i * 4] = versSRGB(R[i]); d[i * 4 + 1] = versSRGB(G[i]); d[i * 4 + 2] = versSRGB(B[i]); d[i * 4 + 3] = 255;
  }
  xi.setTransform(1, 0, 0, 1, 0, 0);
  xi.putImageData(img, 0, 0);

  const hors = horsSource(t, source.width, source.height);

  return { canvas: cImg, t, gain: autoGain, hors, balance };
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
export const PLANCHE = { largeurMM: 152.4, hauteurMM: 101.6, dpi: 300 };
export const places = (norme = NORME) => { const N = typeof norme === 'string' ? NORMES[norme] : norme; return N.planche.cols * N.planche.rangs; };

// photo : une image (repetee 8 fois) ou une liste de 8 cases { image, nom }
// (null = case vide) pour composer une planche avec plusieurs personnes.
export function planche(photo, { couleurTraits = '#9aa0a6', legende = '', norme = NORME } = {}) {
  const N = typeof norme === 'string' ? NORMES[norme] : norme;
  const { cols, rangs } = N.planche;
  const cases = Array.isArray(photo) ? photo : Array(cols * rangs).fill({ image: photo, nom: '' });
  const { largeurMM, hauteurMM, dpi } = PLANCHE;
  const k = dpi / 25.4;
  const c = document.createElement('canvas');
  c.width = Math.round(largeurMM * k); c.height = Math.round(hauteurMM * k);   // 1800 x 1200
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  const gx = (largeurMM - cols * N.largeur) / (cols + 1);
  const gy = (hauteurMM - rangs * N.hauteur) / (rangs + 1);
  const xs = [], ys = [];
  for (let i = 0; i < cols; i++) xs.push(gx + i * (N.largeur + gx));
  for (let j = 0; j < rangs; j++) ys.push(gy + j * (N.hauteur + gy));
  // Traits de coupe : alignes sur les bords des photos, visibles dans les marges.
  x.strokeStyle = couleurTraits; x.lineWidth = 1;
  x.beginPath();
  for (const v of xs.flatMap((p) => [p, p + N.largeur])) { const px = Math.round(v * k) + 0.5; x.moveTo(px, 0); x.lineTo(px, c.height); }
  for (const v of ys.flatMap((p) => [p, p + N.hauteur])) { const py = Math.round(v * k) + 0.5; x.moveTo(0, py); x.lineTo(c.width, py); }
  x.stroke();
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
  let n = 0;
  for (const py of ys) for (const px of xs) {
    const c = cases[n++];
    if (!c) continue;
    x.drawImage(c.image, Math.round(px * k), Math.round(py * k), Math.round(N.largeur * k), Math.round(N.hauteur * k));
    if (c.nom) {
      // prenom en petit sous la photo, dans la marge (hors de la photo a decouper)
      x.fillStyle = '#80868b'; x.font = `${Math.round(1.5 * k)}px sans-serif`;
      x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText(c.nom.slice(0, 24), Math.round((px + N.largeur / 2) * k), Math.round((py + N.hauteur + gy / 2) * k));
      x.textAlign = 'start';
    }
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
