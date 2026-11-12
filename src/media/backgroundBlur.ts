import type { RTKSelfMedia, VideoMiddleware } from '@cloudflare/realtimekit'

import type { VideoEffectChoice } from '../types/meeting'
import { paintBackdrop } from './backdrops'
import type { MaskDiagnostics } from './maskDiagnostics'

/**
 * Effets de fond (flou et décors) — traitement **entièrement local**.
 *
 * Le SDK RealtimeKit n'expose aucun effet de fond natif : il fournit un point
 * d'accroche, `addVideoMiddleware`. Ce module s'appuie dessus :
 *
 * 1. un détourage de la silhouette est calculé localement par MediaPipe Selfie
 *    Segmentation (WebAssembly servi par l'application, aucun service externe) ;
 * 2. l'image publiée est composée d'un fond — flouté, teinte peinte ou image
 *    importée — et de la silhouette nette.
 *
 * **Le rendu est piloté ici, pas par le SDK.** La raison est mesurable : le
 * pipeline interne du SDK dimensionne son canvas avec la largeur de l'élément
 * `<video>` qu'il crée (`canvas.height = video.width || settings.height`), soit
 * une valeur d'attribut, pas la taille réelle de la caméra. La piste publiée
 * devenait carrée, puis rognée par l'affichage. Avec
 * `disablePerFrameCanvasRendering`, le SDK nous confie le canvas : sa taille est
 * celle de la caméra, le masque a le même rapport d'image que l'image, et
 * l'alignement personne / fond est exact.
 *
 * Aucune seconde capture de la caméra n'est ouverte : nous consommons la piste
 * brute du SDK (`rawVideoTrack`), et la piste audio n'est jamais touchée.
 */

/** Dossier des fichiers du moteur, servis depuis `public/vendor`. */
const ENGINE_PATH = '/vendor/mediapipe/selfie_segmentation'

/**
 * Le moteur est chargé par une **balise `<script>` servie par l'application**,
 * jamais par un `import` du bundle.
 *
 * Le paquet npm `@mediapipe/selfie_segmentation` est un script classique qui
 * publie son constructeur sur `window.SelfieSegmentation`. Compilé par
 * le bundler, il produit un module **sans aucun export** : l'ancien
 * `import { SelfieSegmentation }` valait `undefined`, la fabrique du middleware
 * levait, le SDK retombait silencieusement sur la piste brute et l'interface
 * affichait « Flou · Actif » sans le moindre effet.
 */
export const BLUR_ENGINE_SCRIPT_URL = `${ENGINE_PATH}/selfie_segmentation.js`

/** Cadence de composition du flux publié. */
const FRAME_INTERVAL_MS = 50

/** Fréquence du détourage : entre deux calculs, le dernier masque est réutilisé. */
const SEGMENT_INTERVAL_MS = 80

/**
 * Gain appliqué à l'image **d'entrée du détourage**, jamais au flux publié.
 *
 * Sur une pièce sombre, la confiance du modèle sur un visage peu éclairé tombait
 * à 30–40 % : une joue sortait du masque et le décor la remplaçait. Mesuré sur
 * une capture réelle, avec le moteur et ce code exacts : 39 % de la tête
 * au-dessus du seuil sans correction, 82 % avec ce gain de 1,2, et aucun faux
 * positif dans le fond. L'image publiée n'est jamais modifiée.
 */
const SEGMENT_LIFT = 'brightness(1.2)'

/** Largeur du plan de travail : inutile de segmenter en pleine résolution. */
const WORK_WIDTH = 480

/**
 * Résolution du masque.
 *
 * À 160 px de large, une mèche de cheveux ou un avant-bras tenait sur deux
 * pixels : le contour « bouillait » d'une image à l'autre. 256 px stabilisent
 * la silhouette sans alourdir le détourage, qui travaille de toute façon sur
 * son propre plan interne.
 */
const MASK_WIDTH = 256

/** Diviseur appliqué au fond avant agrandissement (flou économique). */
const BLUR_DIVISOR = 6

/**
 * Rayon de lissage appliqué en agrandissant le fond réduit.
 *
 * Un agrandissement bilinéaire seul laisse des blocs visibles sur les aplats
 * (un mur uni devient une mosaïque). Ce flou-là efface les blocs sans coûter
 * un passage plein cadre sur la vidéo.
 */
const BACKDROP_BLUR_PX = 5

/**
 * Rayon d'adoucissement du contour, **en pixels du flux publié**.
 *
 * Il s'appliquait auparavant au calque « personne », large de 480 px : les
 * 4 px devenaient ~11 px une fois ce calque agrandi à 1280, d'où un visage très
 * flou. Le calque est désormais à la résolution publiée et ce rayon vaut ce
 * qu'il annonce.
 */
const FEATHER_PX = 2

/**
 * Part de la nouvelle mesure dans le masque affiché, à l'arrêt.
 *
 * Le détourage est calculé image par image : sans mémoire, un contour hésitant
 * (cheveux, lunettes, main qui passe) scintille à chaque calcul. Ce lissage
 * exponentiel stabilise le contour tant que la silhouette ne bouge pas.
 */
const MASK_SMOOTHING_STILL = 0.35

/**
 * Part de la nouvelle mesure quand la silhouette bouge.
 *
 * Un lissage fixe à 55 % laissait, à chaque mouvement, un fantôme de l'ancienne
 * silhouette mêlé à la nouvelle : le contour semblait très flou. Dès que le
 * masque change nettement, la mesure fraîche prend presque toute la place.
 */
const MASK_SMOOTHING_MOVING = 0.82

/** Variation moyenne d'alpha (0–1) au-delà de laquelle on parle de mouvement. */
const MASK_MOTION_THRESHOLD = 0.09

/**
 * Nombre d'analyses vides tolérées avant d'admettre que la personne est sortie.
 *
 * Une analyse peut ne plus rien détecter pendant un mouvement rapide. Sans ce
 * délai, le fond n'était plus composé et l'image brute de la pièce réapparaissait
 * un dixième de seconde : le décor semblait « gommer » la personne.
 */
const MAX_HELD_MASKS = 4

/**
 * Largeur maximale du calque « personne nette ».
 *
 * Il valait la largeur du plan de travail (480 px) : le visage était réduit
 * puis agrandi à chaque image, donc structurellement mou. Le calque est
 * désormais à la résolution publiée.
 */
const PERSON_MAX_WIDTH = 1280

/** Largeur maximale du flux publié (une webcam 1440p est ramenée à 1280 px). */
const MAX_FRAME_WIDTH = 1280

/**
 * Seuil de confiance à partir duquel un pixel appartient **franchement** à la
 * personne (fraction de 255).
 *
 * À 42 %, la joue d'un visage éclairé de côté restait hors de la silhouette :
 * elle formait un trou franc, remplacé par le décor, alors que le contour du
 * vêtement restait net. Le modèle n'y donne que 30–40 % de confiance. À 30 %,
 * cette zone est retenue ; les pixels de fond isolés qui passent le seuil sont
 * ensuite retirés par `despecklePersonMap`.
 */
