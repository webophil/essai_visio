# PhilDEV Visio — Phase 2.1

Application de visioconférence de PhilDEV, pensée pour les rendez-vous clients et la
collaboration avec un stagiaire. Interface entièrement en français, sans installation ni
création de compte pour les participants invités.

Cible de déploiement : `https://visio.phildev.online` — exemple de rendez-vous : `/rdv-aurore`.

Prévisualisation en ligne (FreeBuff Sites) :
`https://site-7d9cd941571b45a0933cc272119d3f4b.freebuff.page`. Cette adresse appartient au
projet de déploiement : elle change si le site est recréé.

> **Phase 2 : visioconférence réelle.** Les flux audio et vidéo transitent par **Cloudflare
> RealtimeKit** (SFU). Deux navigateurs distants se voient et se parlent réellement. Les invités
> rejoignent avec un lien, sans compte. Aucun participant n'est simulé.
>
> **Phase 2.1 :** nom de réunion personnalisable, flou d'arrière-plan calculé localement, et chat
> branché sur la messagerie native de RealtimeKit.

## Stack

| Élément | Choix |
| --- | --- |
| Interface | React 19 + TypeScript |
| Outillage | Vite 8 |
| Styles | Tailwind CSS 4 (plugin `@tailwindcss/vite`, thème déclaré dans `src/index.css`) |
| Icônes | `lucide-react` |
| Temps réel | `@cloudflare/realtimekit` 2.0.3 + `@cloudflare/realtimekit-react` 2.0.3 |
| Médias | SDK RealtimeKit (`Client.initMedia`) — une seule capture des périphériques |
| Effets vidéo | `addVideoMiddleware` du SDK + MediaPipe Selfie Segmentation (WebAssembly servi par l'application) |
| Routage | Routeur minimal interne (`src/lib/router.ts`, History API) |
| Lint | Oxlint (`npm run lint`) |
| Déploiement | FreeBuff Sites : Worker Cloudflare + assets statiques (voir « Déploiement ») |

## Architecture

```
Navigateur ──► Worker FreeBuff (/api/...)  ──► API Cloudflare RealtimeKit
    │             (jeton d'API, jamais exposé)
    └──────► Cloudflare RealtimeKit (SFU : audio, vidéo, partage d'écran)
```

| Fichier | Rôle |
| --- | --- |
| `worker/index.js` | Routeur : API (`/api/...`) puis service des assets avec repli SPA |
| `worker/realtimekit.js` | Client REST RealtimeKit (création de réunion, participants, presets) |
| `worker/hostAuth.js` | Session organisateur signée (HMAC-SHA-256), sans base de données |
| `worker/mailer.js` | Invitations par e-mail : un message par destinataire, contenu rédigé côté serveur |
| `worker/rateLimit.js` | Limitation de débit en mémoire (fenêtre glissante) |
| `src/meeting/transport/RealtimeKitTransport.ts` | Seule frontière avec le SDK côté navigateur |
| `src/media/useRtkMedia.ts` | Capture des périphériques par le SDK (écran de préparation) |
| `src/media/remoteAudio.ts` | Sélection des pistes audio distantes à restituer (pure, testée) |
| `src/media/backgroundBlur.ts` | Flou d'arrière-plan : détourage local puis composition du flux publié |
| `scripts/vendor-mediapipe.mjs` | Recopie le moteur de segmentation dans `public/vendor` (fichiers non versionnés) |
| `src/lib/meetingTitle.ts` | Nom de réunion : valeur par défaut, longueur maximale, normalisation |
| `src/components/meeting/RemoteAudio.tsx` | Sortie audio des participants distants (un `<audio>` par participant) |
| `src/meeting/rtkApi.ts` | Appels typés à l'API du Worker |
| `src/meeting/hostSession.ts` | Session organisateur et identifiant d'invité, côté navigateur |
| `src/meeting/useCreateMeeting.ts` | Création d'une réunion puis ouverture de la salle |
| `src/components/meeting/InviteByEmailPanel.tsx` | Envoi du lien et de l'heure du rendez-vous par e-mail (organisateur) |

Le SDK est la **source de vérité** des états audio/vidéo : les composants consomment
l'instantané produit par le transport (`MeetingSessionState`), jamais une intention locale. Aucune
capture `getUserMedia` parallèle n'est ouverte à côté de celle du SDK.

### Audio des participants distants

Le SDK rattache lui-même la **vidéo** aux éléments d'affichage (`participant.registerVideoElement`),
mais il ne fournit **aucune** sortie pour l'**audio** : sa lecture interne n'existe que derrière
l'option expérimentale `modules.experimentalAudioPlayback`, désactivée par défaut, et l'UI Kit
(`RtkParticipantsAudio`) n'est pas utilisé ici puisque l'interface est personnalisée. Sans élément
de lecture explicitement alimenté, une voix est donc reçue puis restituée nulle part.

`RemoteAudioSinks` monte un élément `<audio>` par participant distant et lui affecte un `MediaStream`
construit à partir de `participant.audioTrack` (et, le cas échéant, du son du partage d'écran),
conformément à l'exemple officiel livré avec le paquet. Deux règles tenues :

- **un seul élément par participant**, monté une fois pour la salle (jamais dans les vignettes, qui
  se démontent au changement de disposition) — aucune voix n'est jouée en double, et le son ne
dépend pas de l'affichage ;
- **aucune piste dupliquée** : `remoteAudioTracks()` dédoublonne par identifiant de piste.

Si le navigateur refuse la lecture automatique (`NotAllowedError`), un message explicite propose
« Activer le son » et la reprise est tentée dès le premier clic ou la première touche.

## Nom de la réunion

Le champ « Nom de la réunion » est proposé à la création, pré-rempli avec « Réunion PhilDEV » et
borné à 80 caractères (même limite côté navigateur et côté Worker). Le nom est transmis à
`POST /api/meetings` et enregistré comme **titre de la réunion RealtimeKit** : il n'y a ni base de
données, ni paramètre ajouté au lien d'invitation.

Chaque participant relit ce titre par `GET /api/meetings/:id`, qui ne renvoie que l'identifiant et
le nom (jamais un participant, jamais un jeton). Tant que ce titre n'est pas reçu — ou s'il est
absent — l'application retombe sur le nom dérivé de l'identifiant lisible (`/rdv-aurore` →
« Aurore »). Conséquence assumée : renommer une réunion existante demanderait un appel
supplémentaire à l'API RealtimeKit ; ce n'est pas proposé dans cette version.

## Chat

Le panneau Chat est branché sur la **messagerie native** du SDK (`client.chat`) :

- lecture de l'historique public à l'entrée en salle (`fetchPublicMessages`) puis réception en
direct (`chatUpdate`) ;
- envoi par `sendTextMessage`, avec la limite de longueur annoncée par le SDK ;
- auteur, heure et contenu affichés, défilement automatique, saisie pleine largeur sur mobile ;
- disponibilité lue dans le preset du participant (`permissions.chatPublic`) : si le profil
  n'autorise pas l'écrit, le panneau le dit et la saisie reste désactivée ;
- aucune persistance : l'application ne stocke aucun message et n'en relit aucun après la réunion.

### Partage de fichier

Un fichier peut être joint à la conversation, par l'organisateur comme par un invité :

- la commande est un trombone dans le pied du panneau ; le fichier part par `sendFileMessage`,
  qui le téléverse vers l'URL présignée de la réunion puis annonce un message de type `file`
  (nom, taille, lien) ;
- l'application **ne lit pas le contenu et ne le stocke pas** : elle n'affiche qu'un lien de
  téléchargement, valable pour les participants de la réunion. Rien n'est servi par notre serveur,
  et aucune base ni aucun compartiment de fichiers n'intervient ;
- le fichier vit avec la réunion chez la plateforme temps réel, qui applique sa propre durée de
  conservation : PhilDEV n'en garde aucune copie après la réunion ;
- l'envoi de fichiers a sa **propre autorisation** dans le preset du participant
  (`permissions.chatPublic.files`) : si elle est absente, le trombone reste visible mais désactivé,
  avec une infobulle qui l'explique — un participant peut donc écrire sans pouvoir joindre ;
- garde locale de 25 Mo par fichier (`MAX_CHAT_FILE_BYTES`) : au-delà, le fichier est refusé avant
  tout téléversement, plutôt que d'échouer en cours de route ; un fichier vide est également refusé ;
- la plateforme limite `sendFileMessage` à 20 envois par minute et par participant ; le panneau
  traduit ce refus en français, sans afficher le message brut du SDK.

Le rendu d'une bulle de fichier (nom, taille lisible, lien) et la désactivation de la commande
sont vérifiés par `npm run test:smoke` (groupe « panneau de chat »).

## Mise en page de la salle

La scène vidéo et le panneau latéral sont **indépendants en taille** :

- l'écran de réunion est borné au viewport (`h-dvh` + `overflow-hidden`) : la scène reçoit la
  hauteur restante, elle ne grandit jamais avec le contenu d'un panneau ;
- le panneau a une largeur **fixe** sur ordinateur (`22rem`, `min-w` = `max-w`) et `shrink-0` ;
  c'est sa zone de contenu qui défile (`min-h-0` + `overflow-y-auto`) ;
- les bulles de chat passent à la ligne même sur un « mot » de 600 caractères
  (`overflow-wrap: anywhere`) ;
- les vignettes n'ont **aucune hauteur minimale** : `min-h-0`/`min-w-0` + `auto-rows-fr`, et la
  vidéo est en `object-cover`, donc jamais déformée ;
- les `<video>` et le cadre d'attente sont **hors du flux** (`absolute inset-0`) : un élément
  remplacé ne peut pas dicter la hauteur d'une ligne de grille. Activer ou retirer un effet vidéo —
  donc remplacer la piste — ne change jamais la taille ni la disposition des cadres ;
- 1 vignette → 1 colonne, 2 à 4 → 2 colonnes, 5 et plus → 3 colonnes sur grand écran.

Ces règles vivent dans `src/components/meeting/layout.ts` et sont vérifiées par
`npm run test:smoke` (groupe « mise en page »), y compris le rendu réel du panneau de chat avec un
message très long.

## Flou d'arrière-plan

Le SDK installé (2.0.3) **ne fournit aucun effet de flou natif** : il expose en revanche
`addVideoMiddleware`, qui confie chaque image de la caméra à un canevas avant publication. C'est ce
point d'accroche qui est utilisé (`src/media/backgroundBlur.ts`) :

1. le détourage de la silhouette est calculé **sur l'appareil** par MediaPipe Selfie Segmentation
   (WebAssembly), servi depuis `public/vendor/mediapipe` — aucun CDN, aucun service externe ;
2. chaque image publiée est composée du fond réduit puis agrandi (flou économique) et de la
   silhouette nette découpée par le masque, contours adoucis ;
3. la piste audio et le partage d'écran ne sont jamais touchés, et **aucune seconde capture** de la
   caméra n'est ouverte : le SDK reste propriétaire de la piste.

### Géométrie du flux — cause d'un défaut corrigé

Le rendu par image du SDK dimensionne son canvas avec la **largeur de l'élément `<video>`** qu'il crée
(`canvas.height = video.width || settings.height`), pas avec la taille de la piste. Le flux publié
devenait carré, puis rogné par l'affichage (`object-cover`) : on ne voyait plus qu'une bande
horizontale du visage.

Le traitement prend donc le canvas en main (`setVideoMiddlewareGlobalConfig({
  disablePerFrameCanvasRendering: true })`) et compose lui-même chaque image, à la taille réelle de la
piste (plafonnée à 1280 px de large, rapport conservé). Le masque de détourage suit le rapport
d'image de cette image — auparavant figé en 16:9, il était étiré sur une vidéo carrée et ne
correspondait plus à la silhouette.

Le panneau affiche la taille réellement publiée (`flux 1280×720`) : c'est la valeur à vérifier en
premier si l'image paraît déformée.

### Lecture du masque — cause d'un défaut corrigé

MediaPipe n'encode **pas** son masque en niveaux de gris opaques : le convertisseur GPU écrit
`vec4(m, 0, 0, m)`, c'est-à-dire la valeur du masque **dans le rouge et dans l'alpha**, vert et bleu
à zéro. Lire la luminance des trois canaux donnait `0,299 × m` : la silhouette n'était donc
restaurée qu'à ~30 % d'opacité, et le fond flou transparaissait à travers le visage — l'image
entière semblait floue.

`applyPersonMask` lit désormais le rouge et l'alpha (équivalents), applique une rampe douce
(15 % → 60 %) qui rend le premier plan **totalement net** tout en gardant un contour fondu, et
renvoie la couverture de la silhouette. Si aucune silhouette n'est détectée (< 0,5 % de l'image),
l'image reste nette : un masque inexploitable ne peut plus produire une vidéo entièrement floue.

### Chargement du moteur — cause d'un défaut corrigé

Le paquet `@mediapipe/selfie_segmentation` est un **script classique** qui publie son constructeur
sur `window.SelfieSegmentation`. Compilé dans le bundle, il ne produit **aucun export ES** :
l'ancien `import { SelfieSegmentation }` valait `undefined`, la fabrique du middleware levait, et le
SDK — qui intercepte ces erreurs — republiait la piste brute en répondant `success: true`.
L'interface affichait donc « Flou · Actif » sans le moindre effet, chez soi comme chez les autres.

Le moteur est désormais chargé par une balise `<script>` servie par l'application
(`/vendor/mediapipe/selfie_segmentation/selfie_segmentation.js`, même origine), exactement comme le
documente MediaPipe : plus aucune dépendance à l'interopérabilité du bundler.

Comme le SDK applique un middleware « en silence », trois contrôles rendent désormais tout échec
visible, avant d'annoncer que l'effet est actif :

1. le moteur doit produire un **masque de test** sur une image locale (aucune image de caméra) ;
2. la piste publiée (`videoTrack`) doit être **différente** de la piste brute (`rawVideoTrack`) ;
3. au moins une image doit **atteindre le traitement** dans les 4 secondes.

Chacun de ces contrôles échoue avec un message en français, retire le middleware et laisse la
caméra normale. Le panneau « Effets de fond » affiche en complément des compteurs (images reçues,
images recomposées, détourages calculés par seconde) et la **couverture de la silhouette** : des
**nombres uniquement**, jamais une image.

Choix de conception :

- **opt-in** — « Aucun effet » est l'état par défaut ;
- détourage à ~14 images/s, masque réutilisé entre deux calculs, silhouette plafonnée à 960 px de
  large : le coût reste borné sur une machine modeste ;
- si le navigateur n'accepte pas les middlewares (WebKit ancien) ou si le moteur ne se charge pas,
  l'ajout échoue **explicitement** : l'interface revient à « Aucun effet », affiche un message, et
  la caméra continue d'être diffusée normalement ;
- le moteur (~6 Mo de WebAssembly + modèle) n'est téléchargé qu'au premier passage en « Flou »,
  puis mis en cache par le navigateur.

Les fichiers du moteur ne sont pas versionnés (`public/vendor/` est ignoré) :
`scripts/vendor-mediapipe.mjs` les recopie depuis `node_modules` à chaque `npm run dev` et
`npm run build` (crochets `predev` / `prebuild`), sans réseau.

## Secrets et identifiants

| Nom | Type | Rôle |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | **secret** (FreeBuff Sites) | Jeton d'API Cloudflare à portée « Realtime Admin ». Utilisé uniquement par le Worker. |
| `PHILDEV_HOST_KEY` | **secret** (FreeBuff Sites) | Clé organisateur, à définir par PhilDEV. Comparée à temps constant ; sert à signer la session. |
| `RESEND_API_KEY` | **secret** (FreeBuff Sites) | Clé d'API du fournisseur d'e-mail (Resend). Utilisée uniquement par le Worker, jamais renvoyée au navigateur. |

Sans `PHILDEV_HOST_KEY`, l'accès organisateur répond `503 host-key-missing` : la création de
réunion et le rôle d'hôte restent fermés, les invités ne sont pas affectés.

Sans `RESEND_API_KEY`, l'envoi d'invitations répond `503 mail-not-configured` : la réunion et la
salle restent utilisables, seul l'envoi d'e-mails est désactivé. Le domaine `phildev.online` doit
en plus être **vérifié** chez le fournisseur (enregistrements DNS) avant le premier envoi.
L'expéditeur par défaut est `PhilDEV Visio <invitation@phildev.online>` ; `MAIL_FROM` le surcharge
(variable simple ou secret, seule la valeur compte, espaces retirés). Une adresse **nue**
(`contact@phildev.online`) s'affiche telle quelle dans les boîtes de réception ; pour garder le nom
visible, utilisez la forme `PhilDEV Visio <contact@phildev.online>`. Le domaine de cette adresse
doit être vérifié chez le fournisseur, sinon l'envoi est refusé.

L'identifiant de compte (`adad9ec2e55b7a9279e74eea378c3a54`) et l'application RealtimeKit
(`09fe762d-4e8d-45c7-9129-a466ae061711`) sont des valeurs **non secrètes**, déclarées dans
`worker/realtimekit.js` et surchargeables par `RTK_ACCOUNT_ID` / `RTK_APP_ID`. Les noms de presets
(`group_call_host`, `group_call_participant`) sont surchargeables par `RTK_HOST_PRESET` /
`RTK_GUEST_PRESET`.

> Le jeton d'API n'est jamais transmis au navigateur, jamais journalisé et jamais renvoyé dans une
> réponse. Seuls les jetons **participant** (portée limitée à une réunion et à un preset)
> franchissent la frontière serveur → navigateur, uniquement au moment d'entrer en salle.

## API du Worker

| Méthode | Chemin | Accès | Rôle |
| --- | --- | --- | --- |
| `GET` | `/api/health` | public | Disponibilité du service (avec version et commit déployés) |
| `GET` | `/api/version` | public | Version applicative et commit Git réellement déployés |
| `POST` | `/api/host/session` | clé organisateur | Échange la clé contre une session signée (30 jours) |
| `POST` | `/api/meetings` | **session hôte** | Crée une réunion et réserve l'emplacement de l'organisateur |
| `POST` | `/api/meetings/:id/invitations` | **session hôte** | Envoie le lien et l'heure du rendez-vous par e-mail (invités puis organisateur) |
| `GET` | `/api/meetings/:id` | public | Nom de la réunion (identifiant et titre uniquement) |
| `POST` | `/api/rtk/token` | public (invité) / session (hôte) | Délivre un jeton de participation |
| `GET` | `/api/rtk/diagnostic` | **session hôte** | État en lecture seule (presets, configuration) — aucun secret |

Garanties communes : réponses `Cache-Control: no-store`, refus des mutations cross-origin,
limitation de débit par adresse cliente, et messages d'erreur en français sans détail amont.

### Limite de cinq participants

Le décompte s'appuie sur l'API RealtimeKit : les **identifiants participants distincts** de la
réunion sont comptés au moment où un invité demande son jeton. L'organisateur occupe le premier
emplacement (réservé dès la création), ce qui laisse quatre invités. Deux conséquences voulues :

- une **reconnexion** ne consomme pas d'emplacement supplémentaire (le même identifiant est
  réutilisé, il est mémorisé par navigateur et par réunion) ;
