import type { RTKParticipant, RTKSelf } from '@cloudflare/realtimekit'
import { useRealtimeKitMeeting, useRealtimeKitSelector } from '@cloudflare/realtimekit-react'
import { Eye, EyeOff, Maximize2, MicOff, Minimize2, MonitorOff, MonitorUp, Volume1, VideoOff } from 'lucide-react'
import { useState } from 'react'

import { Button } from '../ui/Button'
import {
  COMPACT_TILE_CLASS,
  PRESENTATION_STAGE_CLASS,
  WAITING_BANNER_CLASS,
  presentationSurfaceClass,
  stageGridClass,
  stageTileClass,
} from './layout'
import { RemoteScreenShare, RtkParticipantVideo, RtkSelfVideo, SelfScreenShareView } from './RtkVideoSurface'
import { VideoPlaceholder } from './VideoSurface'
import { usePresentationFullscreen } from './usePresentationFullscreen'
import { cn } from '../../lib/cn'
import { useMeeting } from '../../state/meetingContext'

/**
 * Scène principale de la réunion.
 * - partage d'écran en cours : l'écran occupe toute la scène, les caméras
 *   passent en vignettes compactes sous le partage ;
 * - sinon : grille des caméras, participant local inclus.
 * Toutes les images proviennent du SDK : aucune vignette n'est simulée.
 */
export function MeetingStage() {
  const { participantName, setScreenShareEnabled } = useMeeting()
  const { meeting } = useRealtimeKitMeeting()

  const remotes = useRealtimeKitSelector((client) => client.participants.joined.toArray())
  const selfScreenSharing = useRealtimeKitSelector((client) => client.self.screenShareEnabled)

  const displayName = participantName.trim() || 'Vous'
  const sharingRemote = remotes.find((participant) => participant.screenShareEnabled)
  const sharing = selfScreenSharing || Boolean(sharingRemote)

  if (sharing) {
    return (
      <PresentationStage
        self={meeting.self}
        sharingRemote={sharingRemote ?? null}
        isSelfSharing={selfScreenSharing}
        remotes={remotes}
        displayName={displayName}
        onStopSharing={() => void setScreenShareEnabled(false)}
      />
    )
  }

  /*
   * Seules les **vignettes réelles** entrent dans la grille. L'attente d'un
   * second participant est un bandeau compact au-dessus de la scène : avec un
   * seul participant, la vidéo occupe donc toute la scène, centrée, et aucune
   * cellule n'est réservée à un emplacement vide.
   */
  const tiles = remotes.length + 1

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-hidden">
      {remotes.length === 0 ? (
        <div className={WAITING_BANNER_CLASS} role="status">
          <MonitorUp aria-hidden="true" className="size-4 shrink-0 text-slate-500" />
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-slate-400">
            En attente des participants… Partagez le lien de réunion pour les inviter.
          </p>
        </div>
      ) : null}

      <div className={stageGridClass(tiles)}>
        <SelfTile name={displayName} tiles={tiles} />
        {remotes.map((participant) => (
          <RemoteTile key={participant.id} participant={participant} tiles={tiles} />
        ))}
      </div>
    </div>
  )
}

interface PresentationStageProps {
  self: RTKSelf
  sharingRemote: RTKParticipant | null
  isSelfSharing: boolean
  remotes: RTKParticipant[]
  displayName: string
  onStopSharing: () => void
}

/**
 * Mode présentation automatique.
 *
 * Le partage n'est pas une cellule de la grille des caméras : il dispose de sa
 * propre scène, dimensionnée par la place réellement disponible. Les caméras
 * sont reléguées dans une fine bande défilante, que chaque participant peut
 * masquer localement.
 */
