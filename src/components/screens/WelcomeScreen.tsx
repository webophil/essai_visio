import { useEffect, useState } from 'react'
import {
  ArrowRight,
  Crown,
  KeyRound,
  Link2,
  Loader2,
  MonitorUp,
  UserRound,
  Video,
} from 'lucide-react'

import { PhilDevLogo } from '../Brand/PhilDevLogo'
import { HostAccessDialog } from '../meeting/HostAccessDialog'
import { Button } from '../ui/Button'
import { Notice } from '../ui/Notice'
import { StatusPill } from '../ui/StatusPill'
import { TextField } from '../ui/TextField'
import { parseMeetingLink } from '../../lib/format'
import type { MeetingLink } from '../../lib/format'
import { defaultStartInput, parseStartInput } from '../../lib/schedule'
import { DEFAULT_MEETING_TITLE, MAX_MEETING_TITLE_LENGTH } from '../../lib/meetingTitle'
import { readHostSession } from '../../meeting/hostSession'
import { readLastMeeting } from '../../meeting/lastMeeting'
import type { LastMeeting } from '../../meeting/lastMeeting'
import { checkApiAvailability } from '../../meeting/rtkApi'
import { useCreateMeeting } from '../../meeting/useCreateMeeting'

const CAPABILITIES = [
  {
    icon: Video,
    title: 'Échange en visio',
    description: 'Retrouvez-vous en audio et en vidéo pour votre rendez-vous à distance.',
  },
  {
    icon: MonitorUp,
    title: 'Partage d’écran',
    description: 'Présentez un document, une page web ou une application pendant l’échange.',
  },
  {
    icon: Link2,
    title: 'Accès simple',
    description:
      'Un lien d’invitation suffit pour rejoindre la réunion depuis votre navigateur.',
  },
] as const

export interface WelcomeScreenProps {
  onJoinMeeting: (link: MeetingLink) => void
}

/**
 * Page d'accueil.
 * La création de réunion est réservée à l'organisateur (session protégée par la
 * clé `PHILDEV_HOST_KEY`) ; les invités rejoignent uniquement avec un lien.
 */
