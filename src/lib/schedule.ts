/**
 * Date et heure d'un rendez-vous, saisies à la création.
 *
 * L'interface utilise un `<input type="datetime-local">`, qui travaille en heure
 * locale sans secondes ; le serveur, lui, ne reçoit que de l'ISO 8601 (UTC).
 */

/** Tolérance passée acceptée, alignée sur celle du Worker (une heure). */
const PAST_TOLERANCE_MS = 60 * 60 * 1000

/** Horizon maximal, aligné sur celui du Worker (un an). */
const HORIZON_MS = 366 * 24 * 60 * 60 * 1000

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** Valeur d'un `<input type="datetime-local">` : heure locale, sans secondes. */
export function toDateTimeInput(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Créneau proposé : dans une heure, arrondi aux cinq minutes suivantes. */
export function defaultStartInput(now = Date.now()): string {
  const date = new Date(now + 60 * 60_000)
  date.setSeconds(0, 0)
  date.setMinutes(Math.ceil(date.getMinutes() / 5) * 5)
  return toDateTimeInput(date)
}

/**
 * Convertit la saisie en ISO 8601, ou renvoie `null` si elle est inutilisable :
 * date illisible, trop ancienne ou au-delà d'un an.
 */
export function parseStartInput(value: string, now = Date.now()): string | null {
  const date = new Date(value)
  const timestamp = date.getTime()
  if (Number.isNaN(timestamp)) return null
  if (timestamp < now - PAST_TOLERANCE_MS) return null
  if (timestamp > now + HORIZON_MS) return null

  return date.toISOString()
}

/** Date lisible en français, pour rappeler le créneau dans le panneau d'envoi. */
export function formatStartLabel(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''

  return new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(date)
}
