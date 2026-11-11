import type { MaskStats } from './backgroundBlur'

/**
 * Panneau de diagnostic du masque — **développement uniquement**.
 *
 * Il sert à juger le détourage à l'œil : trous d'un vêtement foncé, lisière,
 * joue de profil. Aucune donnée technique n'atteint l'interface des
 * participants : `backgroundBlur.ts` ne charge ce module que derrière
 * `import.meta.env.DEV`, constante remplacée par `false` dans le build publié,
 * et le panneau n'apparaît que si l'URL contient `?mask`.
 */

/** Contrôles réservés au développeur. */
export interface MaskDiagnostics {
  /** Affiche le masque courant et ses mesures. */
  update: (mask: HTMLCanvasElement, stats: MaskStats) => void
  /** Retire le panneau du document. */
  dispose: () => void
}

/** Intervalle minimal entre deux rafraîchissements du panneau. */
const REFRESH_MS = 150

/**
 * Crée le panneau si l'URL contient `?mask`, sinon ne fait rien.
 *
 * @returns Le panneau, ou `null` quand le diagnostic n'est pas demandé.
 */
export function createMaskDiagnostics(): MaskDiagnostics | null {
  if (typeof document === 'undefined') return null
  if (!new URLSearchParams(window.location.search).has('mask')) return null

  const root = document.createElement('div')
  root.setAttribute('data-mask-diagnostics', '')
  root.style.cssText = [
    'position:fixed',
    'right:16px',
    'bottom:96px',
    'z-index:2147483647',
    'padding:8px',
    'border-radius:8px',
    'background:#0b1220',
    'color:#dbeafe',
    'font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace',
    'box-shadow:0 8px 24px rgba(0,0,0,.45)',
    'pointer-events:none',
  ].join(';')

  const title = document.createElement('div')
  title.textContent = 'Masque — développement'
  title.style.cssText = 'margin-bottom:6px;font-weight:600'

  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 144
  canvas.style.cssText = 'display:block;width:256px;height:auto;border-radius:4px;background:#000'

  const label = document.createElement('div')
  label.style.cssText = 'margin-top:6px;white-space:nowrap'

  root.append(title, canvas, label)
  document.body.append(root)

  const context = canvas.getContext('2d')
  let lastPaint = 0

  return {
    update(mask, stats) {
      if (!context) return
      const now = performance.now()
      if (now - lastPaint < REFRESH_MS) return
      lastPaint = now

      if (canvas.width !== mask.width || canvas.height !== mask.height) {
        canvas.width = mask.width
        canvas.height = mask.height
      }

      context.fillStyle = '#000'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(mask, 0, 0, canvas.width, canvas.height)

      const coverage = (stats.coverage * 100).toFixed(1).replace('.', ',')
      label.textContent = `couverture ${coverage} % · trous comblés ${stats.holesFilled} px`
    },
    dispose() {
      root.remove()
    },
  }
}