- l'**organisateur n'est jamais bloqué**, même si la salle est pleine.

Limite assumée : le comptage porte sur les participants **enregistrés**, pas sur une présence
temps réel (l'API RealtimeKit n'expose pas d'état « connecté » sur cette ressource). Un invité qui
obtient un jeton sans entrer occupe donc un emplacement. Une garantie stricte exigerait soit la
ressource « session active » de RealtimeKit, soit un compteur partagé (D1 ou Durable Object) —
volontairement écartés à ce stade.

### Accès organisateur

La clé `PHILDEV_HOST_KEY` n'est envoyée qu'une fois, au serveur, qui la compare à temps constant et
renvoie une session **signée** (`payload.signature`, HMAC-SHA-256) avec sa date d'expiration. Le
navigateur ne conserve que cette session, révocable depuis la boîte de dialogue « Accès
organisateur ». Les invariants vérifiés par les tests : création de réunion et attribution du
preset `group_call_host` impossibles sans session valide, et jeton d'API absent de toutes les
réponses.

## Invitations par e-mail

Depuis l'écran d'accès (`/rdv-…?r=…`), l'organisateur ouvre « Inviter par e-mail », saisit les
adresses, la date et l'heure du rendez-vous, puis envoie. Chaque adresse — la sienne comprise —
reçoit le nom de la réunion, l'heure en clair (heure de Paris), le lien complet et le rappel
qu'aucun compte n'est nécessaire. Il peut ensuite **fermer la page** : la réunion RealtimeKit
existe déjà, rien ne dépend de l'onglet resté ouvert.

Trois choix tenus côté Worker :

- **un message par destinataire** — les invités ne voient pas les adresses des autres, et un refus
  isolé n'annule pas les envois déjà faits ; la réponse indique le nombre parti et les adresses en
  échec, jamais le corps d'erreur du fournisseur ;
- **contenu rédigé côté serveur** — sujet et corps sont construits à partir du titre RealtimeKit de
  la réunion, jamais d'un texte venu du navigateur : le domaine d'envoi ne peut pas servir de
  relais. L'endpoint exige la session hôte et applique sa propre limite de débit (six envois par
  quart d'heure et par adresse cliente) ;
- **rien n'est persisté** — ni la liste des invités, ni l'heure du rendez-vous. Elle vit dans le
  message envoyé, ce qui évite une base de données pour une information qui n'a pas à être relue.

Limites assumées : six adresses au maximum par envoi, et l'heure du rendez-vous **n'apparaît pas
sur la page** — elle est dans l'e-mail. L'afficher dans la salle demanderait une persistance que
le projet n'a pas.

## Démarrage

```bash
npm install
npm run dev        # http://localhost:3000
```

Les endpoints `/api/...` n'existent qu'une fois déployés (Worker). En développement local, la page
d'accueil l'indique explicitement : créez et testez les réunions depuis l'adresse de
prévisualisation.

### Vérifications

```bash
npm run typecheck       # TypeScript
npm run lint            # Oxlint
npm run test:smoke      # routeur, identifiants, formatage, rendu des écrans
npm run test:worker     # Worker : routage, repli SPA, API, autorisations, capacité, anti-fuite
npm run build           # artefact publiable : dist/ + worker/version.js estampillé
npm run verify:artifact # manifeste, modules, imports, assets : refuse un artefact non publiable
npm run check:deployed  # compare /api/version en production au commit local
```

`verify:artifact` revérifie ce que la plateforme refusera ou masquera : un module importé mais
absent du manifeste, un `index.html` pointant un asset inexistant, une source map, un fichier
d'environnement, ou un dépassement des limites (1 000 fichiers, 10 Mio).

`check:deployed` sort en `0` si la production sert le commit local, `1` en cas d'écart (production
en avance ou en retard sur le dépôt) et `2` si l'endpoint est absent. C'est le contrôle qui rend
impossible la panne d'origine : une production plus récente que le dépôt.

