import { useCallback, useState } from 'react'
import { KeyRound, Loader2, LogOut, ShieldCheck, Stethoscope, X } from 'lucide-react'

import { Button } from '../ui/Button'
import { Notice } from '../ui/Notice'
import { StatusPill } from '../ui/StatusPill'
import { TextField } from '../ui/TextField'
import { clearHostSession, readHostSession, saveHostSession } from '../../meeting/hostSession'
import { MeetingApiError, fetchDiagnostic, openHostSession } from '../../meeting/rtkApi'
import type { DiagnosticReport, PresetPermissionDetail } from '../../meeting/rtkApi'

export interface HostAccessDialogProps {
  open: boolean
  onClose: () => void
  /** Appelé après l'ouverture d'une session organisateur valide. */
  onSuccess: () => void
}

/**
 * Accès organisateur.
 *
 * La clé n'est envoyée qu'une seule fois, au serveur, qui la compare au secret
 * `PHILDEV_HOST_KEY` et renvoie une session **signée** avec sa date
 * d'expiration. Le navigateur ne conserve donc jamais la clé : uniquement cette
 * session, qui peut être fermée à tout moment.
 *
 * Le parent remonte le composant à chaque ouverture (`key`) : la saisie et les
 * messages d'erreur repartent donc d'un état vierge, sans effet de bord.
 */
export function HostAccessDialog({ open, onClose, onSuccess }: HostAccessDialogProps) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasSession, setHasSession] = useState(() => readHostSession() !== null)
  const [diagnostic, setDiagnostic] = useState<DiagnosticReport | null>(null)
  const [diagnosticBusy, setDiagnosticBusy] = useState(false)

  const handleSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault()
      if (key.trim().length === 0) {
        setError('Saisissez la clé organisateur.')
        return
      }

      setBusy(true)
      setError(null)

      try {
        const session = await openHostSession(key.trim())
        saveHostSession({ token: session.token, expiresAt: session.expiresAt })
        setKey('')
        setHasSession(true)
        onSuccess()
      } catch (failure) {
        setError(
          failure instanceof MeetingApiError
            ? failure.message
            : "L'ouverture de la session organisateur a échoué.",
        )
      } finally {
        setBusy(false)
      }
    },
    [key, onSuccess],
  )

  const handleSignOut = useCallback(() => {
    clearHostSession()
    setHasSession(false)
    setDiagnostic(null)
  }, [])

  const runDiagnostic = useCallback(async () => {
    const session = readHostSession()
    if (!session) {
      setError("Ouvrez d'abord une session organisateur.")
      return
    }

    setDiagnosticBusy(true)
    try {
      setDiagnostic(await fetchDiagnostic(session.token))
      setError(null)
    } catch (failure) {
      setError(failure instanceof MeetingApiError ? failure.message : 'Diagnostic indisponible.')
    } finally {
      setDiagnosticBusy(false)
    }
  }, [])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-ink-950/80 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="host-dialog-title"
        className="surface-panel flex w-full max-w-lg flex-col gap-5 rounded-2xl p-6 shadow-2xl shadow-black/50"
      >
        <header className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h2
              id="host-dialog-title"
              className="flex items-center gap-2 text-lg font-semibold text-white"
            >
              <KeyRound aria-hidden="true" className="size-4 text-accent-300" />
              Accès organisateur
            </h2>
            <p className="text-sm text-slate-400">
              Identifiez-vous pour créer et organiser vos réunions.
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer"
            className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-ink-800 hover:text-white"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </header>

        {hasSession ? (
          <Notice
            tone="success"
            title="Session active"
            action={
              <Button variant="secondary" size="sm" onClick={handleSignOut}>
                <LogOut aria-hidden="true" className="size-4" />
                Fermer la session
              </Button>
            }
          >
            Cet appareil peut créer des réunions et entrer en tant qu’organisateur jusqu’à
            l’expiration de la session.
          </Notice>
        ) : null}

        {error ? (
          <Notice tone="danger" title="Accès refusé">
            {error}
          </Notice>
        ) : null}

        <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
          <TextField
            label="Clé organisateur"
            type="password"
            autoComplete="current-password"
            spellCheck={false}
            placeholder="••••••••••••"
            value={key}
            onChange={(event) => {
              setKey(event.target.value)
              if (error) setError(null)
            }}
          />

          <Button type="submit" size="lg" disabled={busy} className="w-full">
            {busy ? (
              <Loader2 aria-hidden="true" className="size-5 animate-spin" />
            ) : (
              <ShieldCheck aria-hidden="true" className="size-5" />
            )}
            Ouvrir la session organisateur
          </Button>
        </form>

        <div className="flex flex-col gap-3 border-t border-ink-700 pt-4">
          <div className="flex items-center justify-between gap-3">
            <StatusPill tone="neutral" icon={<Stethoscope aria-hidden="true" className="size-3.5" />}>
              Vérification de connexion
            </StatusPill>
            <Button variant="ghost" size="sm" disabled={diagnosticBusy} onClick={() => void runDiagnostic()}>
              {diagnosticBusy ? (
                <Loader2 aria-hidden="true" className="size-4 animate-spin" />
              ) : (
                <Stethoscope aria-hidden="true" className="size-4" />
              )}
              Vérifier
            </Button>
          </div>

          {diagnostic ? (
            <dl className="flex flex-col gap-1 rounded-xl bg-ink-850 p-3 text-xs text-slate-300">
              <DiagnosticRow label="Jeton d’API visible par le Worker" value={diagnostic.apiTokenPresent ? 'oui' : 'non'} />
              <DiagnosticRow label="Clé organisateur enregistrée" value={diagnostic.hostKeyPresent ? 'oui' : 'non'} />
              <DiagnosticRow label="Compte Cloudflare utilisé" value={diagnostic.accountId} />
              <DiagnosticRow label="Application RealtimeKit" value={diagnostic.appId} />
              <DiagnosticRow label="Lecture des presets" value={diagnostic.presetsRead ?? 'non testée'} />
              <DiagnosticRow
                label="Presets disponibles"
                value={
                  diagnostic.presetsAvailable?.length
                    ? diagnostic.presetsAvailable.join(', ')
                    : 'aucun renvoyé'
                }
              />
              <DiagnosticRow
                label="Chat organisateur"
                value={presetChatLabel(diagnostic.presetPermissions?.host)}
              />
              <DiagnosticRow
                label="Chat participant"
                value={presetChatLabel(diagnostic.presetPermissions?.guest)}
              />
            </dl>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/**
 * Résumé lisible des permissions de chat d'un preset.
 * Seuls les drapeaux demandés à Cloudflare sont affichés, sans identifiant.
 */
function presetChatLabel(preset: PresetPermissionDetail | null | undefined): string {
  if (!preset) return 'preset introuvable'

  const flag = (value: boolean) => (value ? 'oui' : 'non')
  return `texte ${flag(preset.chat.public.text)} · fichiers ${flag(preset.chat.public.files)}`
}

function DiagnosticRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-slate-400">{label}</dt>
      <dd className="max-w-[60%] truncate text-right font-mono text-slate-200" title={value}>
        {value}
      </dd>
    </div>
  )
}
