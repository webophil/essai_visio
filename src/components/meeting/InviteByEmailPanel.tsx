import { useState } from 'react'
import { ChevronDown, Loader2, Mail, Send, X } from 'lucide-react'

import { Button } from '../ui/Button'
import { Notice } from '../ui/Notice'
import { TextField } from '../ui/TextField'
import { readHostSession } from '../../meeting/hostSession'
import { MeetingApiError, sendMeetingInvitations } from '../../meeting/rtkApi'

/** Adresse acceptée : partie locale, arobase, domaine pointé. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i

/** Invités par envoi (le serveur plafonne l'ensemble à six adresses). */
const MAX_GUESTS = 5

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** Valeur d'un `<input type="datetime-local">` : heure locale, sans secondes. */
function toInputValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Créneau proposé : dans une heure, arrondi aux cinq minutes suivantes. */
function defaultStart(): string {
  const date = new Date(Date.now() + 60 * 60_000)
  date.setSeconds(0, 0)
  date.setMinutes(Math.ceil(date.getMinutes() / 5) * 5)
  return toInputValue(date)
}

/**
 * Adresses saisies, séparées par des retours à la ligne, des virgules ou des
 * points-virgules. Les doublons sont retirés ; ce qui ne ressemble pas à une
 * adresse est signalé plutôt que silencieusement ignoré.
 */
function parseRecipients(raw: string): { valid: string[]; invalid: string[] } {
  const tokens = [
    ...new Set(
      raw
        .split(/[\s,;]+/)
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  ]

  return {
    valid: tokens.filter((value) => EMAIL_PATTERN.test(value)),
    invalid: tokens.filter((value) => !EMAIL_PATTERN.test(value)),
  }
}

export interface InviteByEmailPanelProps {
  meetingId: string
  realtimeKitId: string
  meetingName: string
}

/**
 * Invitation par e-mail, depuis l'écran d'accès à la réunion.
 *
 * L'organisateur saisit les adresses, la date et l'heure du rendez-vous ; le
 * Worker envoie à chacune — et à lui-même — un message contenant le lien et
 * l'heure. Il peut ensuite fermer la page : la réunion RealtimeKit existe déjà,
 * et les invités n'ont besoin que du lien.
 *
 * Le message est rédigé côté serveur (nom réel de la réunion, heure de Paris) :
 * ce formulaire ne transmet que des adresses et un horodatage.
 */
export function InviteByEmailPanel({ meetingId, realtimeKitId, meetingName }: InviteByEmailPanelProps) {
  const [open, setOpen] = useState(false)
  const [guests, setGuests] = useState('')
  const [hostEmail, setHostEmail] = useState('')
  const [startsAt, setStartsAt] = useState(defaultStart)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const handleSend = async () => {
    const session = readHostSession()
    if (!session) {
      setError("Session organisateur absente ou expirée : reconnectez-vous, puis rouvrez cette page.")
      return
    }

    const { valid, invalid } = parseRecipients(guests)

    if (invalid.length > 0) {
      setError(
        `Adresse${invalid.length > 1 ? 's' : ''} invalide${invalid.length > 1 ? 's' : ''} : ${invalid.join(', ')}.`,
      )
      return
    }
    if (valid.length === 0) {
      setError('Indiquez au moins une adresse de participant.')
      return
    }
    if (valid.length > MAX_GUESTS) {
      setError(`Cinq adresses de participants au maximum par envoi.`)
      return
    }

    const normalizedHost = hostEmail.trim().toLowerCase()
    if (!EMAIL_PATTERN.test(normalizedHost)) {
      setError('Indiquez votre adresse e-mail pour recevoir le rappel du lien.')
      return
    }

    const when = new Date(startsAt)
    if (Number.isNaN(when.getTime())) {
      setError('Indiquez une date et une heure de rendez-vous.')
      return
    }
    if (when.getTime() < Date.now() - 60 * 60_000) {
      setError('Choisissez une date et une heure à venir.')
      return
    }

    setBusy(true)
    setError(null)
    setSuccess(null)

    try {
      const report = await sendMeetingInvitations({
        meetingId,
        realtimeKitId,
        startsAt: when.toISOString(),
        guests: valid,
        hostEmail: normalizedHost,
        hostToken: session.token,
      })

      const plural = report.sent > 1 ? 's' : ''
      const failures =
        report.failed.length > 0
          ? ` (${report.failed.length} adresse${report.failed.length > 1 ? 's' : ''} en échec)`
          : ''

      setSuccess(
        `${report.sent} invitation${plural} envoyée${plural}${failures}. Vous pouvez fermer cette page : le rendez-vous reste ouvert.`,
      )
    } catch (failure) {
      setError(
        failure instanceof MeetingApiError
          ? failure.message
          : "L'envoi des invitations a échoué. Réessayez dans quelques instants.",
      )
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <div className="flex flex-col gap-2 border-t border-ink-700 pt-4">
        <Button
          variant="secondary"
          className="w-full justify-between"
          onClick={() => setOpen(true)}
          aria-expanded={false}
        >
          <span className="flex items-center gap-2.5">
            <Mail aria-hidden="true" className="size-5" />
            Inviter par e-mail
          </span>
          <ChevronDown aria-hidden="true" className="size-4" />
        </Button>
        <p className="text-xs leading-relaxed text-slate-400">
          Envoyez le lien aux participants avec la date et l&apos;heure du rendez-vous : vous pouvez
          ensuite fermer cette page.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-ink-600 bg-ink-850/60 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="flex items-center gap-2 text-sm font-semibold text-white">
            <Mail aria-hidden="true" className="size-4 text-accent-300" />
            Inviter par e-mail
          </p>
          <p className="text-xs leading-relaxed text-slate-400">
            Chaque adresse reçoit « {meetingName} » avec le lien et l&apos;heure du rendez-vous.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Fermer"
          className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-ink-800 hover:text-white"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-slate-200">Participants</span>
        <textarea
          value={guests}
          onChange={(event) => setGuests(event.target.value)}
          rows={3}
          spellCheck={false}
          placeholder={'aurore@exemple.fr\nstagiaire@exemple.fr'}
          className="w-full resize-y rounded-xl border border-ink-600 bg-ink-850 px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-ink-300 focus:border-accent-500 focus:outline-none"
        />
        <span className="text-xs text-slate-400">Une adresse par ligne, cinq au maximum.</span>
      </label>

      <TextField
        label="Votre adresse (rappel)"
        type="email"
        autoComplete="email"
        placeholder="vous@phildev.online"
        value={hostEmail}
        onChange={(event) => setHostEmail(event.target.value)}
        hint="Vous recevez le même lien, avec l'heure du rendez-vous."
      />

      <TextField
        label="Rendez-vous"
        type="datetime-local"
        value={startsAt}
        onChange={(event) => setStartsAt(event.target.value)}
        hint="Heure locale ; le message l'indique en heure de Paris."
      />

      {error ? (
        <Notice tone="danger" title="Envoi impossible">
          {error}
        </Notice>
      ) : null}

      {success ? (
        <Notice tone="success" title="Invitations envoyées">
          {success}
        </Notice>
      ) : null}

      <Button onClick={() => void handleSend()} disabled={busy} className="w-full">
        {busy ? (
          <Loader2 aria-hidden="true" className="size-5 animate-spin" />
        ) : (
          <Send aria-hidden="true" className="size-5" />
        )}
        {busy ? 'Envoi…' : 'Envoyer les invitations'}
      </Button>
    </div>
  )
}