const MASK_SOLID_LEVEL = 0.3

/** Même seuil, exprimé en valeur de masque entière (0–255). */
const PERSON_LEVEL = Math.round(MASK_SOLID_LEVEL * 255)

/**
 * Début de la rampe d'anticrénelage du contour (fraction de 255).
 *
 * Elle s'applique au pixel de **silhouette** collé au décor : c'est lui qui
 * s'estompe légèrement. Peindre le pixel de décor voisin, comme avant, collait
 * un cerne de la pièce réelle autour de la tête — un halo gris qui scintillait
 * à chaque mouvement du masque.
 */
const MASK_EDGE_LOW = 0.18

/**
 * Part maximale de l'image qu'un trou intérieur peut occuper pour être comblé.
 *
 * Un trou plus grand qu'1 % du cadre est un vrai jour (bras écarté du torse) :
 * le combler collerait le bras au corps et mangerait le décor.
 */
const MAX_HOLE_RATIO = 0.01

/**
 * En dessous de cette couverture, aucun premier plan n'est détecté.
 *
 * Une analyse dans cet état n'est pas utilisée telle quelle : tant qu'un masque
 * fiable existe, le dernier conservé est réutilisé (voir `MAX_HELD_MASKS`).
 * Passé ce délai, la personne est considérée comme sortie du champ et seul le
 * fond est publié — jamais l'image brute de la pièce.
 */
const MIN_PERSON_COVERAGE = 0.005

/** Délai maximal accordé au moteur pour produire un premier masque. */
const ENGINE_WARMUP_TIMEOUT_MS = 12000

/** Délai laissé à la piste brute pour alimenter le traitement en images. */
const FRAME_ARRIVAL_TIMEOUT_MS = 4000

/**
 * Taille du plan de travail pour une image source.
 * Bornée à `WORK_WIDTH` et conservée paire (les arrondis impairs créent des
 * coutures visibles sur certains pilotes graphiques).
 */
export function normalizedWorkSize(width: number, height: number): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 }

  const scale = Math.min(1, WORK_WIDTH / width)
  const scaledWidth = Math.max(2, Math.round((width * scale) / 2) * 2)
  const scaledHeight = Math.max(2, Math.round((height * scale) / 2) * 2)

  return { width: scaledWidth, height: scaledHeight }
}

/**
 * Taille du flux publié, déduite de la **piste réelle** et non d'un attribut
 * HTML. La largeur est plafonnée, le rapport d'image est conservé au pixel.
 */
export function normalizedFrameSize(
  width: number,
  height: number,
): { width: number; height: number } {
  const sourceWidth = width > 0 ? width : 1280
  const sourceHeight = height > 0 ? height : 720
  const targetWidth = Math.max(2, Math.round(Math.min(MAX_FRAME_WIDTH, sourceWidth) / 2) * 2)
  const targetHeight = Math.max(
    2,
    Math.round(((targetWidth * sourceHeight) / sourceWidth) / 2) * 2,
  )

  return { width: targetWidth, height: targetHeight }
}

/**
 * Taille du masque pour une image donnée.
 *
 * Le masque **doit** avoir le rapport d'image de l'image source : un masque
 * figé en 16:9 sur une vidéo carrée était étiré verticalement, et la silhouette
 * restaurée ne correspondait plus au visage (d'où une image entièrement floue).
 */
export function maskSizeFor(
  frameWidth: number,
  frameHeight: number,
  maskWidth = MASK_WIDTH,
): { width: number; height: number } {
  if (frameWidth <= 0 || frameHeight <= 0) {
    return { width: maskWidth, height: Math.round(maskWidth * 0.5625) }
  }

  return {
    width: maskWidth,
    height: Math.max(1, Math.round((maskWidth * frameHeight) / frameWidth)),
  }
}

/**
 * État temporel du masque : confiance lissée et dernière mesure brute.
 *
 * Le lissage porte sur la **confiance**, jamais sur l'opacité finale. Mélanger
 * des opacités binaires (0 ou 255) revient à moyenner des décisions : une tête
 * que le modèle hésite à garder finissait à demi transparente, et le décor se
 * voyait au travers. Lisser la confiance puis décider donne des pixels
 * franchement opaques ou franchement transparents, avec un contour stable.
 */
export interface MaskTemporalState {
  /** Confiance lissée, une valeur par pixel du masque. */
  values: Float32Array | null
  /** Mesure brute de l'analyse précédente, pour estimer le mouvement. */
  raw: Uint8Array | null
}

/** État temporel vide : la première analyse sème la mesure telle quelle. */
export function createMaskTemporalState(): MaskTemporalState {
  return { values: null, raw: null }
}

/**
 * Mouvement apparent du masque entre deux analyses (variation moyenne, 0–1).
 *
 * Le seuil de mouvement reste bas parce qu'une tête qui tourne ne modifie
 * qu'une petite fraction des pixels : une moyenne plein cadre sous-estime
 * largement le déplacement réel.
 */
export function maskValueMotion(previous: Uint8Array | null, next: Uint8Array): number {
  if (!previous || previous.length !== next.length) return 1

  let total = 0
  for (let index = 0; index < next.length; index += 1) {
    total += Math.abs(next[index] - previous[index])
  }

  return total / next.length / 255
}

/**
 * Mélange les confiances du masque au précédent, **sur place**.
 *
 * Le poids vient de `smoothingWeight` : faible à l'arrêt (le contour se
 * stabilise), fort en mouvement (il suit sans traînée).
 */
export function smoothMaskValues(
  previous: Float32Array,
  next: Uint8Array,
  weight = MASK_SMOOTHING_STILL,
): void {
  const keep = 1 - weight
  for (let index = 0; index < next.length; index += 1) {
    previous[index] = previous[index] * keep + next[index] * weight
  }
}

/**
 * Budget **cible** de l'historique des images de détourage.
 *
 * Chaque image est une copie pleine résolution du flux : 3,5 Mio en 1280×720,
 * 7,9 Mio en 1920×1080, 31,6 Mio en 3840×2160. Seize images coûtaient jusqu'à
 * 59 Mo en 720p ; la cible les ramène à huit, soit 28 Mio (200 ms à 30 i/s).
 *
 * Ce n'est qu'une cible : sous huit images, l'historique ne couvrirait plus la
 * latence du détecteur. Elle est tenue jusqu'à 540p (douze images, 24 Mio) ;
 * dès 720p le plancher l'emporte — 28 Mio en 720p, 63 Mio en 1080p, 253 Mio en
 * 4K.
 */
const FRAME_HISTORY_BUDGET = 24 * 1024 * 1024

/** En dessous, l'historique ne couvrirait plus la latence d'un détecteur lent. */
const FRAME_HISTORY_MIN = 8

/** Au-dessus, le gain d'alignement devient négligeable devant la mémoire. */
const FRAME_HISTORY_MAX = 16

