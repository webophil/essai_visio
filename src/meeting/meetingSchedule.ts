/**
 * Créneau des réunions créées depuis ce navigateur.
 *
 * La date et l'heure sont saisies à la création, puis reprises telles quelles
 * par l'invitation par e-mail. Aucune donnée sensible : identifiant de réunion
 * et horodatage ISO uniquement.
 */

const STORAGE_KEY = 'phildev:meeting-schedules:v1'

/** Nombre de réunions mémorisées ; les plus anciennes sont oubliées. */
const MAX_ENTRIES = 12

function storage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function readStore(): Record<string, string> {
  const store = storage()
  if (!store) return {}

  try {
    const raw = store.getItem(STORAGE_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    const entries: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && !Number.isNaN(new Date(value).getTime())) {
        entries[key] = value
      }
    }
    return entries
  } catch {
    return {}
  }
}

/** Mémorise le créneau choisi à la création de la réunion. */
export function saveMeetingSchedule(meetingId: string, startsAt: string): void {
  const store = storage()
  if (!store) return
  if (meetingId.length === 0 || Number.isNaN(new Date(startsAt).getTime())) return

  try {
    const entries = readStore()
    delete entries[meetingId]
    entries[meetingId] = startsAt

    // Les clés sont réinsérées à la fin : la première est la plus ancienne.
    const keys = Object.keys(entries)
    for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) {
      delete entries[stale]
    }

    store.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // Stockage plein ou interdit : l'invitation refusera simplement l'envoi.
  }
}

/** Créneau mémorisé pour cette réunion, ou `null` sur un autre appareil. */
export function readMeetingSchedule(meetingId: string): string | null {
  const value = readStore()[meetingId]
  return typeof value === 'string' ? value : null
}
