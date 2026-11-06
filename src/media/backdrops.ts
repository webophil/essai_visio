import type { BackdropPresetId } from '../types/meeting'

/**
 * Décors de remplacement, peints à la volée sur un canvas.
 *
 * Aucun fichier image n'est livré avec l'application : les décors sont des
 * dégradés composés localement. Deux raisons :
 *
 * 1. **poids** — l'artefact publié frôle déjà la limite de 10 Mio avec le
 *    moteur de segmentation ; une photo de bureau en ajouterait plusieurs ;
 * 2. **licence** — une image « salle de réunion » trouvée sur le web n'est pas
 *    librement redistribuable. Un fond personnel peut être importé depuis le
 *    disque de l'utilisateur (voir le panneau), sans jamais quitter son
 *    navigateur.
 *
 * Les teintes sont volontairement sourdes et sans détail net : un décor
 * synthétique chargé (faux livres, faux mur) vieillit mal et attire l'œil
 * davantage qu'un fond uni éclairé.
 */
export interface BackdropPreset {
  readonly id: BackdropPresetId
  readonly label: string
  readonly description: string
  /**
   * Aperçu CSS du panneau. Il reprend les couleurs du décor peint : l'aperçu
   * annonce donc le rendu réel, il ne l'embellit pas.
   */
  readonly swatch: string
}

export const BACKDROP_PRESETS: readonly BackdropPreset[] = [
  {
    id: 'studio',
    label: 'Studio',
    description: 'Mur chaud, lumière douce en haut à gauche.',
    swatch: 'radial-gradient(circle at 30% 25%, #4a3b2c 0%, #2a211a 45%, #0d0b09 100%)',
  },
  {
    id: 'ardoise',
    label: 'Ardoise',
    description: 'Bleu-gris profond, halo derrière la silhouette.',
    swatch: 'radial-gradient(circle at 50% 35%, #2b4a68 0%, #16283c 45%, #070c17 100%)',
  },
]

/** Retrouve un décor par son identifiant, sans jamais lever. */
export function backdropPreset(id: BackdropPresetId): BackdropPreset {
  return BACKDROP_PRESETS.find((preset) => preset.id === id) ?? BACKDROP_PRESETS[0]
}

/**
 * Peint un décor sur un canvas déjà dimensionné.
 *
 * `context` est supposé vierge : la fonction remplit toute la surface. Le rayon
 * du halo est exprimé en fraction de la plus petite dimension, donc identique
 * en 16:9, en 4:3 et en vidéo carrée.
 */
export function paintBackdrop(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  id: BackdropPresetId,
): void {
  if (width <= 0 || height <= 0) return

  const glow = Math.max(width, height) * 0.75

  /** Aplat de fond, du plus clair (haut) au plus sombre (bas). */
  const paintBase = (top: string, bottom: string) => {
    const gradient = context.createLinearGradient(0, 0, 0, height)
    gradient.addColorStop(0, top)
    gradient.addColorStop(1, bottom)
    context.fillStyle = gradient
    context.fillRect(0, 0, width, height)
  }

  /** Halo doux, censé évoquer une source lumineuse hors champ. */
  const paintGlow = (x: number, y: number, color: string, strength: number) => {
    const gradient = context.createRadialGradient(x, y, 0, x, y, glow)
    gradient.addColorStop(0, color)
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)')
    context.save()
    context.globalAlpha = strength
    context.fillStyle = gradient
    context.fillRect(0, 0, width, height)
    context.restore()
  }

  switch (id) {
    case 'studio':
      paintBase('#3a2f25', '#0b0907')
      paintGlow(width * 0.28, height * 0.22, 'rgba(255, 206, 148, 0.55)', 0.75)
      paintGlow(width * 0.82, height * 0.78, 'rgba(90, 62, 40, 0.5)', 0.5)
      break
    case 'ardoise':
      paintBase('#1b2c3f', '#060a12')
      paintGlow(width * 0.5, height * 0.34, 'rgba(120, 176, 220, 0.5)', 0.6)
      break
  }

  // Vignettage : sans lui, un aplat plein cadre paraît « faux » derrière une
  // silhouette nette, et le contour du cadre attire l'œil.
  const vignette = context.createRadialGradient(
    width / 2,
    height / 2,
    Math.min(width, height) * 0.35,
    width / 2,
    height / 2,
    Math.max(width, height) * 0.75,
  )
  vignette.addColorStop(0, 'rgba(0, 0, 0, 0)')
  vignette.addColorStop(1, 'rgba(0, 0, 0, 0.45)')
  context.fillStyle = vignette
  context.fillRect(0, 0, width, height)
}