export function WelcomeScreen({ onJoinMeeting }: WelcomeScreenProps) {
  const [value, setValue] = useState('')
  // Nom de la réunion : pré-rempli, modifiable, jamais obligatoire.
  const [title, setTitle] = useState(DEFAULT_MEETING_TITLE)
  // Créneau du rendez-vous, saisi dès la création (heure locale).
  const [startValue, setStartValue] = useState(() => defaultStartInput())
  const [scheduleError, setScheduleError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hostDialogOpen, setHostDialogOpen] = useState(false)
  const [hostReady, setHostReady] = useState(() => readHostSession() !== null)
  const [apiAvailable, setApiAvailable] = useState<boolean | null>(null)
  /** Dernière réunion créée, proposée uniquement à l'organisateur connecté. */
  const [lastMeeting, setLastMeeting] = useState<LastMeeting | null>(null)

  const { start, busy, error: createError, clearError } = useCreateMeeting()

  useEffect(() => {
    let active = true
    void checkApiAvailability().then((available) => {
      if (active) setApiAvailable(available)
    })
    return () => {
      active = false
    }
  }, [])

  // Le raccourci n'apparaît qu'avec une session organisateur : le stockage est
  // propre au navigateur, un invité ne le voit jamais.
  useEffect(() => {
    if (hostReady) setLastMeeting(readLastMeeting())
  }, [hostReady])

  const handleCreate = () => {
    clearError()

    // La date et l'heure font partie de la création : elles seront reprises
    // telles quelles par l'invitation par e-mail.
    const startsAt = parseStartInput(startValue)
    if (!startsAt) {
      setScheduleError("Choisissez une date et une heure à venir, dans l'année.")
      return
    }
    setScheduleError(null)

    if (!hostReady) {
      setHostDialogOpen(true)
      return
    }
    void start({ title, startsAt })
  }

  const handleJoin = () => {
    const link = parseMeetingLink(value)

    if (!link) {
      setError(
        value.trim().length === 0
          ? 'Collez le lien d’invitation reçu pour rejoindre votre rendez-vous.'
          : "Ce lien n’est pas valide. Vérifiez que vous avez copié l’adresse complète reçue de l’organisateur.",
      )
      return
    }

    setError(null)
    onJoinMeeting(link)
  }

  return (
    <div className="stage-backdrop flex min-h-dvh flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-5 py-5 sm:px-8">
        <PhilDevLogo size="md" />

        <div className="flex flex-wrap items-center gap-2">
          {hostReady ? (
            <StatusPill
              tone="info"
              icon={<Crown aria-hidden="true" className="size-3.5 text-amber-300" />}
            >
              Session organisateur
            </StatusPill>
          ) : null}

          <Button variant="ghost" size="sm" onClick={() => setHostDialogOpen(true)}>
            <KeyRound aria-hidden="true" className="size-4" />
            Accès organisateur
          </Button>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-10 px-5 pb-12 sm:px-8 lg:flex-row lg:items-start lg:gap-14 lg:pt-6">
        <section className="flex flex-1 flex-col gap-6">
          <p className="text-sm font-medium tracking-[0.18em] text-accent-300 uppercase">
            Espace de rendez-vous PhilDEV
          </p>

          <h1 className="font-display text-4xl leading-[1.08] font-semibold tracking-tight text-white sm:text-5xl lg:text-6xl">
            Bienvenue sur votre
            <br />
            rendez-vous visio.
          </h1>

          <p className="max-w-xl text-base leading-relaxed text-slate-300">
            Cet espace vous permet de démarrer ou de rejoindre une réunion en toute simplicité.
            Aucune installation ni création de compte n’est nécessaire pour les invités.
          </p>

          <dl className="mt-2 grid gap-4 sm:grid-cols-3">
            {CAPABILITIES.map(({ icon: Icon, title, description }) => (
              <div key={title} className="surface-panel flex flex-col gap-2 rounded-2xl p-4">
                <Icon aria-hidden="true" className="size-5 text-accent-300" />
                <dt className="text-sm font-semibold text-white">{title}</dt>
                <dd className="text-xs leading-relaxed text-slate-400">{description}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section
          aria-labelledby="welcome-actions"
          className="surface-panel flex w-full flex-col gap-5 rounded-3xl p-6 shadow-2xl shadow-black/40 lg:w-[26rem] lg:shrink-0"
        >
          <div className="flex flex-col gap-1">
            <h2 id="welcome-actions" className="text-lg font-semibold text-white">
              Démarrer
            </h2>
            <p className="text-sm text-slate-400">
              Créez un rendez-vous, ou rejoignez une réunion avec le lien reçu.
            </p>
          </div>

          {apiAvailable === false ? (
            <Notice tone="warning" title="Service de réunion indisponible">
              Cette page ne peut pas créer ni rejoindre de réunion pour le moment. Ouvrez
              l’adresse habituelle du service pour accéder à votre rendez-vous.
            </Notice>
          ) : null}

          {createError ? (
            <Notice tone="danger" title="Création impossible">
              {createError}
            </Notice>
          ) : null}

          <TextField
            label="Nom de la réunion"
            placeholder={DEFAULT_MEETING_TITLE}
            value={title}
            maxLength={MAX_MEETING_TITLE_LENGTH}
            autoComplete="off"
            hint="Ce nom sera visible par les participants. Si vous laissez ce champ vide, un nom par défaut sera utilisé."
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => {
              // Un champ vide revient au nom par défaut : le nom transmis reste
              // toujours lisible.
              if (title.trim().length === 0) setTitle(DEFAULT_MEETING_TITLE)
            }}
          />

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

          <Button size="lg" onClick={handleCreate} disabled={busy} className="w-full">
            {busy ? (
              <Loader2 aria-hidden="true" className="size-5 animate-spin" />
            ) : (
              <Video aria-hidden="true" className="size-5" />
            )}
            {hostReady ? 'Créer une réunion' : 'Créer une réunion (organisateur)'}
          </Button>

          {/* Raccourci réservé à l'organisateur : rejoint la dernière réunion
              créée sans recoller son lien. */}
          {hostReady && lastMeeting ? (
            <Button
              size="lg"
              variant="secondary"
              className="w-full"
              onClick={() =>
                onJoinMeeting({
                  meetingId: lastMeeting.meetingId,
                  realtimeKitId: lastMeeting.realtimeKitId,
                })
              }
            >
              <span className="flex min-w-0 items-center gap-2">
                <Video aria-hidden="true" className="size-5 shrink-0" />
                <span className="truncate">Rejoindre « {lastMeeting.title} »</span>
              </span>
            </Button>
          ) : null}

          <div className="flex items-center gap-3 text-xs text-slate-500">
            <span className="h-px flex-1 bg-ink-700" />
            ou
            <span className="h-px flex-1 bg-ink-700" />
          </div>

          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              handleJoin()
            }}
          >
            <TextField
              label="Lien d’invitation"
              placeholder="https://…"
              value={value}
              error={error}
              autoComplete="off"
              spellCheck={false}
              hint="Collez le lien complet reçu de l'organisateur."
              onChange={(event) => {
                setValue(event.target.value)
                if (error) setError(null)
              }}
            />

            <Button type="submit" variant="secondary" size="lg" className="w-full">
              <Link2 aria-hidden="true" className="size-5" />
              Rejoindre
              <ArrowRight aria-hidden="true" className="size-4 opacity-70" />
            </Button>
          </form>

          <Notice tone="info" title="Invités" className="text-xs">
            <UserRound aria-hidden="true" className="mr-1.5 inline size-3.5 align-[-2px]" />
            Toute personne disposant du lien peut rejoindre la réunion. Aucun compte n’est
            nécessaire côté invité.
          </Notice>
        </section>
      </main>

      <footer className="mx-auto w-full max-w-6xl px-5 pb-8 text-xs text-slate-500 sm:px-8">
        <p>PhilDEV Visio — espace de rendez-vous</p>
      </footer>

      <HostAccessDialog
        key={hostDialogOpen ? 'open' : 'closed'}
        open={hostDialogOpen}
        onClose={() => setHostDialogOpen(false)}
        onSuccess={() => {
          setHostReady(true)
          setHostDialogOpen(false)
        }}
      />
    </div>
  )
}
