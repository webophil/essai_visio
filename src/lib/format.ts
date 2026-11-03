import { MEETING_LINK_PARAM, MEETING_PATH_PREFIX, isRealtimeKitId, parseMeetingInput } from './ids'

/** Chemin interne d'une réunion, ex. `/rdv-aurore`. */
export function meetingPath(meetingId: string): string {
  return `${MEETING_PATH_PREFIX}${meetingId}`
}

/**
 * URL publique complète à partager avec un participant.
 * Elle porte l'identifiant de réunion Cloudflare (`?r=`) : c'est l'invitation
 * elle-même. Aucun jeton de participation n'y figure.
 */
export function buildInvitationUrl(meetingId: string, realtimeKitId: string, origin?: string): string {
  const base = (origin ?? window.location.origin).replace(/\/+$/, '')
  const link = `${base}${meetingPath(meetingId)}?${MEETING_LINK_PARAM}=${encodeURIComponent(realtimeKitId)}`
  return link
}

export interface MeetingLink {
  meetingId: string
  /** Identifiant de réunion Cloudflare, `null` si le lien ne le porte pas. */
  realtimeKitId: string | null
}

/**
 * Analyse une saisie utilisateur : identifiant seul (`aurore`), chemin interne
 * (`/rdv-aurore`) ou lien d'invitation complet, paramètre `?r=` compris.
 */
export function parseMeetingLink(input: string): MeetingLink | null {
  const raw = input.trim()
  if (!raw) return null

  const meetingId = parseMeetingInput(raw)
  if (!meetingId) return null

  let realtimeKitId: string | null = null
  const queryIndex = raw.indexOf('?')

  if (queryIndex >= 0) {
    try {
      const value = new URLSearchParams(raw.slice(queryIndex + 1)).get(MEETING_LINK_PARAM)
      if (isRealtimeKitId(value)) realtimeKitId = value.trim()
    } catch {
      realtimeKitId = null
    }
  }

  return { meetingId, realtimeKitId }
}

/**
 * URL du rendez-vous sans identifiant Cloudflare : conservée pour l'affichage
 * interne (barre d'adresse, titres) et pour les liens déjà partagés en Phase 1.
 */
export function buildMeetingUrl(meetingId: string, origin?: string): string {
  const base = (origin ?? window.location.origin).replace(/\/+$/, '')
  return `${base}${meetingPath(meetingId)}`
}

/** Durée de réunion lisible : `04:12` ou `01:04:12`. */
export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const pad = (value: number) => String(value).padStart(2, '0')

  return hours > 0
    ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`
}

/**
 * Heure d'envoi d'un message, au format `14:07` (heure locale).
 * Les messages d'une réunion vivent quelques minutes : l'heure seule suffit,
 * et reste lisible sur mobile.
 */
export function formatClockTime(milliseconds: number): string {
  const date = new Date(milliseconds)
  if (Number.isNaN(date.getTime())) return '--:--'

  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Accord simple pour les compteurs (« 1 participant », « 2 participants »). */
export function pluralize(count: number, singular: string, plural: string): string {
  return count > 1 ? plural : singular
}
