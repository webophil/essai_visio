import { useEffect, useState } from 'react'
import type { ChangeEvent } from 'react'
import { Activity, Check, ImagePlus, Info, Loader2, Sparkles, Trash2, WandSparkles } from 'lucide-react'

import { Notice } from '../ui/Notice'
import { SidePanel } from '../ui/SidePanel'
import { NOTICES } from '../../lib/notices'
import { readVideoEffectStats } from '../../media/backgroundBlur'
import type { VideoEffectStats } from '../../media/backgroundBlur'
import { BACKDROP_PRESETS } from '../../media/backdrops'
import { useMeeting } from '../../state/meetingContext'
import type { VideoBackdrop, VideoEffectChoice } from '../../types/meeting'

/** Poids maximal accepté pour une image de fond importée. */
const MAX_IMPORT_BYTES = 8 * 1024 * 1024

/** Aperçu du flou : hachures diagonales, identiques au rendu attendu. */
const BLUR_PREVIEW_CLASS =
  'bg-ink-800 bg-[repeating-linear-gradient(45deg,transparent,transparent_6px,rgba(148,163,184,0.22)_6px,rgba(148,163,184,0.22)_12px)]'

function sameBackdrop(a?: VideoBackdrop, b?: VideoBackdrop): boolean {
  if (!a || !b) return a === b
  if (a.kind === 'preset' && b.kind === 'preset') return a.preset === b.preset
  if (a.kind === 'image' && b.kind === 'image') return a.url === b.url
  return false
}

/** Un choix est actif s'il correspond exactement à l'effet en place. */
function isActive(choice: VideoEffectChoice, current: VideoEffectChoice): boolean {
  return choice.id === current.id && sameBackdrop(choice.backdrop, current.backdrop)
}

interface EffectTileProps {
  label: string
  description: string
  previewClass?: string
  selected: boolean
  busy: boolean
  onSelect: () => void
}

function EffectTile({
  label,
  description,
  previewClass = 'bg-ink-800',
  selected,
  busy,
  onSelect,
}: EffectTileProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={busy}
      title={label}
      onClick={onSelect}
      className={[
        'flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors',
        'disabled:cursor-wait disabled:opacity-70',
        selected
          ? 'border-accent-500/60 bg-accent-500/10'
          : 'border-ink-600 bg-ink-850 hover:border-ink-500',
      ].join(' ')}
    >
      <span
        aria-hidden="true"
        className={`size-11 shrink-0 rounded-lg border border-ink-600 ${previewClass}`}
      />

      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium text-white">{label}</span>
        <span className="text-xs leading-relaxed text-slate-400">{description}</span>
      </span>

      {selected ? (
        busy ? (
          <Loader2 aria-label="Application en cours" className="size-4 animate-spin text-accent-200" />
        ) : (
          <span className="flex items-center gap-1 text-[11px] font-medium text-accent-200">
            <Check aria-hidden="true" className="size-3.5" />
            Actif
          </span>
        )
      ) : null}
    </button>
  )
}

/**
 * Effets de fond.
 *
 * Trois traitements réellement appliqués au flux publié : aucun, flou, décor.
 * Les décors sont soit des teintes peintes localement, soit une image choisie
 * sur l'appareil — elle n'est jamais téléversée et disparaît à la fermeture de
 * la page. Aucune option n'est affichée sans être rendue (voir
 * `src/media/backgroundBlur.ts`).
 */
