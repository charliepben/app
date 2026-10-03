// Moteurs de detourage supplementaires, executes avec onnxruntime-web (le meme
// que celui du detourage IMG.LY, partage par vendor/background-removal.mjs).
//   modnet : MODNet, specialise portraits (matting des cheveux), 26 Mo, Apache-2.0
//   rmbg   : BRIA RMBG-1.4 quantifie, 44 Mo, gratuit pour un usage non commercial
// Les modeles viennent du paquet npm, servi par jsDelivr (version figee, empreinte
// SHA-256 verifiee), puis gardes en cache par le service worker.

const ORT_VERSION = '1.21.0';
const CDN = 'https://cdn.jsdelivr.net/npm/';

export const MOTEURS = {
  modnet: {
    nom: 'MODNet (portraits)',
    fichiers: ['modnet-1.onnx', 'modnet-2.onnx', 'modnet-3.onnx'].map((f) => `${CDN}@rmbg/model-modnet@0.0.1/${f}`),
    taille: 25888640,
    sha256: '07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9',
  },
  rmbg: {
    nom: 'BRIA RMBG-1.4',
    fichiers: [1, 2, 3, 4, 5].map((n) => `${CDN}@rmbg/model-briaai@0.0.1/briaai-${n}.onnx`),
    taille: 44404026,
    sha256: 'a6648479275dfd0ede0f3a8abc20aa5c437b394681b05e5af6d268250aaf40f3',
  },
};

const sessions = {};

async function telechargerModele(m, onProgres) {
  let fait = 0;
  const morceaux = [];
  for (const url of m.fichiers) {
    const rep = await fetch(url);
    if (!rep.ok) throw new Error(`Téléchargement du modèle impossible (${rep.status})`);
    const lecteur = rep.body.getReader();
    for (;;) {
      const { done, value } = await lecteur.read();
      if (done) break;
      morceaux.push(value);
      fait += value.length;
      onProgres?.(fait, m.taille);
    }
  }
  const buf = new Uint8Array(fait);
  let o = 0;
  for (const c of morceaux) { buf.set(c, o); o += c.length; }
  const empreinte = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (empreinte !== m.sha256) throw new Error('Modèle de détourage corrompu (empreinte inattendue).');
  return buf;
}

async function session(ort, nom, onProgres) {
  if (sessions[nom]) return sessions[nom];
  ort.env.wasm.wasmPaths = `${CDN}onnxruntime-web@${ORT_VERSION}/dist/`;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 4) : 1;
  const buf = await telechargerModele(MOTEURS[nom], onProgres);
  const essais = navigator.gpu ? [['webgpu'], ['wasm']] : [['wasm']];
  let derniere;
  for (const ep of essais) {
    try {
      sessions[nom] = await ort.InferenceSession.create(buf, { executionProviders: ep, graphOptimizationLevel: 'all' });
      return sessions[nom];
    } catch (e) { derniere = e; }
  }
  throw derniere;
}

// pixels : RVBA (w x h). Renvoie un RVBA de meme taille dont le canal A est le masque.
export async function segmenter(ort, nom, pixels, w, h, onProgres) {
  const s = await session(ort, nom, onProgres);

  // Taille d'entree du modele
  let mw, mh;
  if (nom === 'modnet') {
    // MODNet : petit cote a 512 px, multiples de 32 (reglage d'origine du modele)
    const ref = 512;
    const k = ref / Math.min(w, h);
    mw = Math.max(32, Math.round((w * k) / 32) * 32);
    mh = Math.max(32, Math.round((h * k) / 32) * 32);
  } else {
    mw = 1024; mh = 1024;
  }
  const src = document.createElement('canvas'); src.width = w; src.height = h;
  src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels), w, h), 0, 0);
  const red = document.createElement('canvas'); red.width = mw; red.height = mh;
  const rx = red.getContext('2d', { willReadFrequently: true });
  rx.imageSmoothingQuality = 'high';
  rx.drawImage(src, 0, 0, mw, mh);
  const d = rx.getImageData(0, 0, mw, mh).data;
  const n = mw * mh;
  const entree = new Float32Array(3 * n);
  // MODNet : (x - 0,5) / 0,5 ; RMBG-1.4 : x - 0,5
  const div = nom === 'modnet' ? 0.5 : 1;
  for (let i = 0; i < n; i++) {
    entree[i] = (d[i * 4] / 255 - 0.5) / div;
    entree[n + i] = (d[i * 4 + 1] / 255 - 0.5) / div;
    entree[2 * n + i] = (d[i * 4 + 2] / 255 - 0.5) / div;
  }
  const res = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', entree, [1, 3, mh, mw]) });
  const sortie = res[s.outputNames[0]].data;

  // RMBG-1.4 : sortie a renormaliser entre son min et son max
  let lo = 0, hi = 1;
  if (nom === 'rmbg') {
    lo = Infinity; hi = -Infinity;
    for (let i = 0; i < n; i++) { const v = sortie[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (hi - lo < 1e-6) { lo = 0; hi = 1; }
  }
  const m = new ImageData(mw, mh);
  for (let i = 0; i < n; i++) {
    const a = Math.min(1, Math.max(0, (sortie[i] - lo) / (hi - lo)));
    m.data[i * 4] = m.data[i * 4 + 1] = m.data[i * 4 + 2] = 255;
    m.data[i * 4 + 3] = Math.round(a * 255);
  }
  const mc = document.createElement('canvas'); mc.width = mw; mc.height = mh;
  mc.getContext('2d').putImageData(m, 0, 0);
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  const ox = out.getContext('2d', { willReadFrequently: true });
  ox.imageSmoothingQuality = 'high';
  ox.drawImage(mc, 0, 0, w, h);
  return ox.getImageData(0, 0, w, h).data;
}
