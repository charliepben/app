# Mission Mars — ce dossier ne contient plus que les musiques

L'appli a déménagé dans le dépôt **privé** `charliepben/mission-mars`, parce que c'est la
mallette qui la sert : le WebSocket et la page doivent partager la même origine, sinon le
navigateur bloque la connexion (une page en HTTPS ne peut pas ouvrir un `ws://` vers une
adresse locale).

Ce qui reste ici : **`music/`, et rien d'autre.** 17 Mo de bande-son ne rentreront jamais
dans les 4 Mo de flash de l'ESP32 de la mallette. GitHub Pages sert donc de CDN gratuit,
et le téléphone garde les fichiers en cache après la première écoute.

Tout le reste — l'appli, le simulateur, les sons du jeu, les visuels, les icônes — fait
1,4 Mo et tient dans la mallette. Les sons du décompte, en particulier, doivent marcher en
forêt sans Internet : ils n'ont rien à faire ici.

*Licences des musiques : `music/LICENSE.txt`.*
