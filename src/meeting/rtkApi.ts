/**
 * Accès à l'API du Worker PhilDEV Visio.
 *
 * Aucun jeton d'API Cloudflare ne transite par ce module : le navigateur ne
 * manipule que des jetons **participant** (délivrés à la demande) et, pour
 * l'organisateur, un jeton de session signé. Les erreurs sont traduites en
 * messages français sans jamais exposer la réponse brute du serveur.
 */

export type ParticipantRole = 'host' | 'guest'

export interface ParticipantCredential {
  token: string
  meetingId: string
  displayName: string
  presetName: string
  role: ParticipantRole
  /** Capacité de la réunion, confirmée par le serveur. */
  maxParticipants: number
}

export interface CreatedMeeting {
  meetingId: string
  title: string
  hostPreset: string
  maxParticipants: number
}

/** Nom d'une réunion existante (titre Cloudflare, lisible par les participants). */
export interface MeetingInfo {
  meetingId: string
  title: string
}

/** Bilan d'un envoi d'invitations : nombre parti, adresses refusées. */
export interface InvitationReport {
  sent: number
  failed: { email: string; code: string }[]
}

export interface HostSession {
  token: string
  expiresAt: number
}

export interface DiagnosticReport {
  apiTokenPresent: boolean
  hostKeyPresent: boolean
  accountId: string
  appId: string
  presetsExpected: { host: string; guest: string }
  presetsRead: string | null
  presetsAvailable: string[] | null
  maxParticipants: number
}

/** Erreur d'API normalisée (code stable + message affichable). */
export class MeetingApiError extends Error {
  readonly code: string
  readonly status: number

  constructor({ status, code, message }: { status: number; code: string; message: string }) {
    super(message)
    this.name = 'MeetingApiError'
    this.code = code
    this.status = status
  }

  /** Capacité de la réunion atteinte. */
  get isCapacityReached(): boolean {
    return this.code === 'meeting-full'
  }

  /** L'accès organisateur est requis (ou mal configuré). */
  get needsHostAccess(): boolean {
    return this.code === 'host-unauthorized' || this.code === 'host-key-invalid'
  }

  /** L'API n'est pas disponible (développement local sans Worker). */
  get isApiUnavailable(): boolean {
    return this.code === 'api-unavailable' || this.code === 'host-key-missing'
  }

  /** L'envoi d'e-mails n'est pas configuré côté serveur (secret absent). */
  get needsMailSetup(): boolean {
    return this.code === 'mail-not-configured'
  }
}

const GENERIC_MESSAGE =
  "Le service de réunion n'a pas répondu correctement. Réessayez dans quelques instants."

interface RequestOptions {
  method: 'GET' | 'POST'
  body?: Record<string, unknown>
  hostToken?: string | null
}

function parseFailure(status: number, payload: unknown): MeetingApiError {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null
  const code = typeof record?.error === 'string' ? record.error : `http-${status}`
  const message = typeof record?.message === 'string' ? record.message : GENERIC_MESSAGE

  return new MeetingApiError({ status, code, message })
}

async function callApi<T>(path: string, { method, body, hostToken }: RequestOptions): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  // Le jeton de session organisateur est un en-tête, jamais un paramètre
  // d'URL : il ne doit pas se retrouver dans un lien partagé ni dans un journal.
  if (hostToken) headers['X-PhilDEV-Host'] = hostToken

  let response: Response
  try {
    response = await fetch(path, {
      method,
      headers,
      cache: 'no-store',
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new MeetingApiError({
      status: 0,
      code: 'network',
      message: 'Serveur de réunion injoignable. Vérifiez votre connexion, puis réessayez.',
    })
  }

  const contentType = response.headers.get('Content-Type') ?? ''
  if (!contentType.includes('application/json')) {
    throw new MeetingApiError({
      status: response.status,
      code: 'api-unavailable',
      message:
        "Le service de réunion répond depuis la prévisualisation déployée uniquement. En développement local, testez la réunion depuis l'adresse de prévisualisation.",
    })
  }

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) throw parseFailure(response.status, payload)
  if (!payload || typeof payload !== 'object') {
    throw new MeetingApiError({ status: response.status, code: 'invalid-response', message: GENERIC_MESSAGE })
  }

  return payload as T
}

/** Le service de réunion est-il joignable ? (utilisé pour informer l'interface) */
export async function checkApiAvailability(): Promise<boolean> {
  try {
    await callApi<{ ok: boolean }>('/api/health', { method: 'GET' })
    return true
  } catch {
    return false
  }
}

/** Échange la clé organisateur contre une session signée. */
export function openHostSession(key: string): Promise<HostSession> {
  return callApi<HostSession>('/api/host/session', { method: 'POST', body: { key } })
}

/** Crée une réunion Cloudflare RealtimeKit (organisateur uniquement). */
export function createMeeting(options: {
  title: string
  displayName: string
  hostToken: string
}): Promise<CreatedMeeting> {
  return callApi<CreatedMeeting>('/api/meetings', {
    method: 'POST',
    hostToken: options.hostToken,
    body: { title: options.title, displayName: options.displayName },
  })
}

/**
 * Nom d'une réunion existante.
 * Le titre est stocké côté Cloudflare RealtimeKit : il est donc identique pour
 * tous les participants, sans base de données ni paramètre dans le lien.
 */
export function fetchMeetingInfo(meetingId: string): Promise<MeetingInfo> {
  return callApi<MeetingInfo>(`/api/meetings/${encodeURIComponent(meetingId)}`, { method: 'GET' })
}

/** Demande un jeton de participation (invité avec lien, ou organisateur). */
export function requestParticipantToken(options: {
  meetingId: string
  displayName: string
  guestId: string
  role: ParticipantRole
  hostToken?: string | null
}): Promise<ParticipantCredential> {
  return callApi<ParticipantCredential>('/api/rtk/token', {
    method: 'POST',
    hostToken: options.hostToken ?? null,
    body: {
      meetingId: options.meetingId,
      displayName: options.displayName,
      guestId: options.guestId,
      role: options.role,
    },
  })
}

/** État en lecture seule de la configuration RealtimeKit (organisateur). */
export function fetchDiagnostic(hostToken: string): Promise<DiagnosticReport> {
  return callApi<DiagnosticReport>('/api/rtk/diagnostic', { method: 'GET', hostToken })
}

/**
 * Envoie le lien du rendez-vous par e-mail, à chaque invité puis à
 * l'organisateur. Seules les données partent : le message est rédigé par le
 * Worker, avec le nom réel de la réunion.
 */
export function sendMeetingInvitations(options: {
  meetingId: string
  realtimeKitId: string
  startsAt: string
  guests: string[]
  hostEmail: string
  hostToken: string
}): Promise<InvitationReport> {
  return callApi<InvitationReport>(
    `/api/meetings/${encodeURIComponent(options.meetingId)}/invitations`,
    {
      method: 'POST',
      hostToken: options.hostToken,
      body: {
        realtimeKitId: options.realtimeKitId,
        startsAt: options.startsAt,
        guests: options.guests,
        hostEmail: options.hostEmail,
      },
    },
  )
}