/**
 * Nombre d'images d'historique pour une résolution donnée.
 *
 * Le nombre décroît avec la taille des images : la cible de 24 Mio est tenue
 * jusqu'à 540p. Dès 720p, le plancher de huit images l'emporte et la mémoire
 * réelle dépasse la cible (28 Mio en 720p, 63 Mio en 1080p), ce qui reste
 * préférable à un historique trop court, lequel casserait l'alignement.
 */
export function frameHistorySize(width: number, height: number): number {
  const bytesPerFrame = Math.max(1, width * height * 4)
  const affordable = Math.floor(FRAME_HISTORY_BUDGET / bytesPerFrame)
  return Math.max(FRAME_HISTORY_MIN, Math.min(FRAME_HISTORY_MAX, affordable))
}

/**
 * Index de l'image à composer pour un masque donné.
 *
 * Le détecteur travaille sur une image envoyée quelques dizaines de
 * millisecondes plus tôt. Composer son masque sur l'image **courante** décale
 * la silhouette de toute cette latence : une joue est coupée d'un côté et le
 * décor apparaît de l'autre, d'autant plus que la personne bouge.
 *
 * On rejoue donc les images réelles : on prend la plus récente dont
 * l'horodatage précède l'instant demandé. Si toutes sont plus récentes (première
 * analyse), la plus récente est retenue.
 */
export function frameIndexAt(times: readonly number[], time: number): number {
  let best = -1
  let bestAt = Number.NEGATIVE_INFINITY

  for (let index = 0; index < times.length; index += 1) {
    const at = times[index]
    if (at <= time && at > bestAt) {
      best = index
      bestAt = at
    }
  }

  if (best >= 0) return best

  // Aucune image ne précède l'instant demandé. S'il est plus ancien que tout
  // l'historique, on prend la plus ancienne : la silhouette reste alignée, elle
  // accuse simplement un peu plus de retard. S'il est plus récent (première
  // analyse), on prend la plus récente.
  let oldest = 0
  let newest = 0
  for (let index = 1; index < times.length; index += 1) {
    if (times[index] < times[oldest]) oldest = index
    if (times[index] > times[newest]) newest = index
  }

  return time < times[oldest] ? oldest : newest
}

/**
 * Part de la nouvelle mesure dans le masque affiché.
 *
 * À l'arrêt : 35 %, le contour se stabilise. En mouvement : 82 %, il suit vite
 * sans laisser de traînée, tout en gardant assez de mémoire pour que la
 * silhouette ne se mette pas à clignoter au rythme des analyses.
 */
export function smoothingWeight(motion: number): number {
  const ramp = Math.min(1, Math.max(0, motion / MASK_MOTION_THRESHOLD))
  return MASK_SMOOTHING_STILL + (MASK_SMOOTHING_MOVING - MASK_SMOOTHING_STILL) * ramp
}

/**
 * Rectangle de cadrage « cover » : remplit la cible sans déformer la source.
 *
 * Une image importée peut être en 4:3, en 3:2 ou en portrait ; elle est centrée
 * et rognée plutôt qu'étirée. Les valeurs peuvent être négatives (débord
 * centré), ce que `drawImage` accepte.
 */
export function fitCoverRect(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): { x: number; y: number; width: number; height: number } {
  if (sourceWidth <= 0 || sourceHeight <= 0 || targetWidth <= 0 || targetHeight <= 0) {
    return { x: 0, y: 0, width: targetWidth, height: targetHeight }
  }

  const scale = Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight)
  const width = sourceWidth * scale
  const height = sourceHeight * scale

  return { x: (targetWidth - width) / 2, y: (targetHeight - height) / 2, width, height }
}

/**
 * Valeur du masque pour un pixel, telle que MediaPipe l'encode réellement.
 *
 * Le convertisseur GPU écrit `vec4(m, 0, 0, m)` : **rouge et alpha portent la
 * même valeur**, vert et bleu valent zéro. Lire la luminance des trois canaux
 * (`0,299 × m`) donnait une silhouette à 30 % d'opacité — le premier plan se
 * fondait dans le fond flou et toute l'image paraissait floutée.
 *
 * Le rouge est utilisé quand l'alpha a été aplati à 255 par une couche
 * intermédiaire ; les deux canaux restent alors équivalents.
 */
export function maskValueForPixel(red: number, alpha: number): number {
  return alpha >= 250 ? red : alpha
}

/**
 * Opacité d'un pixel de **liseré**, pour une valeur de masque (0–255).
 *
 * Cette rampe ne rend plus le corps translucide : tout pixel classé personne
 * est opaque (voir `applyPersonMask`). Elle adoucit uniquement le pixel de fond
 * collé à la silhouette, pour éviter une découpe crénelée une fois le masque
 * agrandi. À partir de 30 % de confiance, l'opacité est pleine ; sous 18 %, le
 * pixel appartient franchement au décor.
 */
export function maskOpacity(maskValue: number): number {
  const normalized = maskValue / 255
  const t = Math.min(
    1,
    Math.max(0, (normalized - MASK_EDGE_LOW) / (MASK_SOLID_LEVEL - MASK_EDGE_LOW)),
  )
  // Smoothstep : dérivée nulle aux deux bornes, pas de marche visible.
  return Math.round(t * t * (3 - 2 * t) * 255)
}

/**
 * Carte binaire « personne » d'un masque, à partir de sa valeur par pixel.
 *
 * Un pixel est retenu dès `MASK_SOLID_LEVEL` : c'est ce qui rend un vêtement
 * foncé ou une joue de profil **pleinement opaques**, au lieu de les laisser
 * translucides parce que le modèle n'en est qu'à moitié sûr.
 */
export function personMapFromMask(values: Uint8Array): Uint8Array {
  const map = new Uint8Array(values.length)
  for (let index = 0; index < values.length; index += 1) {
    map[index] = values[index] >= PERSON_LEVEL ? 1 : 0
  }
  return map
}

/** Tampon du filtre anti-pixels isolés, réutilisé d'un masque à l'autre. */
let speckleBuffer = new Uint8Array(0)

/**
 * Retire les pixels isolés de la carte personne, sur place.
 *
 * Un seuil bas rattrape les zones réelles peu sûres (joue dans l'ombre, tissu
 * sombre), au prix de quelques pixels de fond classés personne. Un pixel
 * personne qui n'a presque aucun voisin personne est du bruit : il est retiré.
 * Une forme pleine, même étroite, garde ses voisins et reste intacte.
 */
export function despecklePersonMap(person: Uint8Array, width: number, height: number): void {
  const total = width * height
  if (total === 0 || person.length < total) return
  if (speckleBuffer.length < total) speckleBuffer = new Uint8Array(total)
  speckleBuffer.set(person.subarray(0, total))

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      if (!speckleBuffer[index]) continue

      let neighbours = 0
      for (let dy = -1; dy <= 1 && neighbours <= 1; dy += 1) {
        const ny = y + dy
        if (ny < 0 || ny >= height) continue
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue
          const nx = x + dx
          if (nx < 0 || nx >= width) continue
          neighbours += speckleBuffer[ny * width + nx]
        }
      }

      if (neighbours <= 1) person[index] = 0
    }
  }
}

