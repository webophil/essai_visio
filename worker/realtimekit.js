/**
 * Client RealtimeKit (API REST Cloudflare) — **serveur uniquement**.
 *
 * Frontière de confiance : le jeton d'API Cloudflare
 * (`env.CLOUDFLARE_API_TOKEN`, portée « Realtime Admin ») ne quitte jamais le
 * Worker. Il n'est ni journalisé, ni renvoyé dans une réponse HTTP, ni exposé au
 * navigateur. Seuls les **jetons participant** — de portée limitée à une
 * réunion et à un preset — franchissent la frontière serveur → navigateur.
 *
 * Aucune erreur remontée ici ne contient le jeton : seule la position
 * (`status`, `code` d'API) est conservée, jamais le corps brut de la réponse
 * amont ni les en-têtes.
 */

const API_BASE = 'https://api.cloudflare.com/client/v4'

/**
 * Identifiants de l'application RealtimeKit « Visio-PhilDEV ».
 * Ce ne sont pas des secrets : l'identifiant de compte et l'identifiant
 * d'application n'autorisent aucun appel à eux seuls. Ils peuvent être
 * surchargés par variables d'environnement sans modification du code.
 */
export const DEFAULT_ACCOUNT_ID = 'adad9ec2e55b7a9279e74eea378c3a54'
export const DEFAULT_APP_ID = '09fe762d-4e8d-45c7-9129-a466ae061711'

/** Presets créés dans le tableau de bord RealtimeKit. */
export const DEFAULT_HOST_PRESET = 'group_call_host'
export const DEFAULT_GUEST_PRESET = 'group_call_participant'

/**
 * Identifiant participant de l'organisateur.
 * Constante volontaire : une réunion ne possède qu'un seul organisateur, et un
 * identifiant stable évite de consommer un nouvel emplacement à chaque
 * reconnexion de l'hôte.
 */
export const HOST_CUSTOM_ID = '2f1c9a40-0000-4000-8000-7068696c646576'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Vrai si la valeur ressemble à un identifiant Cloudflare (UUID). */
export function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value.trim())
}

/** Erreur d'appel RealtimeKit : sans jeton, sans corps amont, sans en-têtes. */
export class RealtimeKitError extends Error {
  constructor(message, { status = 0, code = null, endpoint = '' } = {}) {
    super(message)
    this.name = 'RealtimeKitError'
    this.status = status
    this.code = code
    this.endpoint = endpoint
  }
}

function readConfig(env) {
  const token =
    typeof env?.CLOUDFLARE_API_TOKEN === 'string' ? env.CLOUDFLARE_API_TOKEN.trim() : ''
  const accountId = String(env?.RTK_ACCOUNT_ID || DEFAULT_ACCOUNT_ID).trim()
  const appId = String(env?.RTK_APP_ID || DEFAULT_APP_ID).trim()
  const hostPreset = String(env?.RTK_HOST_PRESET || DEFAULT_HOST_PRESET).trim()
  const guestPreset = String(env?.RTK_GUEST_PRESET || DEFAULT_GUEST_PRESET).trim()

  return { token, accountId, appId, hostPreset, guestPreset }
}

/** Presets réellement configurés pour l'application (surchargeables). */
export function presets(env) {
  const { hostPreset, guestPreset } = readConfig(env)
  return { host: hostPreset, guest: guestPreset }
}

/**
 * Configuration effective du client, **sans le jeton** : seuls l'identifiant de
 * compte, l'identifiant d'application et les presets sont exposés (ce ne sont
 * pas des secrets). Le jeton est réduit à un booléen de présence.
 */
export function effectiveConfig(env) {
  const { token, accountId, appId, hostPreset, guestPreset } = readConfig(env)
  return { tokenPresent: token.length > 0, accountId, appId, hostPreset, guestPreset }
}

/** Le Worker dispose-t-il d'un jeton d'API ? (jamais la valeur, seulement le fait.) */
export function hasApiToken(env) {
  return readConfig(env).token.length > 0
}

async function readJson(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

async function request(env, { method, path, body }) {
  const { token, accountId, appId } = readConfig(env)

  if (!token) {
    throw new RealtimeKitError("Jeton d'API Cloudflare absent du Worker", {
      status: 503,
      code: 'missing-api-token',
      endpoint: path,
    })
  }

  const url = `${API_BASE}/accounts/${accountId}/realtime/kit/${appId}${path}`
  let response

  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new RealtimeKitError('API RealtimeKit injoignable', {
      status: 502,
      code: 'network',
      endpoint: path,
    })
  }

  const payload = await readJson(response)

  if (!response.ok || payload?.success === false) {
    const first = Array.isArray(payload?.errors) ? payload.errors[0] : null
    throw new RealtimeKitError('Requête RealtimeKit refusée', {
      status: response.status || 502,
      code: first?.code ?? String(response.status || 'error'),
      endpoint: path,
    })
  }

  return payload
}

