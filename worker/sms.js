/**
 * Rappels de réunion par SMS (API Sweego).
 *
 * Le Worker appelle l'API HTTP de Sweego avec `fetch` : aucun SDK, aucun socket.
 * La clé `SWEEGO_API_KEY` reste côté serveur — jamais renvoyée au navigateur,
 * jamais journalisée, jamais incluse dans un message d'erreur.
 *
 * Le message est **rédigé ici** : nom réel de la réunion, jour et heure de
 * Paris, et **aucun lien** (le lien part par e-mail). Il est volontairement
 * calibré pour tenir en **un seul segment**, même en UCS-2 : un rappel court
 * coûte un SMS par destinataire, sans mauvaise surprise de découpage.
 */

const ENDPOINT = 'https://api.sweego.io/send'

/** Expéditeur par défaut : nom de marque, à faire valider chez Sweego. */
const DEFAULT_SENDER_ID = 'PhilDEV'

/** Fuseau affiché dans le rappel (les rendez-vous sont pris à Paris). */
const APPOINTMENT_TIME_ZONE = 'Europe/Paris'

/**
 * Longueur maximale visée : 70 caractères, la limite d'un segment **UCS-2**.
 * En GSM-7 la limite serait 160, mais plafonner à 70 garantit un seul SMS quel
 * que soit le titre (accents, guillemets, emoji).
 */
const MAX_ONE_SEGMENT = 70

/** Refus d'envoi normalisé : statut amont et code stable, jamais le corps amont. */
export class SmsError extends Error {
  constructor(status, code) {
    super(`envoi de SMS refusé (${status} ${code})`)
    this.name = 'SmsError'
    this.status = status
    this.code = code
  }
}

/** Le fournisseur est-il configuré ? (secret `SWEEGO_API_KEY` présent) */
export function hasSms(env) {
  return typeof env?.SWEEGO_API_KEY === 'string' && env.SWEEGO_API_KEY.length > 0
}

/**
 * Expéditeur alphanumérique : 3 à 11 caractères, au moins une lettre.
 * Une valeur invalide est ignorée au profit du nom de marque par défaut.
 */
export function smsSenderId(env) {
  const configured = typeof env?.SWEEGO_SENDER_ID === 'string' ? env.SWEEGO_SENDER_ID.trim() : ''
  return /^(?=.*[A-Za-z])[A-Za-z0-9]{3,11}$/.test(configured) ? configured : DEFAULT_SENDER_ID
}

/**
 * Normalise un numéro français en E.164 (`+33612345678`).
 * Accepte `06 12 34 56 78`, `+33 6…`, `0033 6…`. Renvoie `null` sinon : aucun
 * numéro n'est inventé, et l'international reste hors périmètre.
 */
export function normalizePhone(raw) {
  if (typeof raw !== 'string') return null

  let value = raw.replace(/[\s.\-()]/g, '')
  if (value.startsWith('00')) value = `+${value.slice(2)}`

  if (/^0[1-9]\d{8}$/.test(value)) return `+33${value.slice(1)}`
  if (/^\+33[1-9]\d{8}$/.test(value)) return value

  return null
}

/** Rendez-vous lisible pour un SMS : « lundi 23/11 14H30 » (heure de Paris). */
export function formatSmsMoment(startsAt) {
  const date = new Date(startsAt)
  if (Number.isNaN(date.getTime())) return null

  const parts = new Intl.DateTimeFormat('fr-FR', {
    timeZone: APPOINTMENT_TIME_ZONE,
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)

  const part = (type) => parts.find((entry) => entry.type === type)?.value ?? ''
  const moment = `${part('weekday')} ${part('day')}/${part('month')} ${part('hour')}H${part('minute')}`
  return moment.trim().length > 0 ? moment : null
}

/** Caractères GSM-7 « de base » (1 septet). */
const GSM7_BASIC = new Set(
  Array.from(
    '@£$¥èéùàìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñü',
  ),
)

/** Caractères GSM-7 d'extension (2 septets). */
const GSM7_EXTENSION = new Set(Array.from('^{}\\[\\]~|€'))

/**
 * Estime l'encodage et le nombre de segments d'un texte.
 * `length` est exprimé en unités facturées (septets GSM-7, unités UTF-16 sinon).
 */
export function estimateSms(text) {
  const characters = Array.from(typeof text === 'string' ? text : '')
  const gsm7 = characters.every(
    (character) => GSM7_BASIC.has(character) || GSM7_EXTENSION.has(character),
  )

  if (gsm7) {
    const length = characters.reduce(
      (total, character) => total + (GSM7_EXTENSION.has(character) ? 2 : 1),
      0,
    )
    return { encoding: 'gsm7', length, segments: length <= 160 ? 1 : Math.ceil(length / 153) }
  }

  // UCS-2 : une unité UTF-16 par caractère BMP, deux pour un emoji.
  const length = String(text).length
  return { encoding: 'ucs2', length, segments: length <= 70 ? 1 : Math.ceil(length / 67) }
}

/**
 * Rédige le rappel : « Réunion PhilDEV lundi 23/11 14H30. Lien envoyé dans
 * votre boite email ». Le titre est tronqué (`…`) pour rester sous 70
 * caractères, donc à un seul segment même en UCS-2.
 */
export function buildSmsReminder({ title, startsAt }) {
  const moment = formatSmsMoment(startsAt)
  if (!moment) return null

  const tail = ` ${moment}. Lien envoyé dans votre boite email`
  const rawTitle = typeof title === 'string' && title.trim().length > 0 ? title.trim() : 'Réunion PhilDEV'

  const characters = Array.from(rawTitle)
  let fitted = characters.join('')
  if ((fitted + tail).length > MAX_ONE_SEGMENT) {
    while (characters.length > 1) {
      characters.pop()
      fitted = `${characters.join('')}…`
      if ((fitted + tail).length <= MAX_ONE_SEGMENT) break
    }
  }

  const text = `${fitted}${tail}`
  return { text, ...estimateSms(text) }
}

/**
 * Envoie **un** rappel à **un** numéro.
 * Lève `SmsError` : `sms-not-configured`, `sms-unreachable`, ou le statut du
 * fournisseur avec un code stable.
 */
export async function sendSms(env, { to, text }) {
  if (!hasSms(env)) throw new SmsError(503, 'sms-not-configured')

  let response
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Api-Key': env.SWEEGO_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel: 'sms',
        provider: 'sweego',
        'campaign-type': 'transac',
        'sender-id': smsSenderId(env),
        recipients: [{ num: to, region: 'FR' }],
        'message-txt': text,
      }),
    })
  } catch {
    throw new SmsError(0, 'sms-unreachable')
  }

  if (response.ok) return true

  // Seul un code stable est lu : le corps amont n'est jamais relayé.
  let code = 'sms-rejected'
  try {
    const payload = await response.json()
    if (payload && typeof payload.code === 'string') code = payload.code
    else if (payload && typeof payload.error === 'string') code = payload.error
  } catch {
    // Corps non JSON : le statut suffit à qualifier l'échec.
  }

  throw new SmsError(response.status, code)
}
