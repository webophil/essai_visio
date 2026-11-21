/**
 * Dernière réunion créée par l'organisateur, mémorisée dans ce navigateur.
 *
 * Elle sert uniquement à proposer un raccourci « Rejoindre « … » » sur l'écran
 * d'accueil : le lien d'invitation reste la source de vérité, et aucune donnée
 * sensible n'est stockée (identifiant lisible, identifiant Cloudflare, titre).
 */

const STORAGE_KEY = 'phildev:last-meeting:v1'

export interface LastMeeting {
  /** Identifiant lisible (`rdv-xxxxxxx`). */
  meetingId: string
  /** Identifiant de réunion Cloudflare, transporté par `?r=`. */
  realtimeKitId: string
  /** Nom affiché de la réunion, tel que créé. */
  title: string
}

/** Stockage local, ou `null` hors navigateur (rendu serveur, navigation privée). */
function storage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** Dernière réunion mémorisée, ou `null` si elle est absente ou illisible. */
export function readLastMeeting(): LastMeeting | null {
  const store = storage()
  if (!store) return null

  try {
    const raw = store.getItem(STORAGE_KEY)
    if (!raw) return null

    const parsed = JSON.parse(raw) as Partial<LastMeeting>
    if (
      typeof parsed.meetingId !== 'string' ||
      typeof parsed.realtimeKitId !== 'string' ||
      typeof parsed.title !== 'string' ||
      parsed.meetingId.length === 0 ||
      parsed.realtimeKitId.length === 0
    ) {
      return null
    }

    return {
      meetingId: parsed.meetingId,
      realtimeKitId: parsed.realtimeKitId,
      title: parsed.title,
    }
  } catch {
    return null
  }
}

/** Mémorise la réunion qui vient d'être créée (échec de stockage sans effet). */
export function saveLastMeeting(meeting: LastMeeting): void {
  const store = storage()
  if (!store) return

  try {
    store.setItem(STORAGE_KEY, JSON.stringify(meeting))
  } catch {
    // Stockage plein ou interdit : le raccourci sera simplement absent.
  }
}