/** Crée une réunion RealtimeKit et renvoie son identifiant Cloudflare. */
export async function createMeeting(env, { title }) {
  const payload = await request(env, {
    method: 'POST',
    path: '/meetings',
    body: { title },
  })

  const id = payload?.data?.id
  if (typeof id !== 'string' || id.length === 0) {
    throw new RealtimeKitError('Réunion créée sans identifiant exploitable', {
      status: 502,
      code: 'missing-meeting-id',
      endpoint: '/meetings',
    })
  }

  return { id, title }
}

/** Réunion existante (lecture seule) : sert à vérifier qu'un lien est vivant. */
export async function getMeeting(env, meetingId) {
  const payload = await request(env, { method: 'GET', path: `/meetings/${meetingId}` })
  return payload?.data ?? null
}

/**
 * Inscrit un participant et renvoie son jeton de participation.
 * Le jeton retourné est destiné au navigateur ; il ne s'agit pas du jeton d'API.
 */
export async function addParticipant(env, meetingId, { name, presetName, customParticipantId }) {
  const payload = await request(env, {
    method: 'POST',
    path: `/meetings/${meetingId}/participants`,
    body: {
      name,
      preset_name: presetName,
      custom_participant_id: customParticipantId,
    },
  })

  const data = payload?.data
  if (typeof data?.token !== 'string' || data.token.length === 0) {
    throw new RealtimeKitError('Jeton participant absent de la réponse', {
      status: 502,
      code: 'missing-participant-token',
      endpoint: `/meetings/${meetingId}/participants`,
    })
  }

  return {
    id: typeof data.id === 'string' ? data.id : null,
    token: data.token,
    name: typeof data.name === 'string' ? data.name : name,
    presetName: typeof data.preset_name === 'string' ? data.preset_name : presetName,
  }
}

/** Tous les participants enregistrés d'une réunion (jamais les jetons). */
export async function listParticipants(env, meetingId) {
  const payload = await request(env, {
    method: 'GET',
    path: `/meetings/${meetingId}/participants?per_page=100`,
  })

  return Array.isArray(payload?.data) ? payload.data : []
}

/** Presets de l'application : utilisé par le diagnostic (aucune écriture). */
export async function listPresets(env) {
  const payload = await request(env, { method: 'GET', path: '/presets' })
  const data = Array.isArray(payload?.data) ? payload.data : []

  return data
    .map((preset) => (typeof preset?.name === 'string' ? preset.name : null))
    .filter((name) => name !== null)
}

/**
 * Presets avec leurs permissions de chat, sans aucune donnée sensible.
 *
 * `GET /presets` renvoie les drapeaux réellement configurés dans le tableau de
 * bord : c'est la seule façon de savoir si l'envoi de fichiers est autorisé
 * pour les profils organisateur et invité. Aucun jeton ni identifiant n'est lu.
 */
export async function listPresetPermissions(env) {
  const payload = await request(env, { method: 'GET', path: '/presets' })
  const data = Array.isArray(payload?.data) ? payload.data : []

  return data
    .filter((preset) => typeof preset?.name === 'string')
    .map((preset) => ({
      name: preset.name,
      chat: {
        public: readChatFlags(preset?.permissions?.chat?.public),
        private: readChatFlags(preset?.permissions?.chat?.private),
      },
    }))
}

/** Drapeaux de chat d'un preset ; un drapeau absent vaut « refusé ». */
function readChatFlags(chat) {
  return {
    canSend: chat?.can_send === true,
    text: chat?.text === true,
    files: chat?.files === true,
    canReceive: chat?.can_receive === true,
  }
}

/**
 * Nombre d'emplacements occupés dans une réunion.
 *
 * Le comptage se fait sur les identifiants participants **distincts** : une
 * nouvelle inscription du même participant (reconnexion, nouveau jeton) ne
 * consomme pas d'emplacement supplémentaire. C'est ce qui rend la limite
 * exploitable sans base de données.
 */
export function countDistinctParticipants(rows, customIdOf = (row) => row?.custom_participant_id) {
  const seen = new Set()

  for (const row of Array.isArray(rows) ? rows : []) {
    const customId = customIdOf(row)
    if (typeof customId === 'string' && customId.length > 0) {
      seen.add(customId)
      continue
    }
    // Sans identifiant personnalisé, l'identifiant de participant fait office de clé.
    if (typeof row?.id === 'string' && row.id.length > 0) seen.add(row.id)
  }

  return seen.size
}

/** Vrai si un participant portant cet identifiant personnalisé existe déjà. */
export function hasParticipant(rows, customParticipantId) {
  return (Array.isArray(rows) ? rows : []).some(
    (row) => row?.custom_participant_id === customParticipantId,
  )
}
