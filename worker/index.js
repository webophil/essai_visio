/**
 * Worker PhilDEV Visio — Phase 2.
 *
 * Deux responsabilités, dans cet ordre :
 *
 * 1. **API applicative** (`/api/...`) : création de réunion, délivrance des
 *    jetons de participation RealtimeKit, session organisateur. C'est le seul
 *    endroit où le jeton d'API Cloudflare est utilisé ; il n'est jamais renvoyé,
 *    jamais journalisé, jamais exposé au navigateur. Toutes les réponses
 *    sensibles sont `Cache-Control: no-store`.
 *
 * 2. **Service de l'application** : l'artefact `dist/` via le binding `ASSETS`,
 *    avec le repli SPA d'origine — strictement réservé aux navigations.
 *
 * Le repli est volontairement restreint aux **navigations** : une ressource
 * absente (JavaScript, CSS, image, police, source map) doit conserver son
 * statut 404, sinon une erreur de livraison est masquée par une page HTML 200.
 *
 * Une requête est considérée comme une navigation d'application si :
 *   1. la méthode est GET ou HEAD ;
 *   2. le dernier segment du chemin ne ressemble pas à un fichier (`/assets/x.js`) ;
 *   3. le client annonce une navigation — `Sec-Fetch-Mode: navigate`, signal
 *      envoyé par tous les navigateurs modernes pour une navigation, ou, en
 *      l'absence de ce signal, un en-tête `Accept` contenant `text/html`.
 *
 * Les chargements de ressources ne remplissent jamais ces conditions :
 * `<script src>` et `fetch()` annoncent un type générique (en-tête `Accept` réduit
 * à l'étoile), `<link rel=stylesheet>` annonce `text/css`, une `<img>` annonce
 * `image/...` — aucun ne demande `text/html`, et `Sec-Fetch-Mode` y vaut
 * `script`, `cors`, `style`, `image`… jamais `navigate`.
 */

import { HOST_SESSION_TTL_MS, createHostSession, hasHostSecret, verifyHostKey, verifyHostSession } from './hostAuth.js'
import { MailError, buildInvitation, hasMailer, sendMail } from './mailer.js'
import { clientKey, createRateLimiter } from './rateLimit.js'
import { applySecurityHeaders } from './securityHeaders.js'
import {
  HOST_CUSTOM_ID,
  RealtimeKitError,
  addParticipant,
  countDistinctParticipants,
  createMeeting,
  effectiveConfig,
  getMeeting,
  hasApiToken,
  hasParticipant,
  isUuid,
  listParticipants,
  listPresets,
  presets,
} from './realtimekit.js'
import { APP_VERSION, BUILD_COMMIT, BUILD_COMMIT_DATE } from './version.js'

/**
 * Journalisation minimale des échecs côté serveur.
 *
 * Le Worker n'a pas d'autre observabilité : sans cette trace, une erreur
 * RealtimeKit en production ne laisse aucune trace exploitable. Seuls le
 * statut, le code et le nom de l'erreur sont écrits — jamais le jeton d'API,
 * jamais la clé organisateur, jamais un en-tête ni un corps amont.
 */
function reportFailure(scope, error) {
  const detail =
    error instanceof RealtimeKitError
      ? { status: error.status, code: error.code }
      : { name: error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 200) }

  console.error('[phildev-visio] échec', scope, detail)
}

/** Méthodes pour lesquelles un repli vers `index.html` a un sens. */
const FALLBACK_METHODS = new Set(['GET', 'HEAD'])

/** Dernier segment de chemin ressemblant à un fichier (`index-abc123.js`). */
const FILE_LIKE_SEGMENT = /\.[a-z0-9]+$/i

/**
 * Vrai si la requête est une navigation de l'application (et non la demande
 * d'une ressource précise).
 */
function isAppNavigation(request) {
  if (!FALLBACK_METHODS.has(request.method)) return false

  const pathname = new URL(request.url).pathname
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1)
  if (FILE_LIKE_SEGMENT.test(lastSegment)) return false

  const fetchMode = request.headers.get('Sec-Fetch-Mode')
  if (fetchMode !== null) return fetchMode === 'navigate'

  // Clients sans `Sec-Fetch-Mode` (curl, navigateurs anciens) : on se rabat sur
  // la négociation de contenu. Un `Accept` absent vaut `*/*` côté HTTP.
  return (request.headers.get('Accept') ?? '').includes('text/html')
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * Nombre maximum de participants simultanés dans une réunion.
 * L'organisateur occupe un emplacement : la limite porte sur les personnes,
 * pas sur les invités.
 */
