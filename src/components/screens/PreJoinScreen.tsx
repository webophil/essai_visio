import { useState } from 'react'
import {
  CameraOff,
  ChevronLeft,
  Crown,
  Loader2,
  Mic,
  MicOff,
  RefreshCw,
  UserRound,
  Users,
  Video,
  VideoOff,
  WandSparkles,
} from 'lucide-react'

import { PhilDevLogo } from '../Brand/PhilDevLogo'
import { Button } from '../ui/Button'
import { Notice } from '../ui/Notice'
import { SelectField } from '../ui/SelectField'
import { StatusPill } from '../ui/StatusPill'
import { TextField } from '../ui/TextField'
import { InviteByEmailPanel } from '../meeting/InviteByEmailPanel'
import { BackgroundEffectPicker } from '../meeting/BackgroundEffectsPanel'
import { VideoPlaceholder, VideoSurface } from '../meeting/VideoSurface'
import { useMeeting } from '../../state/meetingContext'
import { usePreviewEffect } from '../../media/usePreviewEffect'
import { NOTICES } from '../../lib/notices'
import { mediaDevicesSupported } from '../../lib/mediaErrors'
import { cn } from '../../lib/cn'

export interface PreJoinScreenProps {
  onBack: () => void
}

/**
 * Écran de préparation : aperçu réel de la caméra (capture assurée par le SDK),
 * choix du nom et des périphériques. Aucune fausse permission : les erreurs du
 * navigateur sont affichées telles quelles, traduites en français.
 */