/** Tampons réutilisés par `fillEnclosedHoles` : un masque est analysé ~12 fois/s. */
let holeVisited = new Uint8Array(0)
let holeStack = new Int32Array(0)
let holeComponent = new Int32Array(0)

/** Dimensionne les tampons de comblement au masque courant. */
function ensureHoleBuffers(size: number): void {
  if (holeVisited.length >= size) return
  holeVisited = new Uint8Array(size)
  holeStack = new Int32Array(size)
  holeComponent = new Int32Array(size)
}

/**
 * Comble les trous **intérieurs** de la carte personne, sur place.
 *
 * Un vêtement foncé ou une joue à contre-jour donne une confiance faible au
 * modèle : sans traitement, ces zones passent pour du décor et le fond
 * apparaît au travers du corps. Un trou est une région de fond **sans aucune
 * liaison avec le bord du cadre** : le balayage part de tout le bord, et ce
 * qu'il n'atteint pas est un intérieur de silhouette.
 *
 * Un trou plus grand que `maxRatio` est laissé tel quel : c'est un vrai jour
 * (bras écarté du torse), qu'il ne faut pas murer.
 *
 * @returns Nombre de pixels comblés.
 */
export function fillEnclosedHoles(
  person: Uint8Array,
  width: number,
  height: number,
  maxRatio = MAX_HOLE_RATIO,
): number {
  const total = width * height
  if (total === 0 || person.length < total) return 0

  ensureHoleBuffers(total)
  const visited = holeVisited
  const stack = holeStack
  const component = holeComponent
  visited.fill(0, 0, total)

  let top = 0
  const enqueue = (index: number): void => {
    if (person[index] || visited[index]) return
    visited[index] = 1
    stack[top] = index
    top += 1
  }

  // Tout le fond relié au bord du cadre est du décor : il est marqué d'abord.
  for (let x = 0; x < width; x += 1) {
    enqueue(x)
    enqueue((height - 1) * width + x)
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(y * width)
    enqueue(y * width + width - 1)
  }

  while (top > 0) {
    top -= 1
    const index = stack[top]
    const x = index % width
    if (x > 0) enqueue(index - 1)
    if (x + 1 < width) enqueue(index + 1)
    if (index >= width) enqueue(index - width)
    if (index + width < total) enqueue(index + width)
  }

  const limit = Math.max(1, Math.floor(total * maxRatio))
  let filled = 0

  // Ce qui reste non visité n'a aucune liaison avec le bord : c'est un trou
  // dans la silhouette, pas du décor.
  for (let start = 0; start < total; start += 1) {
    if (person[start] || visited[start]) continue

    let count = 0
    top = 0
    enqueue(start)

    while (top > 0) {
      top -= 1
      const index = stack[top]
      component[count] = index
      count += 1
      const x = index % width
      if (x > 0) enqueue(index - 1)
      if (x + 1 < width) enqueue(index + 1)
      if (index >= width) enqueue(index - width)
      if (index + width < total) enqueue(index + width)
    }

    if (count > limit) continue
    for (let offset = 0; offset < count; offset += 1) person[component[offset]] = 1
    filled += count
  }

  return filled
}

/**
 * Mesures d'un masque, sans aucune donnée d'image conservée.
 *
 * `redMean` et `alphaMean` sont les moyennes **brutes** des deux canaux que
 * MediaPipe utilise : elles permettent d'identifier sans ambiguïté le format
 * renvoyé par la version installée.
 */
export interface MaskStats {
  /** Fraction de l'image occupée par la silhouette (0–1). */
  coverage: number
  /** Moyenne du canal rouge du masque brut (0–255). */
  redMean: number
  /** Moyenne du canal alpha du masque brut (0–255). */
  alphaMean: number
  /** Pixels de trou intérieur comblés lors de cette analyse. */
  holesFilled: number
}

/** Vrai si un des quatre voisins de `index` appartient au décor. */
function touchesBackground(
  person: Uint8Array,
  width: number,
  height: number,
  index: number,
): boolean {
  const x = index % width
  if (x > 0 && !person[index - 1]) return true
  if (x + 1 < width && !person[index + 1]) return true
  if (index >= width && !person[index - width]) return true
  if (index + width < width * height && !person[index + width]) return true
  return false
}

/**
 * Transforme un masque RGBA (`[m, 0, 0, m]`) en masque d'opacité utilisable par
 * `destination-in` : RGB blanc, alpha = opacité du premier plan.
 *
 * Le masque n'est plus une simple rampe de confiance : tout pixel classé
 * personne devient **totalement opaque**, les trous intérieurs sont comblés, et
 * seul le pixel de silhouette collé au décor reste progressif. Une joue de
 * profil ou un pull foncé ne peut donc plus laisser voir le décor au travers, et
 * aucun pixel de la pièce réelle n'est peint autour de la tête.
 */
export function applyPersonMask(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  state?: MaskTemporalState,
): MaskStats {
  const total = width * height
  if (total === 0 || data.length < total * 4) {
    return { coverage: 0, redMean: 0, alphaMean: 0, holesFilled: 0 }
  }

  const values = new Uint8Array(total)
  let redTotal = 0
  let alphaTotal = 0

  for (let index = 0; index < total; index += 1) {
    const offset = index * 4
    const red = data[offset]
    const alpha = data[offset + 3]
    redTotal += red
    alphaTotal += alpha
    values[index] = maskValueForPixel(red, alpha)
  }

  // Confiance lissée **avant** la décision : c'est elle qui porte l'hésitation
  // du modèle. L'opacité publiée reste binaire, donc plus de tête à demi
  // transparente.
  let decided = values
  if (state) {
    if (!state.values || state.values.length !== total) {
      state.values = new Float32Array(total)
      for (let index = 0; index < total; index += 1) state.values[index] = values[index]
    } else {
      smoothMaskValues(state.values, values, smoothingWeight(maskValueMotion(state.raw, values)))
    }
    state.raw = values
    decided = new Uint8Array(total)
    for (let index = 0; index < total; index += 1) decided[index] = Math.round(state.values[index])
  }

  const person = personMapFromMask(decided)
  despecklePersonMap(person, width, height)
  const holesFilled = fillEnclosedHoles(person, width, height)

  let personPixels = 0
  for (let index = 0; index < total; index += 1) {
    const offset = index * 4
    let opacity = 0

    if (person[index]) {
      // Anticrénelage **dans** la silhouette : un pixel de bord s'estompe selon
      // sa confiance. Le décor, lui, reste totalement transparent — c'est ce qui
      // supprime le halo de pièce réelle autour du visage.
      opacity = touchesBackground(person, width, height, index)
        ? maskOpacity(values[index])
        : 255
      personPixels += 1
    }

    data[offset] = 255
    data[offset + 1] = 255
    data[offset + 2] = 255
    data[offset + 3] = opacity
  }

  return {
    coverage: personPixels / total,
    redMean: Math.round(redTotal / total),
    alphaMean: Math.round(alphaTotal / total),
    holesFilled,
  }
}

