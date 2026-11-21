import { useState } from 'react'
import { ChevronDown, Loader2, MessageSquare, Send, X } from 'lucide-react'

import { Button } from '../ui/Button'
import { Notice } from '../ui/Notice'
import { TextField } from '../ui/TextField'
import { readHostSession } from '../../meeting/hostSession'
import { MeetingApiError, sendMeetingSmsReminders } from '../../meeting/rtkApi'
import { buildSmsPreview, normalizePhone, parsePhoneList } from '../../lib/sms'

/** Cinq numéros au maximum, organisateur compris. */
const MAX_PHONES = 5

export interface SmsReminderPanelProps {
  meetingId: string
  realtimeKitId: string
  meetingName: string
  /** Créneau saisi à la création ; `null` s'il n'est pas connu de ce navigateur. */
  startsAt: string | null
}

/**
 * Rappel mémoire par SMS, depuis l'écran d'accès à la réunion.
 *
 * Le SMS ne contient **aucun lien** : il rappelle le nom et l'heure, et renvoie
 * vers l'e-mail d'invitation. Le message est rédigé par le Worker ; ce panneau
 * ne transmet que des numéros et l'horodatage, et affiche exactement le texte
 * qui partira — un seul segment par destinataire.
 */
export function SmsReminderPanel({
  meetingId,
  realtimeKitId,
  meetingName,
  startsAt,
}: SmsReminderPanelProps) {
  const [open, setOpen] = useState(false)
  const [phones, setPhones] = useState('')
  const [hostPhone, setHostPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const preview = startsAt ? buildSmsPreview(meetingName, startsAt) : null

  const handleSend = async () => {
    const session = readHostSession()
    if (!session) {
      setError("Session organisateur absente ou expirée : reconnectez-vous, puis rouvrez cette page.")
      return
    }

    const { valid, invalid } = parsePhoneList(phones)
    if (invalid.length > 0) {
      setError(
        `Numéro${invalid.length > 1 ? 's' : ''} invalide${invalid.length > 1 ? 's' : ''} : ${invalid.join(', ')}. Utilisez un mobile français (06… ou +33 6…).`,
      )
      return
    }
    if (valid.length === 0) {
      setError('Indiquez au moins un numéro de téléphone.')
      return
    }

    // Rappel facultatif : vide = aucun SMS à l'organisateur ; un numéro saisi
    // mais invalide est signalé plutôt que silencieusement ignoré.
    const trimmedHost = hostPhone.trim()
    const normalizedHost = trimmedHost.length > 0 ? normalizePhone(trimmedHost) : null
    if (trimmedHost.length > 0 && !normalizedHost) {
      setError("Le numéro de rappel n'est pas valide. Corrigez-le ou laissez le champ vide.")
      return
    }

    const recipients = [...new Set([...valid, ...(normalizedHost ? [normalizedHost] : [])])]
    if (recipients.length > MAX_PHONES) {
      setError(`Cinq numéros au maximum par envoi, organisateur compris.`)
      return
    }

    if (!startsAt || !preview) {
      setError(
        "La date de cette réunion n'est pas connue de ce navigateur. Recréez la réunion depuis l'accueil pour envoyer un rappel.",
      )
      return
    }

    setBusy(true)
    setError(null)
    setSuccess(null)

    try {
      const report = await sendMeetingSmsReminders({
        meetingId,
        realtimeKitId,
        startsAt,
        phones: valid,
        hostPhone: normalizedHost ?? undefined,
        hostToken: session.token,
      })

      const plural = report.sent > 1 ? 's' : ''
      const failures =
        report.failed.length > 0
          ? ` (${report.failed.length} numéro${report.failed.length > 1 ? 's' : ''} en échec)`
          : ''

      setSuccess(
        `${report.sent} SMS${plural} envoyé${plural}${failures}, ${report.segments} segment par destinataire. Le lien reste dans l'e-mail d'invitation.`,
      )
    } catch (failure) {
      setError(
        failure instanceof MeetingApiError
          ? failure.message
          : "L'envoi des SMS a échoué. Réessayez dans quelques instants.",
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
            <MessageSquare aria-hidden="true" className="size-5" />
            Rappeler par SMS
          </span>
          <ChevronDown aria-hidden="true" className="size-4" />
        </Button>
        <p className="text-xs leading-relaxed text-slate-400">
          Un SMS court, sans lien, pour ceux qui ont déjà reçu l&apos;invitation par e-mail.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-ink-600 bg-ink-850/60 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="flex items-center gap-2 text-sm font-semibold text-white">
            <MessageSquare aria-hidden="true" className="size-4 text-accent-300" />
            Rappeler par SMS
          </p>
          <p className="text-xs leading-relaxed text-slate-400">
            Rappel mémoire uniquement : le message ne contient aucun lien.
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
        <span className="text-sm font-medium text-slate-200">Numéros de téléphone</span>
        <textarea
          value={phones}
          onChange={(event) => setPhones(event.target.value)}
          rows={3}
          spellCheck={false}
          placeholder={'06 12 34 56 78\n07 98 76 54 32'}
          className="w-full resize-y rounded-xl border border-ink-600 bg-ink-850 px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-ink-300 focus:border-accent-500 focus:outline-none"
        />
        <span className="text-xs text-slate-400">
          Un numéro par ligne, cinq au maximum (organisateur compris).
        </span>
      </label>

      <TextField
        label="Votre numéro (rappel)"
        type="tel"
        autoComplete="tel"
        placeholder="06 12 34 56 78"
        value={hostPhone}
        onChange={(event) => setHostPhone(event.target.value)}
        hint="Facultatif : laissez vide pour ne pas recevoir de SMS. Sinon, vous recevez le même rappel."
      />

      {/* Le créneau vient de la création, comme pour l'e-mail. */}
      {preview ? (
        <div className="flex flex-col gap-1 rounded-xl border border-ink-600 bg-ink-850 px-3.5 py-2.5">
          <span className="text-sm font-medium text-slate-200">Aperçu du SMS</span>
          <span className="text-sm leading-relaxed text-slate-300">{preview.text}</span>
          <span className="text-xs text-slate-400">
            {preview.segments === 1
              ? '1 SMS par destinataire, sans lien : le lien reste dans l’e-mail.'
              : `${preview.segments} SMS par destinataire, sans lien : le lien reste dans l’e-mail.`}
          </span>
        </div>
      ) : (
        <p className="text-xs text-slate-400">Date non enregistrée sur cet appareil.</p>
      )}

      {error ? (
        <Notice tone="danger" title="Envoi impossible">
          {error}
        </Notice>
      ) : null}

      {success ? (
        <Notice tone="success" title="Rappels envoyés">
          {success}
        </Notice>
      ) : null}

      <Button onClick={() => void handleSend()} disabled={busy || !preview} className="w-full">
        {busy ? (
          <Loader2 aria-hidden="true" className="size-5 animate-spin" />
        ) : (
          <Send aria-hidden="true" className="size-5" />
        )}
        {busy ? 'Envoi…' : 'Envoyer les rappels SMS'}
      </Button>
    </div>
  )
}
