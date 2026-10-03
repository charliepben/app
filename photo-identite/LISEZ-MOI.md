# Photo d'identité — norme française

Une photo, et l'appli rend une planche 10×15 de 8 photos d'identité 35×45 mm
aux normes ANTS (ISO/IEC 19794-5). Tout tourne dans le navigateur : la photo ne
quitte pas l'appareil, pas de serveur, pas de clé d'API.

## Ce que fait l'appli

1. **Repères du visage** (MediaPipe Face Landmarker, 478 points) : yeux, menton,
   ovale, orientation de la tête, yeux ouverts, sourire, bouche ouverte.
2. **Détourage** (IMG.LY, modèle ISNet fp16) sur la seule zone utile autour de la
   tête, pour mettre toute la résolution du modèle sur les cheveux et les épaules.
3. **Cadrage** : tête redressée, centrée, **34 mm du menton au sommet du crâne**
   (tolérance 32–36 mm, cheveux exclus), sommet du crâne à 3,5–5 mm du bord haut,
   ligne des yeux entre 50 et 70 % de la hauteur.
   Le sommet du crâne est estimé à 0,85 × la distance pupilles–menton au-dessus
   des pupilles, puis rabaissé si la silhouette détourée s'arrête plus bas (crâne
   rasé, cheveux courts). Un curseur permet de corriger ce repère à l'œil.
4. **Lumière** : exposition automatique, atténuation des ombres sur le visage
   (l'éclairage basse fréquence est égalisé, la texture de la peau est gardée),
   décontamination des bords (les cheveux ne gardent pas la couleur de l'ancien
   fond), légère netteté.
5. **Fond** uni gris clair ou bleu clair (le blanc est interdit).
6. **Contrôles** : taille de tête, position des yeux, centrage, tête de face,
   yeux ouverts, expression neutre, résolution, cadre complet.
7. **Planche** 1800×1200 px à 300 dpi (format réel des tirages « 10×15 » :
   101,6 × 152,4 mm), 8 photos avec traits de coupe. Photo seule 35×45 à 600 dpi.

## Imprimer

Tirage 10×15 **sans recadrage / taille réelle**. Vérifier à la règle qu'une
photo fait bien 35 mm de large, puis découper le long des traits gris.

Les démarches en ligne (permis de conduire, titre de séjour…) exigent une
e-photo avec code numérique d'une cabine ou d'un photographe agréé : la planche
sert aux dossiers papier.

## Fichiers

- `index.html`, `app.js` : interface.
- `photo.js` : géométrie, cadrage, lumière, planche, export JPEG (pur calcul).
- `vendor/vision_bundle.mjs` : `@mediapipe/tasks-vision@1.0.1`, tel quel.
- `vendor/background-removal.mjs` : `@imgly/background-removal@1.7.0` +
  `onnxruntime-web@1.21.0`, regroupés :

  ```sh
  npm i @imgly/background-removal@1.7.0 onnxruntime-web@1.21.0 esbuild
  echo "export { segmentForeground, preload } from '@imgly/background-removal';" > entry.mjs
  npx esbuild entry.mjs --bundle --format=esm --minify --platform=browser \
    --outfile=vendor/background-removal.mjs --legal-comments=eof
  ```

Les modèles (~100 Mo au premier lancement) viennent des CDN officiels
(jsDelivr pour le wasm MediaPipe, Google Storage pour le modèle de visage,
staticimgly.com pour le détourage) et sont gardés en cache par le service
worker : ensuite l'appli marche hors connexion.

Licences : IMG.LY background-removal est sous AGPL-3.0 (ce dépôt est public),
MediaPipe sous Apache-2.0.