/**
 * Signature publique du moteur, réduite à ce que nous utilisons.
 * Les types du paquet ne sont pas importés : le module est chargé à l'exécution
 * par une balise `<script>`, pas par le bundle.
 */
interface SegmentationResults {
  segmentationMask?: CanvasImageSource
}

interface SegmentationEngine {
  onResults(listener: (results: SegmentationResults) => void): void
  setOptions(options: { modelSelection?: number }): void
  initialize(): Promise<void>
  send(inputs: { image: HTMLCanvasElement }): Promise<void>
  close(): Promise<void>
}

type SegmentationEngineConstructor = new (config: {
  locateFile: (file: string) => string
}) => SegmentationEngine

declare global {
  interface Window {
    SelfieSegmentation?: SegmentationEngineConstructor
  }
}

/** Erreur d'application d'un effet, déjà formulée pour l'utilisateur. */
export class VideoEffectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VideoEffectError'
  }
}

/**
 * Compteurs de fonctionnement, sans aucune donnée d'image.
 * Ils servent à prouver que le traitement reçoit réellement des images et à
 * afficher un état vérifiable dans le panneau « Effets de fond ».
 */
export interface VideoEffectStats {
  /** Images remises au traitement par la piste brute. */
  imagesReceived: number
  /** Fraction de l'image occupée par la silhouette détectée (0–1). */
  personCoverage: number
  /** Moyenne du canal rouge du masque brut : identifie le format du masque. */
  maskRedMean: number
  /** Moyenne du canal alpha du masque brut : identifie le format du masque. */
  maskAlphaMean: number
  /** Images effectivement recomposées (fond flouté). */
  imagesBlurred: number
  /** Masques de détourage reçus du moteur. */
  masks: number
  /** Images reçues par seconde, sur la dernière fenêtre mesurée. */
  imagesPerSecond: number
  /** Masques reçus par seconde, sur la dernière fenêtre mesurée. */
  masksPerSecond: number
  /** Temps écoulé depuis la dernière image reçue, en millisecondes. */
  lastImageAgoMs: number | null
  /** Largeur du flux publié, en pixels. */
  frameWidth: number
  /** Hauteur du flux publié, en pixels. */
  frameHeight: number
}

export interface BackgroundBlurRenderer {
  /** Prend le contrôle du canvas fourni par le SDK et démarre la composition. */
  attach: (canvas: HTMLCanvasElement, track: MediaStreamTrack | null) => Promise<void>
  /** Arrête la composition et libère l'élément vidéo (la piste reste au SDK). */
  detach: () => void
  stats: () => VideoEffectStats
  /** Appelé si la composition échoue durablement. */
  onFailure?: (message: string) => void
  dispose: () => void
}

let enginePromise: Promise<SegmentationEngineConstructor> | null = null

/** Charge le moteur depuis notre propre origine. */
function loadEngine(): Promise<SegmentationEngineConstructor> {
  const published = window.SelfieSegmentation
  if (published) return Promise.resolve(published)
  if (enginePromise) return enginePromise

  enginePromise = new Promise<SegmentationEngineConstructor>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = BLUR_ENGINE_SCRIPT_URL
    script.async = true

    script.addEventListener('load', () => {
      const constructor = window.SelfieSegmentation
      if (constructor) {
        resolve(constructor)
        return
      }
      enginePromise = null
      reject(
        new VideoEffectError(
          "Le moteur de détourage s'est chargé sans exposer son interface. Votre caméra reste diffusée sans effet.",
        ),
      )
    })

    script.addEventListener('error', () => {
      enginePromise = null
      script.remove()
      reject(
        new VideoEffectError(
          "Le moteur de détourage n'a pas pu être chargé depuis l'application. Votre caméra reste diffusée sans effet.",
        ),
      )
    })

    document.head.append(script)
  })

  return enginePromise
}

/**
 * Prépare le détourage puis renvoie le renderer.
 *
 * Le moteur est **vérifié avant de rendre la main** : un masque de test est
 * calculé sur une image locale. Si le WebAssembly, le graphe ou le modèle ne
 * répondent pas, l'appel échoue ici — donc visiblement.
 */
/**
 * Décode l'image de fond **avant** d'ajouter le middleware.
 *
 * Un fichier corrompu, un format que le navigateur ne décode pas ou un objet
 * révoqué échouent ici, avec un message explicite — plutôt qu'en silence dans
 * la boucle de composition, où l'image disparaîtrait sans explication.
 */
async function loadBackdropImage(url: string): Promise<HTMLImageElement> {
  const element = new Image()
  element.decoding = 'async'
  element.src = url

  try {
    await element.decode()
  } catch {
    throw new VideoEffectError(
      "L'image de fond n'a pas pu être lue par le navigateur. Choisissez une autre image : votre caméra reste diffusée sans effet.",
    )
  }

  return element
}