`test:worker` exécute le handler `fetch` du Worker avec un binding `ASSETS` simulé et une API
Cloudflare RealtimeKit interceptée : aucun appel réseau réel, aucune réunion créée.

Ces commandes tournent aussi dans **GitHub Actions** (`.github/workflows/ci.yml`) à chaque pull
request et sur `main`, avec en plus la construction de l'artefact et sa vérification
(`verify:artifact`). Le workflow **ne déploie rien** : il empêche de fusionner du code dont les
types, le lint, les tests ou l'artefact échouent.

### Vérifications manuelles (deux machines)

Le flou et le chat engagent du matériel et deux navigateurs : ces deux points se contrôlent à la
main, depuis l'adresse de prévisualisation.

> Depuis la PR #4, l'entrée « Effets » est retirée de la barre de contrôle
> (`src/components/meeting/ControlBar.tsx`) : le moteur et son panneau restent dans le code, mais
> les étapes 7 à 10 bis ci-dessous décrivent une fonctionnalité **non exposée** aujourd'hui, à
> réactiver avant de les rejouer.

| Étape | Attendu |
| --- | --- |
| 1. Accès organisateur puis création avec le nom « Rendez-vous Aurore Studer » | La salle affiche ce nom en en-tête, à la place du nom déduit de l'identifiant |
| 2. Ouverture du **même lien** sur un second PC, avec un autre nom de participant | Le nom de la réunion est identique pour les deux ; « Participants » liste les deux |
| 3. Audio : parler dans un sens puis dans l'autre | Voix audible des deux côtés, sans écho (un seul `<audio>` par participant distant) |
| 4. Vidéo : activer puis couper la caméra de chaque côté | Les vignettes suivent l'état réel, la voix continue de passer |
| 5. Partage d'écran depuis un PC | L'écran occupe la scène, les caméras passent en vignettes, le son du partage est audible |
| 6. Chat : un message depuis chaque PC | Message affiché avec auteur et heure des deux côtés ; si le preset interdit l'écrit, le panneau l'explique au lieu d'échouer |
| 7. Effets : « Flou » sur un PC | Le panneau affiche des compteurs non nuls (≈ 20 images/s reçues, ≈ 14 détourages/s) et une silhouette détectée entre 10 % et 70 % ; **visage et silhouette parfaitement nets**, arrière-plan flou **chez vous et chez l'autre participant** ; le retour à « Aucun effet » rétablit l'image d'origine |
| 8. Effets sur un navigateur WebKit ancien ou sans WebAssembly SIMD | Message d'échec explicite, caméra normale conservée, aucun écran noir |
| 9. En pleine réunion, basculer « Aucun effet » → « Flou » → « Aucun effet » | Le changement s'applique en une à deux secondes, sans couper la voix ; les compteurs repartent à chaque activation, l'image d'origine revient au retrait |
| 10. Ouvrir « Participants », « Chat » puis « Effets » ; envoyer un message de 500 caractères sans espace | La taille des vidéos ne change pas, le panneau défile seul, le message passe à la ligne ; à 2, 3, 4 puis 5 participants la grille reste équilibrée et les images ne sont pas déformées |
| 10 bis. Activer puis retirer « Flou », seul, puis à deux participants | Aucun saut : les cadres gardent exactement la même taille et la même place pendant le remplacement de la piste |
| 11. Partager l'écran pendant qu'un panneau est ouvert | L'écran garde son ratio (`object-contain`), l'incrustation webcam reste en 16:9 dans le coin |

