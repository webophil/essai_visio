import { useCallback, useState } from 'react'
import { Link2Off, Loader2, Video } from 'lucide-react'

import { PhilDevLogo } from '../Brand/PhilDevLogo'
import { Button } from '../ui/Button'
import { Notice } from '../ui/Notice'
import { TextField } from '../ui/TextField'
import { defaultStartInput, parseStartInput } from '../../lib/schedule'
import { meetingPath } from '../../lib/format'
import { MEETING_LINK_PARAM } from '../../lib/ids'
import { navigate } from '../../lib/router'
import { useDocumentTitle } from '../../lib/useDocumentTitle'
import { useCreateMeeting } from '../../meeting/useCreateMeeting'
import { MeetingProvider } from '../../state/MeetingProvider'
import { useMeeting } from '../../state/meetingContext'
import { MeetingScreen } from './MeetingScreen'
import { PreJoinScreen } from './PreJoinScreen'

function SessionRouter() {
  const { phase, meetingName, leaveMeeting, realtimeKitId } = useMeeting()

  useDocumentTitle(
    phase === 'in-meeting'
      ? `PhilDEV Visio — ${meetingName}`
      : `PhilDEV Visio — Rejoindre « ${meetingName} »`,
  )

  const handleBack = useCallback(() => {
    navigate('/')
  }, [])

  if (!realtimeKitId) return <IncompleteLinkScreen onBack={handleBack} />

  if (phase === 'in-meeting') return <MeetingScreen />

  return (
    <PreJoinScreen
      onBack={() => {
        // Quitte la salle et libère immédiatement le matériel local.
        void leaveMeeting().then(handleBack)
      }}
    />
  )
}

/**
 * Lien sans identifiant Cloudflare.
 * L'application ne fabrique aucune salle fantôme : elle explique ce qui manque
 * et propose à l'organisateur de rattacher le rendez-vous à une vraie réunion.
 */
function IncompleteLinkScreen({ onBack }: { onBack: () => void }) {
  const { meetingId, isHost } = useMeeting()
  const { start, busy, error } = useCreateMeeting()
  const [startValue, setStartValue] = useState(() => defaultStartInput())
  const [scheduleError, setScheduleError] = useState<string | null>(null)

  const handleCreate = () => {
    const startsAt = parseStartInput(startValue)
    if (!startsAt) {
      setScheduleError("Choisissez une date et une heure à venir, dans l'année.")
      return
    }
    setScheduleError(null)
    void start({ meetingId, startsAt })
  }

  return (
    <div className="stage-backdrop flex min-h-dvh flex-col items-center justify-center gap-6 px-6 text-center">
      <PhilDevLogo size="md" />

      <Link2Off aria-hidden="true" className="size-10 text-ink-400" />

      <div className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-semibold text-white">
          Ce lien n’ouvre aucune réunion
        </h1>
        <p className="max-w-lg text-sm leading-relaxed text-slate-400">
          Le rendez-vous{' '}
          <code className="rounded bg-ink-850 px-1.5 py-0.5 text-accent-200">
            {meetingPath(meetingId)}
          </code>{' '}
          n’est pas encore relié à une réunion Cloudflare RealtimeKit. Un lien d’invitation complet
          se termine par{' '}
          <code className="rounded bg-ink-850 px-1.5 py-0.5 text-accent-200">
            ?{MEETING_LINK_PARAM}=…
          </code>
          .
        </p>
      </div>

      {error ? (
        <Notice tone="danger" title="Création impossible">
          {error}
        </Notice>
      ) : null}

      {isHost ? (
        <div className="w-full max-w-sm text-left">
          <TextField
            label="Date et heure de la réunion"
            type="datetime-local"
            value={startValue}
            error={scheduleError}
            hint="Heure locale ; l'invitation l'indique en heure de Paris."
            onChange={(event) => {
              setStartValue(event.target.value)
              if (scheduleError) setScheduleError(null)
            }}
          />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-center gap-3">
        {isHost ? (
          <Button size="lg" disabled={busy} onClick={handleCreate}>
            {busy ? (
              <Loader2 aria-hidden="true" className="size-5 animate-spin" />
            ) : (
              <Video aria-hidden="true" className="size-5" />
            )}
            Créer cette réunion
          </Button>
        ) : null}

        <Button variant="secondary" size="lg" onClick={onBack}>
          Revenir à l’accueil
        </Button>
      </div>

      {!isHost ? (
        <p className="max-w-md text-sm leading-relaxed text-slate-400">
          Demandez à l’organisateur le lien d’invitation complet : il commence par
          <span className="font-mono"> /rdv-… </span>et contient le paramètre
          <span className="font-mono"> ?{MEETING_LINK_PARAM}=</span>.
        </p>
      ) : null}
    </div>
  )
}

export interface MeetingRoomProps {
  meetingId: string
  realtimeKitId: string | null
}

/** Une salle = un identifiant : le provider est remonté si l'identifiant change. */
export function MeetingRoom({ meetingId, realtimeKitId }: MeetingRoomProps) {
  return (
    <MeetingProvider key={`${meetingId}:${realtimeKitId ?? ''}`} meetingId={meetingId} realtimeKitId={realtimeKitId}>
      <SessionRouter />
    </MeetingProvider>
  )
}