export async function createBackgroundBlurRenderer(
  effect: VideoEffectChoice,
): Promise<BackgroundBlurRenderer> {
  const Engine = await loadEngine()

  const backdropImage =
    effect.backdrop?.kind === 'image' ? await loadBackdropImage(effect.backdrop.url) : null

  const work = document.createElement('canvas')
  const workCtx = work.getContext('2d')
  const person = document.createElement('canvas')
  const personCtx = person.getContext('2d')
  const backdrop = document.createElement('canvas')
  const backdropCtx = backdrop.getContext('2d')
  const mask = document.createElement('canvas')
  const maskCtx = mask.getContext('2d', { willReadFrequently: true })
  // Toile du décor : peinte une fois par activation, puis recopiée telle quelle.
  const scene = document.createElement('canvas')
  const sceneCtx = scene.getContext('2d')

  if (!workCtx || !personCtx || !backdropCtx || !maskCtx || !sceneCtx) {
    throw new VideoEffectError("Le flou d'arrière-plan n'est pas disponible sur ce navigateur.")
  }

  // Diagnostic du masque : **développement uniquement**. L'import dynamique est
  // gardé par une constante remplacée par `false` à la compilation : le module
  // et son code ne font pas partie du bundle publié.
  let diagnostics: MaskDiagnostics | null = null
  if (import.meta.env.DEV) {
    try {
      const { createMaskDiagnostics } = await import('./maskDiagnostics')
      diagnostics = createMaskDiagnostics()
    } catch {
      diagnostics = null
    }
  }

  const segmenter = new Engine({ locateFile: (file) => `${ENGINE_PATH}/${file}` })
  // `modelSelection: 0` = modèle général (256×256), plus précis sur les
  // visages que le modèle « paysage » (144×256) : celui-ci laissait une joue
  // dans l'ombre hors du masque, et le décor remplaçait la moitié du visage.
  segmenter.setOptions({ modelSelection: 0 })

  let disposed = false
  let maskReady = false
  let segmenting = false
  let lastSegmentAt = 0
  const maskState = createMaskTemporalState()
  let heldMasks = 0

  // Historique court des images composables (voir `compose`).
  const historyFrames: { canvas: HTMLCanvasElement; at: number }[] = []
  const historyTimes: number[] = []
  let historyNext = 0
  let sentAt = 0
  let maskedAt = 0
  let maskedReadyAt = 0

  let canvas: HTMLCanvasElement | null = null
  let ctx: CanvasRenderingContext2D | null = null
  let source: HTMLVideoElement | null = null
  let timer: number | null = null

  let imagesReceived = 0
  let imagesBlurred = 0
  let masks = 0
  let lastImageAt = 0
  let imagesPerSecond = 0
  let masksPerSecond = 0
  let windowStartedAt = performance.now()
  let imagesInWindow = 0
  let masksInWindow = 0
  let failures = 0
  let personCoverage = 0
  let maskRedMean = 0
  let maskAlphaMean = 0
  let frameWidth = 0
  let frameHeight = 0

  /** Résolution de la vérification initiale du moteur. */
  let resolveWarmup: ((ok: boolean) => void) | null = null

  const sampleRates = () => {
    const now = performance.now()
    const elapsed = now - windowStartedAt
    if (elapsed < 1000) return
    imagesPerSecond = Math.round((imagesInWindow * 1000) / elapsed)
    masksPerSecond = Math.round((masksInWindow * 1000) / elapsed)
    imagesInWindow = 0
    masksInWindow = 0
    windowStartedAt = now
  }

  segmenter.onResults((results) => {
    if (disposed) return

    const segmentationMask = results.segmentationMask
    if (!segmentationMask) {
      // Le graphe a répondu sans masque : le test initial doit échouer.
      resolveWarmup?.(false)
      resolveWarmup = null
      return
    }

    // Pendant la vérification initiale, le masque de l'image de test est ignoré.
    if (resolveWarmup) {
      resolveWarmup(true)
      resolveWarmup = null
      return
    }

    maskCtx.clearRect(0, 0, mask.width, mask.height)
    maskCtx.drawImage(segmentationMask, 0, 0, mask.width, mask.height)

    const frame = maskCtx.getImageData(0, 0, mask.width, mask.height)
    const maskStats = applyPersonMask(frame.data, mask.width, mask.height, maskState)
    maskRedMean = maskStats.redMean
    maskAlphaMean = maskStats.alphaMean

    // Détection momentanément perdue (mouvement rapide, modèle incertain) : le
    // dernier masque fiable est conservé. Composer avec un masque vide laisserait
    // réapparaître la pièce réelle une fraction de seconde — c'est exactement le
    // défaut observé. Après quelques analyses vides, la personne est considérée
    // comme sortie du champ et seul le fond est publié.
    if (maskStats.coverage < MIN_PERSON_COVERAGE && maskReady && heldMasks < MAX_HELD_MASKS) {
      heldMasks += 1
      masks += 1
      masksInWindow += 1
      sampleRates()
      return
    }

    heldMasks = 0
    personCoverage = maskStats.coverage

    maskCtx.putImageData(frame, 0, 0)
    diagnostics?.update(mask, maskStats)
    maskedAt = sentAt
    maskedReadyAt = performance.now()
    maskReady = true
    masks += 1
    masksInWindow += 1
    sampleRates()
  })

  /**
   * Peint le fond sous la silhouette.
   *
   * - **flou** : réduction puis agrandissement lissé. Le flou est appliqué au
   *   moment de l'agrandissement, ce qui efface les blocs que laissait un
   *   simple redimensionnement sur un mur uni ;
   * - **décor** : toile peinte une fois à la taille du flux, puis recopiée ;
   *   aucun coût de dessin par image ;
   * - **image importée** : cadrage « cover », jamais étirée.
   */
  const paintBackground = () => {
    const target = canvas
    const context = ctx
    if (!target || !context) return

    if (effect.id === 'backdrop') {
      context.save()
      context.drawImage(scene, 0, 0, target.width, target.height)
      context.restore()
      return
    }

    backdropCtx.imageSmoothingEnabled = true
    backdropCtx.imageSmoothingQuality = 'high'
    backdropCtx.drawImage(target, 0, 0, backdrop.width, backdrop.height)

    context.save()
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.filter = `blur(${BACKDROP_BLUR_PX}px)`
    context.drawImage(backdrop, 0, 0, target.width, target.height)
    context.restore()
  }

  /** Compose une image : fond (flou ou décor) + silhouette nette. */
  const compose = () => {
    const target = canvas
    const context = ctx
    // Sans premier masque, la caméra brute reste affichée le temps du
    // détourage. Ensuite, on compose **toujours** : la pièce réelle ne doit
    // jamais réapparaître entre deux analyses.
    if (!target || !context || !maskReady) return

    // 1. Copie nette du premier plan, **avant** de repeindre le fond.
    //    L'image vient de l'historique : le masque a été calculé sur une image
    //    plus ancienne, et composer avec l'image courante décalait la
    //    silhouette de toute la latence du détecteur.
    // Image exacte qu'a vue le détecteur : l'alignement passe avant le retard.
    // Avancer le masque pour gagner quelques millisecondes rendait la silhouette
    // franchement décalée sur une machine où le détecteur est plus lent.
    const frameIndex = frameIndexAt(historyTimes, maskedAt + (performance.now() - maskedReadyAt))
    const foreground = historyFrames[frameIndex]?.canvas ?? target
    personCtx.globalCompositeOperation = 'source-over'
    personCtx.clearRect(0, 0, person.width, person.height)
    personCtx.drawImage(foreground, 0, 0, person.width, person.height)

    // 2. Fond : flou calculé ou décor peint.
    paintBackground()

    // 3. Silhouette nette, découpée par le masque (même rapport d'image).
    personCtx.globalCompositeOperation = 'destination-in'
    personCtx.imageSmoothingEnabled = true
    personCtx.filter = `blur(${FEATHER_PX}px)`
    personCtx.drawImage(mask, 0, 0, person.width, person.height)
    personCtx.filter = 'none'
    personCtx.globalCompositeOperation = 'source-over'

    context.drawImage(person, 0, 0, target.width, target.height)
    imagesBlurred += 1
    failures = 0
  }

  const tick = () => {
    const target = canvas
    const context = ctx
    const element = source
    if (disposed || !target || !context || !element) return
    if (element.readyState < 2 || element.videoWidth === 0) return

    try {
      // Image nette de référence : la caméra, à la taille exacte du canvas.
      context.globalCompositeOperation = 'source-over'
      context.drawImage(element, 0, 0, target.width, target.height)

      // Copie horodatée : elle servira à composer le masque sur l'image qui a
      // réellement servi à le calculer.
      const slot = historyFrames[historyNext]
      if (slot) {
        slot.canvas.getContext('2d')?.drawImage(target, 0, 0)
        slot.at = performance.now()
        historyTimes[historyNext] = slot.at
        historyNext = (historyNext + 1) % historyFrames.length
      }

      imagesReceived += 1
      imagesInWindow += 1
      lastImageAt = performance.now()
      sampleRates()

      const now = performance.now()
      if (!segmenting && now - lastSegmentAt >= SEGMENT_INTERVAL_MS) {
        segmenting = true
        lastSegmentAt = now

        workCtx.imageSmoothingEnabled = true
        workCtx.filter = SEGMENT_LIFT
        workCtx.drawImage(target, 0, 0, work.width, work.height)
        workCtx.filter = 'none'
        sentAt = performance.now()

        void segmenter
          .send({ image: work })
          .catch(() => {
            // Un échec ponctuel est ignoré : l'image suivante retente et le
            // dernier masque reste valable.
          })
          .finally(() => {
            segmenting = false
          })
      }

      compose()
    } catch {
      failures += 1
      // Le SDK n'intercepte plus rien ici : c'est à nous de prévenir.
      if (failures >= 3) {
        renderer.dispose()
        renderer.onFailure?.(
          "Le flou d'arrière-plan s'est arrêté : votre caméra est de nouveau diffusée sans effet.",
        )
      }
    }
  }

  const detach = () => {
    if (timer !== null) {
      window.clearInterval(timer)
      timer = null
    }

    // Libère tout de suite la mémoire de l'historique : une toile ramenée à
    // 0×0 rend ses pixels au navigateur, alors qu'une référence conservée les
    // garde jusqu'au prochain attachement.
    for (const frame of historyFrames) {
      frame.canvas.width = 0
      frame.canvas.height = 0
    }
    historyFrames.length = 0
    historyTimes.length = 0
    historyNext = 0

    const element = source
    source = null
    canvas = null
    ctx = null

    if (element) {
      element.pause()
      element.srcObject = null
    }
  }

  /** Peint la toile du décor à la taille courante du flux. */
  const paintScene = () => {
    if (effect.id !== 'backdrop') return

    sceneCtx.clearRect(0, 0, scene.width, scene.height)
    sceneCtx.imageSmoothingEnabled = true
    sceneCtx.imageSmoothingQuality = 'high'

    if (effect.backdrop?.kind === 'image' && backdropImage) {
      const rect = fitCoverRect(
        backdropImage.naturalWidth,
        backdropImage.naturalHeight,
        scene.width,
        scene.height,
      )
      // Seul le décor est inversé horizontalement : il apparaît comme la pièce
      // vue dans un miroir. La personne, elle, n'est jamais inversée — ni dans
      // l'aperçu, ni dans le flux publié.
      sceneCtx.save()
      sceneCtx.translate(scene.width, 0)
      sceneCtx.scale(-1, 1)
      sceneCtx.drawImage(backdropImage, rect.x, rect.y, rect.width, rect.height)
      sceneCtx.restore()
      return
    }

    paintBackdrop(
      sceneCtx,
      scene.width,
      scene.height,
      effect.backdrop?.kind === 'preset' ? effect.backdrop.preset : 'ardoise',
    )
  }

  const renderer: BackgroundBlurRenderer = {
    attach: async (targetCanvas, track) => {
      detach()
      if (disposed) {
        throw new VideoEffectError("Le flou d'arrière-plan a été interrompu pendant son démarrage.")
      }
      if (!track || track.readyState === 'ended') {
        throw new VideoEffectError("Aucune piste vidéo active : le flou ne peut pas démarrer.")
      }

      // Géométrie déduite de la **piste réelle** : c'est le correctif du flux
      // carré/rogné produit par le pipeline interne du SDK.
      const settings = track.getSettings()
      const size = normalizedFrameSize(settings.width ?? 0, settings.height ?? 0)
      targetCanvas.width = size.width
      targetCanvas.height = size.height

      const context = targetCanvas.getContext('2d')
      if (!context) {
        throw new VideoEffectError("Le navigateur refuse le canvas vidéo nécessaire au flou.")
      }

      frameWidth = size.width
      frameHeight = size.height

      const workSize = normalizedWorkSize(size.width, size.height)
      work.width = workSize.width
      work.height = workSize.height
      person.width = Math.min(size.width, PERSON_MAX_WIDTH)
      person.height = Math.max(2, Math.round((person.width * size.height) / size.width))
      backdrop.width = Math.max(16, Math.round(workSize.width / BLUR_DIVISOR))
      backdrop.height = Math.max(16, Math.round(workSize.height / BLUR_DIVISOR))

      // Le masque suit le rapport d'image de la vidéo (et non un 16:9 figé).
      const maskSize = maskSizeFor(size.width, size.height)
      mask.width = maskSize.width
      mask.height = maskSize.height

      historyFrames.length = 0
      historyTimes.length = 0
      historyNext = 0
      const historySize = frameHistorySize(size.width, size.height)
      for (let index = 0; index < historySize; index += 1) {
        const frameCanvas = document.createElement('canvas')
        frameCanvas.width = size.width
        frameCanvas.height = size.height
        historyFrames.push({ canvas: frameCanvas, at: Number.NEGATIVE_INFINITY })
        historyTimes.push(Number.NEGATIVE_INFINITY)
      }

      maskReady = false
      maskState.values = null
      maskState.raw = null
      heldMasks = 0
      personCoverage = 0

      // Décor : toile à la taille du flux, peinte une seule fois.
      scene.width = size.width
      scene.height = size.height
      paintScene()

      const element = document.createElement('video')
      element.muted = true
      element.playsInline = true
      element.autoplay = true
      element.srcObject = new MediaStream([track])

      canvas = targetCanvas
      ctx = context
      source = element

      try {
        await element.play()
      } catch {
        // Autoplay refusé : `imagesReceived` restera à 0 et l'appelant
        // signalera explicitement l'échec plutôt que de publier du vide.
      }

      timer = window.setInterval(tick, FRAME_INTERVAL_MS)
      tick()
    },
    detach,
    stats: () => ({
      imagesReceived,
      personCoverage,
      maskRedMean,
      maskAlphaMean,
      imagesBlurred,
      masks,
      imagesPerSecond,
      masksPerSecond,
      lastImageAgoMs: lastImageAt === 0 ? null : Math.round(performance.now() - lastImageAt),
      frameWidth,
      frameHeight,
    }),
    dispose: () => {
      if (disposed) return
      disposed = true
      diagnostics?.dispose()
      diagnostics = null
      detach()
      resolveWarmup?.(false)
      resolveWarmup = null
      void segmenter.close().catch(() => {
        // Le moteur peut déjà être arrêté : rien à signaler à l'utilisateur.
      })
    },
  }

  // --- Vérification initiale du moteur ------------------------------------
  await segmenter.initialize()

  // Image de test locale : un aplat suffit à prouver que le graphe, le
  // WebAssembly et le modèle répondent. Aucune image de caméra n'est envoyée.
  const probe = document.createElement('canvas')
  probe.width = 320
  probe.height = 180
  const probeCtx = probe.getContext('2d')
  if (probeCtx) {
    probeCtx.fillStyle = '#2b3440'
    probeCtx.fillRect(0, 0, probe.width, probe.height)
  }

  const warm = await new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      window.clearTimeout(warmupTimer)
      resolveWarmup = null
      resolve(ok)
    }

    const warmupTimer = window.setTimeout(() => finish(false), ENGINE_WARMUP_TIMEOUT_MS)
    resolveWarmup = () => finish(true)

    void segmenter.send({ image: probe }).catch(() => finish(false))
  })

  if (disposed) {
    throw new VideoEffectError("Le flou d'arrière-plan a été interrompu pendant son initialisation.")
  }

  if (!warm) {
    renderer.dispose()
    throw new VideoEffectError(
      "Le moteur de détourage n'a pas répondu : le flou reste désactivé et votre caméra est diffusée telle quelle.",
    )
  }

  return renderer
}