Si le chat reste indisponible alors que le panneau est ouvert, vérifier dans le tableau de bord
Cloudflare RealtimeKit que le preset utilisé (`group_call_host`, `group_call_participant`) autorise
les messages écrits.

## Déploiement — FreeBuff Sites

L'artefact publié est **`dist/`**, produit par `npm run build`, servi par le Worker Cloudflare.
Deux fichiers versionnés suffisent à reproduire un déploiement :

| Fichier | Rôle |
| --- | --- |
| `preview.manifest.json` | Manifeste : `entrypoint`, `modules` (7 fichiers du Worker, dont `version.js`), `assetsDirectory` |
| `worker/*.js` | Worker : API RealtimeKit puis service des assets |

`dist/` n'est pas versionné : il est reconstruit par `npm run build` avant tout déploiement.
Depuis la Phase 2.1, `dist/` contient aussi le moteur de segmentation (~6 Mo, servi sous
`/vendor/mediapipe/…`) : l'artefact complet pèse environ 7 Mo, sous la limite de 10 Mio imposée à
un déploiement.

### Déploiement explicite uniquement

Un déploiement est **toujours un appel explicite** à l'outil Sites, avec un environnement
(`preview` ou `production`) et une clé d'idempotence. Le dépôt contient un workflow d'intégration
continue (`.github/workflows/ci.yml`), mais **aucune configuration de déploiement** (ni
`wrangler.toml`, ni secret Cloudflare dans GitHub) et le site n'est relié à aucun dépôt :
**un commit ou un push GitHub ne déclenche aucun déploiement**. La production n'est jamais publiée
sans autorisation explicite.