const MAX_PARTICIPANTS = 5

const MIN_DISPLAY_NAME = 2
const MAX_DISPLAY_NAME = 60
/** Longueur maximale du nom de réunion (identique à `MAX_MEETING_TITLE_LENGTH` côté client). */
const MAX_TITLE_LENGTH = 80
/** Nom utilisé quand l'organisateur n'en saisit aucun. */
const DEFAULT_MEETING_TITLE = 'Réunion PhilDEV'
const MAX_BODY_BYTES = 4096

/** Six adresses au maximum par envoi : quatre invités, l'organisateur, une marge. */
const MAX_INVITATION_RECIPIENTS = 6
/** Rendez-vous accepté : jusqu'à une heure de retard, et un an d'avance. */
const APPOINTMENT_PAST_TOLERANCE_MS = 60 * 60_000
const APPOINTMENT_HORIZON_MS = 365 * 24 * 60 * 60_000
/** Contrôle de forme d'une adresse, volontairement simple. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i
/** Identifiant lisible d'un rendez-vous, tel qu'il apparaît dans le lien. */
const MEETING_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,57}[a-z0-9])?$/

/** Limites par adresse cliente : freinent l'abus sans stockage partagé. */
const hostLoginLimiter = createRateLimiter({ limit: 6, windowMs: 5 * 60_000 })
const meetingCreationLimiter = createRateLimiter({ limit: 10, windowMs: 5 * 60_000 })
const tokenLimiter = createRateLimiter({ limit: 15, windowMs: 5 * 60_000 })
const meetingInfoLimiter = createRateLimiter({ limit: 30, windowMs: 5 * 60_000 })
/** Un envoi d'invitations groupe plusieurs messages : plafond volontairement serré. */
const invitationLimiter = createRateLimiter({ limit: 6, windowMs: 10 * 60_000 })

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  })
}

/** Refus normalisé : un code stable pour le client, un message en français. */
function failure(status, error, message, headers = {}) {
  return json({ error, message }, status, headers)
}

/**
 * Traduit une erreur RealtimeKit en réponse HTTP **sans divulgation** : le
 * statut amont et le message brut ne sont jamais transmis au navigateur.
 */
function realtimeKitFailure(error) {
  reportFailure('realtimekit', error)

  if (!(error instanceof RealtimeKitError)) {
    return failure(502, 'realtimekit-error', "Le service de visioconférence a renvoyé une réponse inattendue.")
  }

  if (error.status === 404) {
    return failure(404, 'meeting-not-found', "Cette réunion n'existe plus côté Cloudflare RealtimeKit.")
  }
  if (error.status === 401 || error.status === 403) {
    return failure(
      503,
      'realtimekit-forbidden',
      "Le jeton d'API Cloudflare n'autorise pas la gestion RealtimeKit pour cette application. Vérifiez la portée du jeton (Realtime Admin) et l'identifiant de compte.",
    )
  }
  if (error.status === 429) {
    return failure(429, 'realtimekit-rate-limited', 'Trop de demandes envoyées à Cloudflare en peu de temps. Réessayez dans une minute.')
  }
  if (error.status >= 500 || error.status === 0) {
    return failure(503, 'realtimekit-unavailable', 'Le service de visioconférence est momentanément injoignable. Réessayez dans quelques instants.')
  }

  return failure(502, 'realtimekit-rejected', "Cloudflare RealtimeKit a refusé la demande (réunion, preset ou participant invalide).")
}