export function BackgroundEffectsPanel() {
  const {
    closePanel,
    media,
    videoEffect,
    setVideoEffect,
    videoEffectBusy,
    videoEffectError,
  } = useMeeting()

  const [localError, setLocalError] = useState<string | null>(null)

  const hasVideo = media.hasVideoTrack && media.videoEnabled
  const customImage = videoEffect.backdrop?.kind === 'image' ? videoEffect.backdrop.url : null
  const active = videoEffect.id !== 'none'

  /** Importe une image de fond : elle reste dans ce navigateur. */
  const importImage = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const file = input.files?.[0]
    // Permet de réimporter le même fichier après une erreur.
    input.value = ''

    if (!file) return
    if (!file.type.startsWith('image/')) {
      setLocalError("Ce fichier n'est pas une image reconnue par le navigateur.")
      return
    }
    if (file.size > MAX_IMPORT_BYTES) {
      setLocalError('Cette image dépasse 8 Mo. Choisissez un fichier plus léger.')
      return
    }

    setLocalError(null)
    void setVideoEffect({
      id: 'backdrop',
      backdrop: { kind: 'image', url: URL.createObjectURL(file) },
    })
  }

  return (
    <SidePanel title="Effets de fond" icon={WandSparkles} onClose={closePanel}>
      <div className="flex flex-col gap-4">
        {videoEffectError ? (
          <Notice tone="danger" title="Effet non appliqué">
            {videoEffectError}
          </Notice>
        ) : null}

        {localError ? (
          <Notice tone="danger" title="Image non utilisée">
            {localError}
          </Notice>
        ) : null}

        <section className="flex flex-col gap-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Traitement
          </h3>

          <EffectTile
            label="Aucun effet"
            description="Votre caméra est diffusée telle quelle, sans traitement."
            selected={videoEffect.id === 'none'}
            busy={videoEffectBusy}
            onSelect={() => {
              if (videoEffect.id !== 'none') void setVideoEffect({ id: 'none' })
            }}
          />

          <EffectTile
            label="Flou"
            description="Détoure votre silhouette et floute l'arrière-plan."
            previewClass={BLUR_PREVIEW_CLASS}
            selected={videoEffect.id === 'blur'}
            busy={videoEffectBusy}
            onSelect={() => {
              if (videoEffect.id !== 'blur') void setVideoEffect({ id: 'blur' })
            }}
          />
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Décors
          </h3>

          <div className="grid grid-cols-2 gap-2">
            {BACKDROP_PRESETS.map((preset) => {
              const choice: VideoEffectChoice = {
                id: 'backdrop',
                backdrop: { kind: 'preset', preset: preset.id },
              }
              const selected = isActive(choice, videoEffect)

              return (
                <button
                  key={preset.id}
                  type="button"
                  aria-pressed={selected}
                  disabled={videoEffectBusy}
                  title={preset.description}
                  onClick={() => {
                    if (!selected) void setVideoEffect(choice)
                  }}
                  className={[
                    'flex flex-col gap-1.5 rounded-xl border p-2 text-left transition-colors',
                    'disabled:cursor-wait disabled:opacity-70',
                    selected
                      ? 'border-accent-500/60 bg-accent-500/10'
                      : 'border-ink-600 bg-ink-850 hover:border-ink-500',
                  ].join(' ')}
                >
                  <span
                    aria-hidden="true"
                    className="relative block h-16 w-full overflow-hidden rounded-lg border border-ink-600"
                    style={{ backgroundImage: preset.swatch }}
                  >
                    {selected ? (
                      <span className="absolute right-1.5 top-1.5 grid size-5 place-items-center rounded-full bg-ink-950/70">
                        <Check aria-hidden="true" className="size-3.5 text-accent-200" />
                      </span>
                    ) : null}
                  </span>
                  <span className="text-xs font-medium text-white">{preset.label}</span>
                  <span className="text-[11px] leading-snug text-slate-400">
                    {preset.description}
                  </span>
                </button>
              )
            })}
          </div>

          <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-ink-600 bg-ink-850 px-3 py-2.5 text-xs font-medium text-slate-200 transition-colors hover:border-ink-500">
            <ImagePlus aria-hidden="true" className="size-4 text-accent-200" />
            Importer une image…
            <input type="file" accept="image/*" className="sr-only" onChange={importImage} />
          </label>

          {customImage ? (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-accent-500/40 bg-accent-500/10 px-3 py-2 text-xs text-slate-200">
              <span className="flex items-center gap-1.5">
                <Check aria-hidden="true" className="size-3.5 text-accent-200" />
                Image personnelle active
              </span>
              <button
                type="button"
                onClick={() => void setVideoEffect({ id: 'none' })}
                className="flex items-center gap-1 rounded-lg px-1.5 py-1 text-slate-300 transition-colors hover:bg-ink-800 hover:text-white"
              >
                <Trash2 aria-hidden="true" className="size-3.5" />
                Retirer
              </button>
            </div>
          ) : null}
        </section>

        {active ? <EffectDiagnostics /> : null}

        <Notice tone="info" title="Traitement local" className="text-xs">
          {NOTICES.backgroundEffects}
        </Notice>

        <p className="flex items-start gap-2 text-xs leading-relaxed text-slate-400">
          <Sparkles aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-slate-500" />
          {hasVideo
            ? active
              ? 'Le détourage est calculé sur cet appareil, image par image. Sur une machine modeste, la fluidité de votre vidéo peut baisser légèrement.'
              : 'Choisissez « Flou » ou un décor : votre caméra locale reste inchangée, seul le flux envoyé est composé.'
            : 'Activez votre caméra pour appliquer un effet : sans image, il n’y a rien à détourer.'}
        </p>

        <p className="flex items-start gap-2 text-xs leading-relaxed text-slate-500">
          <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {NOTICES.backgroundBlurUnsupported}
        </p>
      </div>
    </SidePanel>
  )
}

/**
 * Compteurs de fonctionnement du détourage.
 *
 * Ils répondent à une question simple : « des images traversent-elles vraiment
 * le traitement ? ». Aucune image, aucun contenu n'est journalisé ni transmis ;
 * seuls des nombres sont affichés. Un compteur bloqué à 0 alors que la caméra
 * tourne révèle immédiatement un middleware qui ne reçoit rien.
 */
function EffectDiagnostics() {
  const [stats, setStats] = useState<VideoEffectStats | null>(() => readVideoEffectStats())

  useEffect(() => {
    const timer = window.setInterval(() => setStats(readVideoEffectStats()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <div className="rounded-xl border border-ink-700 bg-ink-850 px-3 py-2.5">
      <p className="flex items-center gap-2 text-xs font-medium text-slate-200">
        <Activity aria-hidden="true" className="size-3.5 text-emerald-300" />
        Traitement en cours
      </p>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-slate-400">
        <dt>Images reçues</dt>
        <dd className="text-right font-mono tabular-nums text-slate-200">
          {stats ? `${stats.imagesPerSecond} / s` : '…'}
        </dd>
        <dt>Détourages calculés</dt>
        <dd className="text-right font-mono tabular-nums text-slate-200">
          {stats ? `${stats.masksPerSecond} / s` : '…'}
        </dd>
        <dt>Images recomposées</dt>
        <dd className="text-right font-mono tabular-nums text-slate-200">
          {stats ? stats.imagesBlurred : '…'}
        </dd>
        <dt>Silhouette détectée</dt>
        <dd className="text-right font-mono tabular-nums text-slate-200">
          {stats ? `${Math.round(stats.personCoverage * 100)} %` : '…'}
        </dd>
      </dl>
      {stats ? (
        <p className="mt-1.5 font-mono text-[11px] text-slate-500">
          flux {stats.frameWidth > 0 ? `${stats.frameWidth}×${stats.frameHeight}` : '…'} · masque
          brut · R {stats.maskRedMean} · A {stats.maskAlphaMean}
        </p>
      ) : null}
      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
        Ces compteurs ne contiennent aucune image : ils confirment seulement que le fond est
        recomposé avant l’envoi.
      </p>
    </div>
  )
}