### Connaître la version déployée

`worker/version.js` est **généré** : `scripts/stamp-version.mjs` l'écrit avant chaque
`npm run build` (crochet `prebuild`) à partir de `package.json` et du commit Git courant. Le Worker
étant déployé module par module, sans bundler, sa version doit vivre dans un fichier du dépôt.

```bash
curl -s https://visio.phildev.online/api/version
# {"service":"phildev-visio","version":"2.1.0","commit":"10f4cda","commitDate":"…"}
```

Deux règles :

- **construire depuis un arbre propre** — le commit annoncé est celui de `HEAD`. Si un fichier suivi
  est modifié, la valeur devient `<commit>-dirty` : un `-dirty` en production signale une
  publication non traçable, et c'est volontaire ;
- la copie **versionnée** de `worker/version.js` retarde donc d'un commit sur la copie construite
  juste après (le fichier ne peut pas contenir son propre SHA). C'est la valeur servie par
  `/api/version` qui fait foi, pas celle du dépôt ;
- une publication automatisée supprime ce décalage : la construction part d'un checkout propre, où
  `HEAD` est exactement le commit publié.

### CSP et HSTS

`worker/securityHeaders.js` applique la politique CSP **bloquante** (`CSP_ENFORCED = true`) et
`Strict-Transport-Security: max-age=31536000; includeSubDomains`. La politique autorise les hôtes
réellement utilisés par le SDK : API `api.realtime.cloudflare.com`, signaling
`wss://*.realtime.cloudflare.com`, et les domaines `dyte.in` / `dyte.io` que RealtimeKit (bâti sur
Dyte) porte encore dans son code. Le beacon d'analytics de la plateforme reste bloqué : il lit
`localStorage`.