function PresentationStage({
  self,
  sharingRemote,
  isSelfSharing,
  remotes,
  displayName,
  onStopSharing,
}: PresentationStageProps) {
  const [camerasVisible, setCamerasVisible] = useState(true)
  const [surface, setSurface] = useState<HTMLDivElement | null>(null)
  const fullscreen = usePresentationFullscreen(surface)

  const sharerName = sharingRemote?.name ?? 'un participant'
  const title = isSelfSharing ? 'Votre écran partagé' : `Écran partagé par ${sharerName}`

  return (
    <section className={PRESENTATION_STAGE_CLASS} aria-label="Mode présentation">
      <div
        data-presentation-toolbar
        className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-ink-800 bg-ink-900 px-2 py-1.5 sm:px-3"
      >
        <MonitorUp aria-hidden="true" className="size-4 shrink-0 text-accent-300" />
        <p className="min-w-0 flex-1 truncate text-xs font-medium text-white">{title}</p>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => setCamerasVisible((visible) => !visible)}
            aria-pressed={camerasVisible}
            aria-label={camerasVisible ? 'Masquer les caméras' : 'Afficher les caméras'}
            title={camerasVisible ? 'Masquer les caméras' : 'Afficher les caméras'}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-ink-600 bg-ink-800 px-2 text-xs font-medium text-slate-200 transition-colors hover:bg-ink-700 hover:text-white"
          >
            {camerasVisible ? (
              <EyeOff aria-hidden="true" className="size-4" />
            ) : (
              <Eye aria-hidden="true" className="size-4" />
            )}
            <span className="hidden md:inline">
              {camerasVisible ? 'Masquer les caméras' : 'Afficher les caméras'}
            </span>
          </button>

          <Button
            variant="secondary"
            size="sm"
            className="h-8 px-2.5 text-xs"
            aria-label={fullscreen.expanded ? 'Quitter le plein écran' : 'Agrandir le partage'}
            aria-pressed={fullscreen.expanded}
            onClick={() => void fullscreen.toggle()}
          >
            {fullscreen.expanded ? (
              <Minimize2 aria-hidden="true" className="size-4" />
            ) : (
              <Maximize2 aria-hidden="true" className="size-4" />
            )}
            <span className="hidden sm:inline">
              {fullscreen.expanded ? 'Quitter le plein écran' : 'Agrandir le partage'}
            </span>
            <span className="sm:hidden">{fullscreen.expanded ? 'Quitter' : 'Agrandir'}</span>
          </Button>

          {isSelfSharing ? (
            <Button
              variant="danger"
              size="sm"
              className="h-8 px-2.5 text-xs"
              aria-label="Arrêter le partage"
              onClick={onStopSharing}
            >
              <MonitorOff aria-hidden="true" className="size-4" />
              <span className="hidden sm:inline">Arrêter le partage</span>
              <span className="sm:hidden">Arrêter</span>
            </Button>
          ) : null}
        </div>
      </div>

      {fullscreen.error && !fullscreen.expanded ? (
        <p role="status" className="shrink-0 border-b border-amber-500/20 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-100">
          {fullscreen.error}
        </p>
      ) : null}

      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black p-1 sm:p-2">
        <div
          ref={setSurface}
          className={presentationSurfaceClass(fullscreen.mode === 'fallback')}
          data-presentation-surface={fullscreen.mode}
        >
          {isSelfSharing ? (
            <SelfScreenShareView
              self={self}
              label={title}
              className="size-full"
              placeholder={
                <VideoPlaceholder
                  title="Partage d’écran"
                  subtitle="Le partage est en cours de démarrage : autorisez la capture si le navigateur le demande."
                />
              }
            />
          ) : sharingRemote ? (
            <RemoteScreenShare
              participant={sharingRemote}
              label={title}
              className="size-full"
              placeholder={
                <VideoPlaceholder
                  title={`Écran de ${sharingRemote.name}`}
                  subtitle="L’image arrive dès que le partage est établi."
                />
              }
            />
          ) : null}

          {fullscreen.expanded ? (
            <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-3 bg-linear-to-b from-ink-950/85 via-ink-950/40 to-transparent p-2 sm:p-3">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="max-w-full truncate rounded-full border border-ink-600 bg-ink-950/75 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur-sm">
                  {title}
                </span>
                {fullscreen.error ? (
                  <span role="status" className="max-w-md text-[11px] leading-relaxed text-amber-100">
                    {fullscreen.error}
                  </span>
                ) : null}
              </div>

              <Button
                variant="secondary"
                size="sm"
                className="pointer-events-auto shrink-0 border-ink-500 bg-ink-950/85 shadow-lg shadow-black/40"
                onClick={() => void fullscreen.exit()}
              >
                <Minimize2 aria-hidden="true" className="size-4" />
                Quitter le plein écran
              </Button>
            </div>
          ) : null}
        </div>
      </div>

      {camerasVisible ? (
        <div data-presentation-cameras className="shrink-0 border-t border-ink-800 bg-ink-950 px-2 py-1.5">
          <div className="flex gap-1.5 overflow-x-auto pb-0.5">
            <SelfTile name={displayName} compact />
            {remotes.map((participant) => (
              <RemoteTile key={participant.id} participant={participant} compact />
            ))}
          </div>
        </div>
      ) : null}
    </section>
  )
}

