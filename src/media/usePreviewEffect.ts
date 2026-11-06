import { useEffect, useState } from 'react'

import { createBackgroundBlurRenderer } from './backgroundBlur'
import type { BackgroundBlurRenderer } from './backgroundBlur'
import type { VideoEffectChoice } from '../types/meeting'

/** État de l'aperçu local d'un effet de fond. */
export interface PreviewEffectState {
  /** Le moteur prépare son premier masque. */
  busy: boolean
  /** Le canvas affiche une image composée. */
  ready: boolean
  /** Message lisible si l'aperçu ne peut pas être calculé. */
  error: string | null
}

const IDLE: PreviewEffectState = { busy: false, ready: false, error: null }

/**
 * Aperçu local d'un effet de fond, **hors du flux publié**.
 *
 * L'écran de préparation ne dispose d'aucun transport : il n'y a pas encore de
 * piste publiée à laquelle accrocher un middleware. Cette instance du moteur
 * compose donc directement les images de la piste de préparation dans un
 * canvas, pour montrer exactement ce que l'invité enverra. Le flux publié, lui,
 * reçoit son propre rendu au moment de l'entrée en salle : les deux ne se
 * partagent aucun état, et l'aperçu n'altère jamais la piste du SDK.
 *
 * Le rendu est recréé quand le décor ou la piste change (changement de caméra) ;
 * il est libéré au démontage, sans laisser tourner d'intervalle ni d'élément
 * vidéo.
 */
export function usePreviewEffect(
  canvas: HTMLCanvasElement | null,
  track: MediaStreamTrack | null,
  choice: VideoEffectChoice,
): PreviewEffectState {
  const [state, setState] = useState<PreviewEffectState>(IDLE)
  const active = choice.id !== 'none'

  useEffect(() => {
    if (!canvas || !track || !active) {
      setState(IDLE)
      return
    }

    let cancelled = false
    let renderer: BackgroundBlurRenderer | null = null

    setState({ busy: true, ready: false, error: null })

    void (async () => {
      try {
        const created = await createBackgroundBlurRenderer(choice)
        if (cancelled) {
          created.dispose()
          return
        }

        renderer = created
        await created.attach(canvas, track)
        if (cancelled) return

        setState({ busy: false, ready: true, error: null })
      } catch {
        if (cancelled) return

        // L'échec est propre à l'aperçu : le choix reste mémorisé et sera
        // appliqué — ou refusé avec un message précis — à l'entrée en salle.
        setState({
          busy: false,
          ready: false,
          error:
            "L'aperçu de l'effet n'a pas pu être préparé sur cet appareil. Votre choix sera tout de même appliqué à l'entrée en réunion.",
        })
      }
    })()

    return () => {
      cancelled = true
      renderer?.dispose()
    }
  }, [canvas, track, choice, active])

  return state
}