Retour arrière d'urgence : repasser `CSP_ENFORCED` à `false` et redéployer — la politique redevient
un simple rapport, sans blocage.

### Pourquoi `spa: true` doit rester absent du manifeste

Le drapeau `spa: true` délègue la gestion des chemins inconnus à la couche **assets** de la
plateforme, qui répond alors `index.html` avec un statut **200** pour *toute* requête sans
correspondance — y compris un JavaScript, un CSS, une image ou une source map absents. Une erreur
de livraison se retrouve ainsi masquée par une page d'accueil « 200 », et le Worker n'est même pas
consulté. Le manifeste reste donc volontairement sans `spa` : la décision revient au Worker, où
elle est explicite et testable.

### Repli SPA du Worker

`worker/index.js` ne sert `index.html` que si la requête est une **navigation de l'application**,
ce qui exige les trois conditions suivantes :

1. méthode `GET` ou `HEAD` ;
2. dernier segment du chemin **sans extension** (donc pas `/assets/index-abc123.js`) ;
3. `Sec-Fetch-Mode: navigate` (signal envoyé par les navigateurs modernes) ou, à défaut,
   `Accept` contenant `text/html`.

Tout le reste conserve son statut d'origine : une ressource absente reste **404**. Une navigation
vers `/rdv-aurore?r=…` reçoit `index.html` en 200, puis le routeur client (`src/lib/router.ts`)
prend la suite.

> Nuance mesurée en ligne : la plateforme injecte son beacon d'analyse (Cloudflare Web Analytics)
> dans les documents servis à une navigation. Le document reçu peut donc compter quelques
> centaines d'octets de plus que `dist/index.html` ; le reste du contenu est identique.

## Liens d'invitation

Un identifiant lisible (`/rdv-aurore`) nomme le rendez-vous ; la réunion Cloudflare, elle, est
désignée par un identifiant transporté par le lien : `/rdv-aurore?r=<uuid>`. Ce paramètre **n'est
pas un secret** — le lien est l'invitation — mais il ne contient jamais de jeton de participation :
chaque participant reçoit le sien au moment d'entrer.

Conséquence : un lien réduit à `/rdv-aurore`, sans `?r=`, n'ouvre aucune réunion. L'application le
dit clairement et propose à l'organisateur de rattacher le rendez-vous à une nouvelle réunion.
Rendre les identifiants lisibles résolvables sans paramètre demanderait une table de
correspondance persistée (D1) — hors périmètre à ce stade.