function SelfTile({
  name,
  tiles = 1,
  compact = false,
}: {
  name: string
  tiles?: number
  compact?: boolean
}) {
  const { meeting } = useRealtimeKitMeeting()
  const videoEnabled = useRealtimeKitSelector((client) => client.self.videoEnabled)
  const audioEnabled = useRealtimeKitSelector((client) => client.self.audioEnabled)

  return (
    <div className={compact ? COMPACT_TILE_CLASS : stageTileClass(tiles)}>
      <RtkSelfVideo
        self={meeting.self}
        enabled={videoEnabled}
        /*
         * L'aperçu local est toujours en miroir, avec ou sans effet. Le décor
         * composé y apparaît à l'endroit : il est déjà inversé dans le flux.
         * Le flux publié, lui, n'est jamais inversé — les autres participants
         * voient l'orientation de la caméra.
         */
        mirrored
        label={`Votre flux vidéo (${name})`}
        className="size-full"
        placeholder={
          <VideoPlaceholder
            title={name}
            subtitle={
              compact
                ? undefined
                : videoEnabled
                  ? 'Aucune image : votre caméra est peut-être déjà utilisée ailleurs.'
                  : 'Votre caméra est coupée. Réactivez-la depuis la barre de contrôle.'
            }
          />
        }
      />
      <TileFooter
        name={name}
        audioEnabled={audioEnabled}
        videoEnabled={videoEnabled}
        isLocal
        compact={compact}
      />
    </div>
  )
}

function RemoteTile({
  participant,
  tiles,
  compact = false,
}: {
  participant: RTKParticipant
  tiles?: number
  compact?: boolean
}) {
  return (
    <div className={compact ? COMPACT_TILE_CLASS : stageTileClass(tiles ?? 1)}>
      <RtkParticipantVideo
        participant={participant}
        enabled={participant.videoEnabled}
        label={`Flux vidéo de ${participant.name}`}
        className="size-full"
        placeholder={
          <VideoPlaceholder
            title={participant.name}
            subtitle={compact ? undefined : 'Caméra coupée : le participant est bien connecté.'}
          />
        }
      />
      <TileFooter
        name={participant.name}
        audioEnabled={participant.audioEnabled}
        videoEnabled={participant.videoEnabled}
        // Voix attendue mais piste pas encore reçue : l'état affiché reste
        // celui du média réellement reçu, jamais une intention supposée.
        audioTrackReceived={Boolean(participant.audioTrack)}
        isHost={participant.isHost}
        compact={compact}
      />
    </div>
  )
}

interface TileFooterProps {
  name: string
  audioEnabled: boolean
  videoEnabled?: boolean
  /** Une piste audio distante est-elle réellement reçue ? (micro local : sans objet) */
  audioTrackReceived?: boolean
  isHost?: boolean
  isLocal?: boolean
  compact?: boolean
}

function TileFooter({
  name,
  audioEnabled,
  videoEnabled = true,
  audioTrackReceived = true,
  isHost = false,
  isLocal = false,
  compact = false,
}: TileFooterProps) {
  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-linear-to-t from-ink-950/85 to-transparent',
        compact ? 'px-2 pt-6 pb-1.5' : 'px-3 pt-8 pb-2',
      )}
    >
      <span
        className={cn(
          'flex min-w-0 items-center gap-2 font-medium text-white',
          compact ? 'text-[10px]' : 'text-xs',
        )}
      >
        <span className="truncate">
          {name}
          {isLocal ? ' (vous)' : ''}
        </span>
        {isHost && !compact ? (
          <span className="rounded-full bg-accent-500/20 px-1.5 py-0.5 text-[10px] text-accent-100">
            Organisateur
          </span>
        ) : null}
      </span>

      <span className="flex shrink-0 items-center gap-1">
        {compact && !videoEnabled ? (
          <VideoOff aria-label="Caméra coupée" className="size-3.5 shrink-0 text-rose-300" />
        ) : null}
        {!audioEnabled ? (
          <MicOff aria-label="Micro coupé" className="size-3.5 shrink-0 text-rose-300" />
        ) : !audioTrackReceived ? (
          <Volume1
            aria-label="Voix en cours de réception"
            className="size-3.5 shrink-0 animate-pulse text-amber-300"
          />
        ) : null}
      </span>
    </div>
  )
}