export function PreJoinScreen({ onBack }: PreJoinScreenProps) {
  const {
    meetingName,
    meetingId,
    realtimeKitId,
    participantName,
    setParticipantName,
    media,
    joinMeeting,
    joining,
    joinError,
    clearJoinError,
    toggleAudio,
    toggleVideo,
    isHost,
    videoEffect,
  } = useMeeting()

  const [nameError, setNameError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [previewCanvas, setPreviewCanvas] = useState<HTMLCanvasElement | null>(null)

  // Aperçu local du décor : même moteur que la salle, sur un canvas distinct.
  const previewTrack = media.stream?.getVideoTracks()[0] ?? null
  const preview = usePreviewEffect(previewCanvas, previewTrack, videoEffect)
  const previewVisible = videoEffect.id !== 'none' && preview.ready

  const supportsMedia = mediaDevicesSupported()
  const hasVideo = media.hasVideoTrack && media.videoEnabled
  const audioActive = media.hasAudioTrack && media.audioEnabled
  const requestPending = media.audioState === 'requesting' || media.videoState === 'requesting'
  const busy = joining || pending

  const handleJoin = async () => {
    if (participantName.trim().length < 2) {
      setNameError(
        'Indiquez au moins deux caractères pour que les autres participants vous identifient.',
      )
      return
    }

    setNameError(null)
    setPending(true)
    try {
      await joinMeeting()
    } finally {
      setPending(false)
    }
  }

  const permissionMessage =
    media.audioState === 'denied' || media.videoState === 'denied' ? "L'accès a été refusé." : null

  return (
    <div className="stage-backdrop flex min-h-dvh flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-5 py-5 sm:px-8">
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-slate-300 transition-colors hover:bg-ink-800 hover:text-white"
          >
            <ChevronLeft aria-hidden="true" className="size-4" />
            Retour
          </button>
          <PhilDevLogo size="sm" />
        </div>

        {isHost ? (
          <StatusPill
            tone="neutral"
            icon={<Crown aria-hidden="true" className="size-3.5 text-amber-300" />}
          >
            Organisateur
          </StatusPill>
        ) : null}
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-5 pb-10 sm:px-8">
        <div className="flex flex-col gap-1.5">
          <h1 className="font-display text-2xl font-semibold tracking-tight text-white sm:text-3xl">
            Rejoindre « {meetingName} »
          </h1>
          <p className="text-sm text-slate-400">
            Vérifiez votre caméra et votre microphone avant de rejoindre la réunion.
          </p>
        </div>

        {joinError ? (
          <Notice
            tone="danger"
            title="Entrée en réunion impossible"
            action={
              <Button variant="secondary" size="sm" onClick={clearJoinError}>
                Masquer
              </Button>
            }
          >
            {joinError.message}
          </Notice>
        ) : null}

        {!supportsMedia ? (
          <Notice tone="danger" title="Navigateur non compatible">
            Ce navigateur n&apos;expose pas l&apos;API <code>navigator.mediaDevices</code>. Vous
            pouvez continuer sans caméra ni micro, mais aucune image ne sera transmise.
          </Notice>
        ) : null}

        {!window.isSecureContext ? (
          <Notice tone="warning" title="Contexte non sécurisé">
            L&apos;accès au matériel nécessite HTTPS ou <code>localhost</code>. En HTTP, le
            navigateur bloquera la demande d&apos;autorisation.
          </Notice>
        ) : null}

        {media.failure ? (
          <Notice
            tone="danger"
            title={media.failure.title}
            action={
              media.failure.canRetry ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    media.clearFailure()
                    void media.requestMedia({ audio: true, video: true })
                  }}
                >
                  <RefreshCw aria-hidden="true" className="size-4" />
                  Réessayer
                </Button>
              ) : null
            }
          >
            {media.failure.message}
          </Notice>
        ) : null}

        <div className="grid flex-1 gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <section className="flex flex-col gap-3">
            <VideoSurface
              stream={media.stream}
              active={hasVideo}
              /* L'aperçu local est toujours en miroir, avec ou sans effet. */
              mirrored
              label="Aperçu de votre caméra"
              className="aspect-video w-full rounded-2xl border border-ink-700"
              placeholder={
                <VideoPlaceholder
                  title={participantName.trim() || 'Vous'}
                  subtitle={
                    requestPending
                      ? 'Demande d’accès à la caméra…'
                      : media.videoEnabled
                        ? 'Aucune image : autorisez la caméra pour vous voir.'
                        : 'Caméra désactivée.'
                  }
                />
              }
            >
              {/* Le canvas composé garde le rapport de la caméra (souvent 4:3).
                  `object-cover` le cadre comme la vidéo naturelle : sinon des
                  bandes latérales apparaissent et le 16:9 semble perdu.
                  `-scale-x-100` garde l'aperçu en miroir, comme la vidéo sans
                  effet ; l'image de fond est déjà inversée dans le canvas, elle
                  apparaît donc à l'endroit ici. Le flux publié reste intact. */}
              <canvas
                ref={setPreviewCanvas}
                aria-hidden="true"
                className={cn(
                  'absolute inset-0 size-full bg-ink-950 -scale-x-100 object-cover',
                  previewVisible ? '' : 'hidden',
                )}
              />

              {videoEffect.id !== 'none' && preview.busy ? (
                <div className="absolute inset-0 grid place-items-center bg-ink-950/60">
                  <span className="flex items-center gap-2 text-xs text-slate-200">
                    <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                    Préparation de l’aperçu…
                  </span>
                </div>
              ) : null}

              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 bg-linear-to-t from-ink-950/85 to-transparent px-4 pt-10 pb-3">
                <span className="flex items-center gap-2 text-sm font-medium text-white">
                  {participantName.trim() || 'Vous'}
                  {hasVideo ? null : (
                    <VideoOff aria-hidden="true" className="size-4 text-rose-300" />
                  )}
                </span>
                <span className="flex items-center gap-1.5 text-xs text-slate-300">
                  {audioActive ? (
                    <>
                      <Mic aria-hidden="true" className="size-3.5 text-emerald-300" />
                      Micro actif
                    </>
                  ) : (
                    <>
                      <MicOff aria-hidden="true" className="size-3.5 text-rose-300" />
                      Micro coupé
                    </>
                  )}
                </span>
              </div>
            </VideoSurface>

            {preview.error ? (
              <Notice tone="warning" title="Aperçu de l’effet indisponible">
                {preview.error}
              </Notice>
            ) : null}

            <div className="flex flex-wrap gap-2.5">
              {/* Libellé et état suivent la piste réellement active : un micro
                  sans piste (refus, matériel absent) propose de le rétablir. */}
              <Button
                variant={audioActive ? 'secondary' : 'danger'}
                onClick={() => void toggleAudio(!audioActive)}
                aria-pressed={audioActive}
                disabled={!supportsMedia}
              >
                {audioActive ? (
                  <Mic aria-hidden="true" className="size-5" />
                ) : (
                  <MicOff aria-hidden="true" className="size-5" />
                )}
                {audioActive ? 'Couper le micro' : 'Activer le micro'}
              </Button>

              <Button
                variant={hasVideo ? 'secondary' : 'danger'}
                onClick={() => void toggleVideo(!hasVideo)}
                aria-pressed={hasVideo}
                disabled={!supportsMedia}
              >
                {hasVideo ? (
                  <Video aria-hidden="true" className="size-5" />
                ) : (
                  <CameraOff aria-hidden="true" className="size-5" />
                )}
                {hasVideo ? 'Couper la caméra' : 'Activer la caméra'}
              </Button>

              <Button
                variant="ghost"
                onClick={() => void media.requestMedia({ audio: true, video: true })}
                disabled={!supportsMedia || requestPending}
              >
                {requestPending ? (
                  <Loader2 aria-hidden="true" className="size-5 animate-spin" />
                ) : (
                  <RefreshCw aria-hidden="true" className="size-5" />
                )}
                Autoriser caméra et micro
              </Button>
            </div>

            <p className="flex items-start gap-2 text-xs leading-relaxed text-slate-400">
              <UserRound aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              {NOTICES.deviceFallback}
            </p>

            {/*
             * Même choix qu'en réunion, mais sans transport : le décor retenu
             * est mémorisé puis appliqué au flux publié à l'entrée en salle.
             */}
            <section className="surface-panel flex flex-col gap-3 rounded-2xl p-4">
              <h2 className="flex items-center gap-2 text-sm font-medium text-white">
                <WandSparkles aria-hidden="true" className="size-4 text-accent-200" />
                Arrière-plan
              </h2>

              <BackgroundEffectPicker />

              <p className="text-[11px] leading-relaxed text-slate-500">
                L’aperçu ci-dessus applique le même traitement que celui qui sera envoyé aux
                participants dès votre entrée en réunion.
              </p>
            </section>
          </section>

          <section className="surface-panel flex flex-col gap-5 rounded-2xl p-5">
            <TextField
              label="Votre nom"
              placeholder="Aurore Dupont"
              value={participantName}
              error={nameError}
              hint="Ce nom s'affiche pendant la réunion et n'est visible que des participants."
              autoComplete="name"
              maxLength={60}
              onChange={(event) => {
                setParticipantName(event.target.value)
                if (nameError) setNameError(null)
              }}
            />

            <SelectField
              label="Microphone"
              value={media.selectedAudioDeviceId}
              options={media.devices.audioInputs.map((device) => ({
                value: device.deviceId,
                label: device.label,
              }))}
              disabled={!supportsMedia}
              onChange={(deviceId) => void media.selectAudioDevice(deviceId)}
              hint={
                media.devices.audioInputs.length === 0
                  ? "Aucun microphone détecté pour l'instant — autorisez l'accès pour afficher la liste."
                  : undefined
              }
            />

            <SelectField
              label="Caméra"
              value={media.selectedVideoDeviceId}
              options={media.devices.videoInputs.map((device) => ({
                value: device.deviceId,
                label: device.label,
              }))}
              disabled={!supportsMedia}
              onChange={(deviceId) => void media.selectVideoDevice(deviceId)}
              hint={
                media.devices.videoInputs.length === 0
                  ? "Aucune caméra détectée pour l'instant — autorisez l'accès pour afficher la liste."
                  : undefined
              }
            />

            {permissionMessage ? (
              <Notice tone="warning" title="Autorisation bloquée">
                {permissionMessage} Utilisez l&apos;icône de cadenas dans la barre d&apos;adresse
                pour autoriser la caméra et le microphone, puis réessayez.
              </Notice>
            ) : null}

            {isHost && realtimeKitId ? (
              <InviteByEmailPanel
                meetingId={meetingId}
                realtimeKitId={realtimeKitId}
                meetingName={meetingName}
              />
            ) : null}

            <div className="mt-auto flex flex-col gap-3 border-t border-ink-700 pt-4">
              <Button size="lg" onClick={() => void handleJoin()} disabled={busy} className="w-full">
                {busy ? (
                  <Loader2 aria-hidden="true" className="size-5 animate-spin" />
                ) : (
                  <Video aria-hidden="true" className="size-5" />
                )}
                {busy ? 'Connexion…' : 'Rejoindre la réunion'}
              </Button>

              {/* Capacité réelle de la réunion : le plafond est contrôlé côté
                  serveur, l'interface se contente de l'indiquer. */}
              <p className="flex items-center gap-1.5 text-xs text-slate-500">
                <Users aria-hidden="true" className="size-3.5 shrink-0" />
                Jusqu’à 5 participants
              </p>
            </div>
          </section>
        </div>
      </main>
    </div>
  )
}