/** Rendu actuellement rattaché au middleware (aucun si l'effet est inactif). */
let activeRenderer: BackgroundBlurRenderer | null = null

/** Accès à la piste brute publiée par le SDK, pour alimenter notre canvas. */
let activeTrack: (() => MediaStreamTrack | null) | null = null

/**
 * Middleware **stable** : le SDK identifie un middleware par sa référence, donc
 * la même fonction doit être utilisée pour l'ajouter et le retirer.
 *
 * Le SDK nous confie son canvas (`disablePerFrameCanvasRendering`) : nous le
 * dimensionnons et nous y composons chaque image nous-mêmes.
 */
const blurMiddleware: VideoMiddleware = (helpers) => {
  const renderer = activeRenderer
  if (!renderer) {
    return Promise.reject(new Error('background-blur: no renderer prepared'))
  }

  return renderer.attach(helpers.canvas, activeTrack?.() ?? null)
}

/** Diagnostic courant, lu par le panneau « Effets de fond ». */
export function readVideoEffectStats(): VideoEffectStats | null {
  return activeRenderer ? activeRenderer.stats() : null
}

/** Média minimal nécessaire pour piloter l'effet et vérifier son application. */
type EffectMedia = Pick<
  RTKSelfMedia,
  | 'addVideoMiddleware'
  | 'removeVideoMiddleware'
  | 'setVideoMiddlewareGlobalConfig'
  | 'videoTrack'
  | 'rawVideoTrack'
  | 'videoEnabled'