async function readJsonBody(request) {
  const declared = Number(request.headers.get('Content-Length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null

  let text
  try {
    text = await request.text()
  } catch {
    return null
  }

  if (text.length > MAX_BODY_BYTES) return null

  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** Le porteur de la requête est-il un organisateur authentifié ? */
async function isHostRequest(request, env) {
  return verifyHostSession(env, request.headers.get('X-PhilDEV-Host') ?? '')
}

function normalizeDisplayName(value) {
  if (typeof value !== 'string') return null
  const name = value.trim().replace(/\s+/g, ' ')
  if (name.length < MIN_DISPLAY_NAME || name.length > MAX_DISPLAY_NAME) return null
  return name
}

function normalizeTitle(value, fallback) {
  if (typeof value !== 'string') return fallback
  const title = value.trim().replace(/\s+/g, ' ').slice(0, MAX_TITLE_LENGTH)
  return title.length > 0 ? title : fallback
}

/** Adresse e-mail normalisée, ou `null` si elle n'a pas la forme attendue. */
function normalizeEmail(value) {
  if (typeof value !== 'string') return null
  const email = value.trim().toLowerCase()
  return email.length <= 254 && EMAIL_PATTERN.test(email) ? email : null
}

/**
 * Date de rendez-vous : ISO 8601 reçu du navigateur (donc en UTC), bornée à un
 * passé proche et à un an d'avance pour éviter les dates aberrantes.
 */
function normalizeStartsAt(value, now = Date.now()) {
  if (typeof value !== 'string') return null

  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return null
  if (timestamp < now - APPOINTMENT_PAST_TOLERANCE_MS) return null
  if (timestamp > now + APPOINTMENT_HORIZON_MS) return null

  return new Date(timestamp).toISOString()
}

/** Identifiant lisible d'un rendez-vous, normalisé en minuscules. */
function normalizeMeetingId(value) {
  const id = String(value ?? '').trim().toLowerCase()
  return MEETING_ID_PATTERN.test(id) ? id : null
}

/** Limite de débit : renvoie une réponse de refus, ou `null` si la demande passe. */
function enforceRateLimit(request, limiter, scope) {
  const verdict = limiter.check(clientKey(request, scope))
  if (verdict.allowed) return null

  return failure(429, 'rate-limited', 'Trop de demandes depuis cette adresse. Patientez une minute avant de réessayer.', {
    'Retry-After': String(verdict.retryAfter),
  })
}

/** `POST /api/host/session` — échange la clé organisateur contre une session signée. */
async function handleHostSession(request, env) {
  const limited = enforceRateLimit(request, hostLoginLimiter, 'host-session')
  if (limited) return limited

  if (!hasHostSecret(env)) {
    return failure(
      503,
      'host-key-missing',
      "Le secret PHILDEV_HOST_KEY n'est pas encore enregistré dans FreeBuff Sites (onglet Secrets). L'accès organisateur est donc désactivé.",
    )
  }

  const body = await readJsonBody(request)
  if (!body) return failure(400, 'body-invalid', 'Requête illisible.')

  if (!verifyHostKey(env, body.key)) {
    return failure(401, 'host-key-invalid', 'Clé organisateur incorrecte.')
  }

  const session = await createHostSession(env)

  return json({ token: session.token, expiresAt: session.expiresAt, ttlMs: HOST_SESSION_TTL_MS })
}

/** `POST /api/meetings` — crée une réunion Cloudflare et réserve l'emplacement hôte. */
async function handleCreateMeeting(request, env) {
  if (!(await isHostRequest(request, env))) {
    return failure(401, 'host-unauthorized', "Seul l'organisateur authentifié peut créer une réunion.")
  }

  const limited = enforceRateLimit(request, meetingCreationLimiter, 'meeting-create')
  if (limited) return limited

  const body = await readJsonBody(request)
  if (!body) return failure(400, 'body-invalid', 'Requête illisible.')

  const title = normalizeTitle(body.title, DEFAULT_MEETING_TITLE)
  const hostName = normalizeDisplayName(body.displayName) ?? 'Organisateur'
  const { host: hostPreset } = presets(env)

  try {
    const meeting = await createMeeting(env, { title })

    // L'emplacement de l'organisateur est réservé dès la création : la limite de
    // cinq personnes est ainsi atteignable sans jamais bloquer l'hôte, et
    // l'existence du preset « hôte » est vérifiée immédiatement.
    await addParticipant(env, meeting.id, {
      name: hostName,
      presetName: hostPreset,
      customParticipantId: HOST_CUSTOM_ID,
    })

    return json({
      meetingId: meeting.id,
      title: meeting.title,
      hostPreset,
      maxParticipants: MAX_PARTICIPANTS,
    })
  } catch (error) {
    return realtimeKitFailure(error)
  }
}

/** `POST /api/rtk/token` — délivre un jeton de participation (hôte ou invité). */
async function handleParticipantToken(request, env) {
  const body = await readJsonBody(request)
  if (!body) return failure(400, 'body-invalid', 'Requête illisible.')

  const meetingId = typeof body.meetingId === 'string' ? body.meetingId.trim() : ''
  if (!isUuid(meetingId)) {
    return failure(400, 'meeting-invalid', "L'identifiant de réunion Cloudflare est absent ou invalide.")
  }

  const displayName = normalizeDisplayName(body.displayName)
  if (!displayName) {
    return failure(400, 'name-invalid', `Indiquez un nom affiché de ${MIN_DISPLAY_NAME} à ${MAX_DISPLAY_NAME} caractères.`)
  }

  const role = body.role === 'host' ? 'host' : 'guest'
  const { host: hostPreset, guest: guestPreset } = presets(env)

  if (role === 'host') {
    if (!(await isHostRequest(request, env))) {
      return failure(401, 'host-unauthorized', "Session organisateur absente ou expirée : rejoignez en tant qu'invité ou reconnectez-vous.")
    }

    const limited = enforceRateLimit(request, tokenLimiter, 'token-host')
    if (limited) return limited

    try {
      const participant = await addParticipant(env, meetingId, {
        name: displayName,
        presetName: hostPreset,
        customParticipantId: HOST_CUSTOM_ID,
      })

      return json({
        token: participant.token,
        meetingId,
        displayName: participant.name,
        presetName: participant.presetName,
        role,
        maxParticipants: MAX_PARTICIPANTS,
      })
    } catch (error) {
      return realtimeKitFailure(error)
    }
  }

  // Invité : lien d'invitation valide, aucune session requise, aucun compte.
  const guestId = typeof body.guestId === 'string' ? body.guestId.trim() : ''
  if (!isUuid(guestId)) {
    return failure(400, 'guest-invalid', "L'identifiant d'invité est absent ou invalide.")
  }

  const limited = enforceRateLimit(request, tokenLimiter, 'token-guest')
  if (limited) return limited

  try {
    // Contrôle de capacité côté serveur : l'emplacement est compté sur les
    // identifiants participants distincts, donc une reconnexion ne consomme pas
    // de place supplémentaire.
    const rows = await listParticipants(env, meetingId)
    const alreadyAdmitted = hasParticipant(rows, guestId)

    if (!alreadyAdmitted && countDistinctParticipants(rows) >= MAX_PARTICIPANTS) {
      return failure(
        409,
        'meeting-full',
        `Cette réunion a atteint sa capacité maximale de ${MAX_PARTICIPANTS} participants. Demandez à l'organisateur de libérer un accès.`,
      )
    }

    const participant = await addParticipant(env, meetingId, {
      name: displayName,
      presetName: guestPreset,
      customParticipantId: guestId,
    })

    return json({
      token: participant.token,
      meetingId,
      displayName: participant.name,
      presetName: participant.presetName,
      role,
      maxParticipants: MAX_PARTICIPANTS,
    })
  } catch (error) {
    return realtimeKitFailure(error)
  }
}

/**
 * `POST /api/meetings/:id/invitations` — envoie le lien du rendez-vous par
 * e-mail, à chaque invité puis à l'organisateur.
 *
 * Réservé à l'organisateur : le message part d'un domaine qui nous appartient,
 * il ne doit donc pas pouvoir servir de relais d'envoi. Le sujet et le corps
 * sont rédigés **côté serveur**, à partir du nom réel de la réunion relu chez
 * RealtimeKit : le navigateur ne fournit que des adresses et une date.
 *
 * Un message par destinataire : les invités ne voient pas les adresses des
 * autres, et un refus isolé n'annule pas les envois déjà faits.
 */
async function handleMeetingInvitations(request, env, rawMeetingId) {
  if (!(await isHostRequest(request, env))) {
    return failure(401, 'host-unauthorized', "Seul l'organisateur authentifié peut envoyer des invitations.")
  }

  if (!hasMailer(env)) {
    return failure(
      503,
      'mail-not-configured',
      "L'envoi d'invitations n'est pas encore configuré : le secret RESEND_API_KEY doit être enregistré dans FreeBuff Sites (onglet Secrets), et le domaine d'envoi vérifié chez le fournisseur d'e-mail.",
    )
  }

  const limited = enforceRateLimit(request, invitationLimiter, 'meeting-invite')
  if (limited) return limited

  const meetingId = normalizeMeetingId(rawMeetingId)
  if (!meetingId) {
    return failure(400, 'meeting-invalid', "L'identifiant du rendez-vous est invalide.")
  }

  const body = await readJsonBody(request)
  if (!body) return failure(400, 'body-invalid', 'Requête illisible.')

  const realtimeKitId = typeof body.realtimeKitId === 'string' ? body.realtimeKitId.trim() : ''
  if (!isUuid(realtimeKitId)) {
    return failure(400, 'meeting-invalid', "L'identifiant de réunion Cloudflare est absent ou invalide.")
  }

  const startsAt = normalizeStartsAt(body.startsAt)
  if (!startsAt) {
    return failure(
      400,
      'appointment-invalid',
      "Indiquez une date et une heure de rendez-vous valides, dans l'année à venir.",
    )
  }

  const guests = Array.isArray(body.guests)
    ? [...new Set(body.guests.map(normalizeEmail).filter(Boolean))]
    : []
  const hostEmail = normalizeEmail(body.hostEmail)

  if (guests.length === 0) {
    return failure(400, 'recipients-invalid', 'Indiquez au moins une adresse e-mail de participant.')
  }
  if (!hostEmail) {
    return failure(400, 'recipients-invalid', "Indiquez votre adresse e-mail pour recevoir le rappel du lien.")
  }

  const recipients = [...new Set([...guests, hostEmail])]
  if (recipients.length > MAX_INVITATION_RECIPIENTS) {
    return failure(
      400,
      'recipients-invalid',
      `Proposez au maximum ${MAX_INVITATION_RECIPIENTS} adresses par envoi.`,
    )
  }

  // Le nom de la réunion vient de RealtimeKit, jamais du navigateur : le
  // message ne peut pas être détourné en texte libre.
  let title = DEFAULT_MEETING_TITLE
  try {
    const meeting = await getMeeting(env, realtimeKitId)
    if (meeting) title = normalizeTitle(meeting.title, DEFAULT_MEETING_TITLE)
  } catch (error) {
    return realtimeKitFailure(error)
  }

  const origin = new URL(request.url).origin
  // Même forme que le lien affiché par l'application (`/rdv-…?r=…`).
  const link = `${origin}/rdv-${meetingId}?r=${encodeURIComponent(realtimeKitId)}`

  let sent = 0
  const failed = []

  for (const address of recipients) {
    const content = buildInvitation({
      title,
      startsAt,
      link,
      maxParticipants: MAX_PARTICIPANTS,
      isHost: address === hostEmail,
    })

    try {
      await sendMail(env, { to: address, ...content })
      sent += 1
    } catch (error) {
      reportFailure('mail', error)
      failed.push({ email: address, code: error instanceof MailError ? error.code : 'mail-failed' })
    }
  }

  if (sent === 0) {
    return failure(
      502,
      'mail-failed',
      "Aucune invitation n'a pu être envoyée. Vérifiez que le domaine d'envoi est vérifié chez le fournisseur d'e-mail, puis réessayez.",
    )
  }

  return json({ sent, failed })
}

/**
 * `GET /api/meetings/:id` — nom de la réunion, lisible par ses participants.
 *
 * Le nom saisi par l'organisateur est stocké dans le **titre de la réunion
 * RealtimeKit** : aucune base de données n'est nécessaire, et le nom suit la
 * réunion partout où elle existe. La réponse ne contient que l'identifiant et
 * le nom — jamais un participant, jamais un jeton, jamais le jeton d'API.
 */
async function handleMeetingInfo(request, env, meetingId) {
  if (!isUuid(meetingId)) {
    return failure(400, 'meeting-invalid', "L'identifiant de réunion Cloudflare est absent ou invalide.")
  }

  const limited = enforceRateLimit(request, meetingInfoLimiter, 'meeting-info')
  if (limited) return limited

  try {
    const meeting = await getMeeting(env, meetingId)
    if (!meeting) {
      return failure(404, 'meeting-not-found', "Cette réunion n'existe plus côté Cloudflare RealtimeKit.")
    }

    return json({ meetingId, title: normalizeTitle(meeting.title, DEFAULT_MEETING_TITLE) })
  } catch (error) {
    return realtimeKitFailure(error)
  }
}

/**
 * `GET /api/rtk/diagnostic` — état **en lecture seule** de la configuration.
 * Réservé à l'organisateur : ne renvoie que des statuts et des noms de presets,
 * jamais le jeton, jamais un en-tête, jamais un corps amont.
 */
async function handleDiagnostic(request, env) {
  if (!(await isHostRequest(request, env))) {
    return failure(401, 'host-unauthorized', "Diagnostic réservé à l'organisateur authentifié.")
  }

  const config = effectiveConfig(env)
  const report = {
    apiTokenPresent: config.tokenPresent,
    hostKeyPresent: hasHostSecret(env),
    mailConfigured: hasMailer(env),
    accountId: config.accountId,
    appId: config.appId,
    presetsExpected: { host: config.hostPreset, guest: config.guestPreset },
    maxParticipants: MAX_PARTICIPANTS,
    presetsRead: null,
    presetsAvailable: null,
  }

  try {
    const names = await listPresets(env)
    report.presetsRead = 'ok'
    report.presetsAvailable = names
  } catch (error) {
    report.presetsRead = error instanceof RealtimeKitError ? `${error.status}` : 'erreur'
    report.presetsError = error instanceof RealtimeKitError ? error.code : null
  }

  return json(report)
}

/** Table de routage de l'API. Renvoie `null` si le chemin n'est pas géré ici. */
async function routeApi(request, url, env) {
  const path = url.pathname.replace(/\/+$/, '') || '/'

  // Version réellement déployée : le commit vient de `worker/version.js`, écrit
  // par `npm run build`. Permet de répondre à « quel code tourne en prod ? »
  // sans accès au tableau de bord ni à la clé organisateur.
  if (path === '/api/version' && (request.method === 'GET' || request.method === 'HEAD')) {
    return json({
      service: 'phildev-visio',
      version: APP_VERSION,
      commit: BUILD_COMMIT,
      commitDate: BUILD_COMMIT_DATE,
    })
  }
  if (path === '/api/health' && (request.method === 'GET' || request.method === 'HEAD')) {
    return json({
      ok: true,
      service: 'phildev-visio',
      version: APP_VERSION,
      commit: BUILD_COMMIT,
      realtimeKitConfigured: hasApiToken(env) && hasHostSecret(env),
      // Simple présence du secret d'envoi, jamais sa valeur : permet de
      // vérifier depuis l'extérieur qu'un envoi d'invitations est possible.
      mailConfigured: hasMailer(env),
    })
  }

  // Protection CSRF : une mutation cross-origin est refusée. Les clients sans
  // en-tête `Origin` (curl, tests) restent acceptés : ils n'ont pas de session
  // implicite à détourner.
  if (request.method === 'POST') {
    const origin = request.headers.get('Origin')
    if (origin) {
      let sameOrigin = false
      try {
        sameOrigin = new URL(origin).host === url.host
      } catch {
        sameOrigin = false
      }
      if (!sameOrigin) return failure(403, 'origin-refused', 'Origine non autorisée.')
    }
  }

  if (path === '/api/host/session' && request.method === 'POST') {
    return handleHostSession(request, env)
  }
  if (path === '/api/meetings' && request.method === 'POST') {
    return handleCreateMeeting(request, env)
  }

  const meetingInfoMatch = path.match(/^\/api\/meetings\/([^/]+)$/)
  if (meetingInfoMatch && (request.method === 'GET' || request.method === 'HEAD')) {
    return handleMeetingInfo(request, env, meetingInfoMatch[1])
  }
  const invitationMatch = path.match(/^\/api\/meetings\/([^/]+)\/invitations$/)
  if (invitationMatch && request.method === 'POST') {
    return handleMeetingInvitations(request, env, invitationMatch[1])
  }
  if (path === '/api/rtk/token' && request.method === 'POST') {
    return handleParticipantToken(request, env)
  }
  if (path === '/api/rtk/diagnostic' && request.method === 'GET') {
    return handleDiagnostic(request, env)
  }

  return failure(404, 'not-found', "Cette adresse d'API n'existe pas.")
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      // Filet de sécurité : une exception imprévue dans l'API ne doit ni
      // produire une page 500 sans explication, ni passer sans trace.
      try {
        return applySecurityHeaders(await routeApi(request, url, env))
      } catch (error) {
        reportFailure('api', error)
        return applySecurityHeaders(
          failure(
            500,
            'internal-error',
            'Une erreur interne a empêché de traiter la demande. Réessayez dans un instant.',
          ),
        )
      }
    }

    const response = await env.ASSETS.fetch(request)

    // Ressource servie, redirection, erreur autre que « introuvable » :
    // la réponse de la couche assets fait foi.
    if (response.status !== 404) return applySecurityHeaders(response)

    // Ressource absente : le 404 est conservé tel quel.
    if (!isAppNavigation(request)) return applySecurityHeaders(response)

    // Route de l'application absente du disque : c'est l'entrée de l'interface.
    const indexUrl = new URL('/', request.url)
    return applySecurityHeaders(await env.ASSETS.fetch(new Request(indexUrl, request)))
  },
}
