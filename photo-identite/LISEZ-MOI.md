# Photo d'identité — norme française

Une photo, et l'appli rend une planche 10×15 de 8 photos d'identité 35×45 mm
aux normes ANTS (ISO/IEC 19794-5). Tout tourne dans le navigateur : la photo ne
quitte pas l'appareil, pas de serveur, pas de clé d'API.

## Ce que fait l'appli

1. **Repères du visage** (MediaPipe Face Landmarker, 478 points) : yeux, menton,
   ovale, orientation de la tête, yeux ouverts, sourire, bouche ouverte.
2. **Détourage** (IMG.LY, modèle ISNet fp16) sur la seule zone utile autour de la
   tête, pour mettre toute la résolution du modèle sur les cheveux et les épaules.
3. **Cadrage** : tête redressée et centrée, ligne des yeux entre 50 et 70 % de
   la hauteur, sommet de la tête à 3,5–5 mm du bord haut. La norme mesure la
   tête « du menton au sommet du crâne, hors cheveux qui dépassent » (32–36 mm).
   Le sommet est trouvé sur le détourage, en remontant depuis le front :
   - cheveux courts ou plaqués, crâne rasé : c'est le haut visible de la tête,
     réglé à 35 mm (le crâne est ~1 mm dessous, toujours dans la tolérance) ;
   - cheveux qui dépassent (volume, chignon) : le repère est plafonné à
     0,9 × la distance pupilles–menton au-dessus des pupilles, réglé à 34,5 mm ;
   - silhouette inutilisable : estimation à 0,85 ×, 34 mm.
   Pupilles, menton et sommet détectés sont marqués sur le gabarit.
4. **Lumière** :
   - balance des blancs : la couleur de la peau varie peu d'une personne à
     l'autre dans le plan a*b* de CIELAB (teinte 47–58°, chroma ≤ 30), seule sa
     clarté change vraiment. Si une lampe (jaune) ou l'ombre (bleue) l'en fait
     sortir, des gains vert et bleu (von Kries, comme un appareil photo) l'y
     ramènent en bougeant le moins possible ; une peau déjà dans la zone n'est
     pas touchée ;
   - reflets : un point du visage plus clair ET plus blanc que la peau (front,
     nez qui brillent) est ramené vers la couleur moyenne de la peau, avec une
     clarté comprimée pour garder le relief ;
   - ombres : l'éclairage basse fréquence du visage est égalisé (moitié dans
     l'ombre, ombre sous le menton), la texture de la peau est gardée ;
   - exposition automatique, décontamination des bords (les cheveux ne gardent
     pas la couleur de l'ancien fond), légère netteté.
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