>

function safeRead<T>(read: () => T): T | null {
  try {
    return read()
  } catch {
    // Les accesseurs du SDK lèvent tant que le média n'est pas initialisé.
    return null
  }
}

/** Attend qu'au moins une image atteigne le traitement. */
async function waitForFirstFrame(renderer: BackgroundBlurRenderer): Promise<boolean> {
  const deadline = performance.now() + FRAME_ARRIVAL_TIMEOUT_MS
  while (performance.now() < deadline) {
    if (renderer.stats().imagesReceived > 0) return true
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
  }
  return renderer.stats().imagesReceived > 0
}

/** Fabrique de rendu, injectable pour les tests de non-régression. */
export type BlurRendererFactory = (effect: VideoEffectChoice) => Promise<BackgroundBlurRenderer>

/** Applique (ou retire) l'effet vidéo sur le support média du SDK. */
export async function applyVideoEffect(
  media: EffectMedia,
  effect: VideoEffectChoice,
  onRuntimeFailure?: (message: string) => void,
): Promise<void> {
  return applyVideoEffectWith(media, effect, createBackgroundBlurRenderer, onRuntimeFailure)
}

/**
 * Cœur de l'application de l'effet, avec une fabrique de rendu injectable.
 *
 * La fabrique permet de vérifier le comportement exact qui échouait : un SDK
 * qui répond « succès » tout en republiant la piste brute.
 */
export async function applyVideoEffectWith(
  media: EffectMedia,
  effect: VideoEffectChoice,
  createRenderer: BlurRendererFactory,
  onRuntimeFailure?: (message: string) => void,
): Promise<void> {
  if (effect.id === 'none') {
    await media.removeVideoMiddleware(blurMiddleware)
    activeRenderer?.dispose()
    activeRenderer = null
    activeTrack = null
    return
  }

  // Effet déjà en place : rien à refaire (le SDK refuserait le doublon).
  if (activeRenderer) return

  const renderer = await createRenderer(effect)

  renderer.onFailure = (message) => {
    if (activeRenderer === renderer) activeRenderer = null
    void media.removeVideoMiddleware(blurMiddleware).catch(() => {
      // Le retrait peut échouer si le SDK a déjà remplacé sa piste : l'effet
      // est de toute façon arrêté côté rendu.
    })
    onRuntimeFailure?.(message)
  }

  activeRenderer = renderer
  activeTrack = () => safeRead(() => media.rawVideoTrack) ?? null

  const stopAndFail = async (message: string): Promise<never> => {
    if (activeRenderer === renderer) activeRenderer = null
    activeTrack = null
    renderer.dispose()
    await media.removeVideoMiddleware(blurMiddleware).catch(() => {
      // Idem : le retrait est un nettoyage, pas une condition de succès.
    })
    throw new VideoEffectError(message)
  }

  // Le rendu par image du SDK utilise une géométrie fausse (largeur de
  // l'élément `<video>`, pas de la piste). Nous prenons le canvas.
  const ownsCanvas = await media
    .setVideoMiddlewareGlobalConfig({ disablePerFrameCanvasRendering: true })
    .then(() => true)
    .catch(() => false)

  if (!ownsCanvas) {
    await stopAndFail(
      "La configuration vidéo du SDK n'a pas pu être ajustée : le flou reste désactivé et votre caméra est diffusée sans effet.",
    )
  }

  const videoEnabled = safeRead(() => media.videoEnabled) ?? false
  if (!videoEnabled) {
    // Caméra coupée : le middleware démarrera à la première activation.
    return
  }

  const result = await media.addVideoMiddleware(blurMiddleware)

  if (!result.success) {
    // Une double application n'est pas une panne : le SDK renvoie un message
    // explicite et l'effet est déjà en place.
    if (/already/i.test(result.message ?? '')) return

    await stopAndFail(
      "Le flou d'arrière-plan n'a pas pu être activé sur ce navigateur. Votre caméra reste diffusée sans effet.",
    )
  }

  // Le SDK applique un middleware en silence : si la fabrication échoue, il
  // republie la piste brute tout en répondant `success: true`. On vérifie donc
  // que la piste publiée n'est plus la piste d'origine.
  const published = safeRead(() => media.videoTrack)
  const raw = safeRead(() => media.rawVideoTrack)

  if (published && raw && published.id === raw.id) {
    await stopAndFail(
      "Le SDK n'a pas appliqué le traitement vidéo : votre caméra reste diffusée sans effet. Essayez de couper puis de rallumer la caméra.",
    )
  }

  // Dernier contrôle : les images arrivent-elles réellement au traitement ?
  const framesArrived = await waitForFirstFrame(renderer)
  if (!framesArrived) {
    await stopAndFail(
      "Le traitement n'a reçu aucune image de votre caméra. Votre caméra reste diffusée sans effet : coupez puis rallumez la vidéo, puis réessayez.",
    )
  }
}
