/**
 * Aperçu d'un rappel SMS, côté navigateur.
 *
 * Le message réel est rédigé par le Worker (`worker/sms.js`) : ce module en
 * reproduit volontairement la règle — titre, jour/heure de Paris, aucun lien,
 * un seul segment — pour que l'organisateur voie exactement ce qui partira.
 * Le serveur reste la référence : c'est lui qui envoie et qui valide.
 */

const APPOINTMENT_TIME_ZONE = 'Europe/Paris'

export type SmsEncoding = 'gsm7' | 'ucs2'

export interface SmsEstimate {
  encoding: SmsEncoding
  length: number
  segments: number
}

const GSM7_BASIC = new Set(
  Array.from(
    '@£$¥èéùàìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñü',
  ),
)

const GSM7_EXTENSION = new Set(Array.from('^{}\\[\\]~|€'))

/** Normalise un numéro français en E.164, ou renvoie `null`. */
export function normalizePhone(raw: string): string | null {
  let value = raw.replace(/[\s.\-()]/g, '')
  if (value.startsWith('00')) value = `+${value.slice(2)}`

  if (/^0[1-9]\d{8}$/.test(value)) return `+33${value.slice(1)}`
  if (/^\+33[1-9]\d{8}$/.test(value)) return value

  return null
}

/**
 * Numéros saisis, un par ligne (ou séparés par des virgules / points-virgules).
 * Les espaces internes d'un numéro sont conservés, les doublons retirés.
 */
export function parsePhoneList(raw: string): { valid: string[]; invalid: string[] } {
  const tokens = raw
    .split(/[\n,;]+/)
    .map((value) => value.trim())
    .filter(Boolean)

  const valid: string[] = []
  const invalid: string[] = []

  for (const token of tokens) {
    const normalized = normalizePhone(token)
    if (!normalized) invalid.push(token)
    else if (!valid.includes(normalized)) valid.push(normalized)
  }

  return { valid, invalid }
}

/** Rendez-vous lisible : « lundi 23/11 14H30 » (heure de Paris). */
export function formatSmsMoment(startsAt: string): string | null {
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

  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? ''
  return `${part('weekday')} ${part('day')}/${part('month')} ${part('hour')}H${part('minute')}`.trim()
}

/** Estime l'encodage et le nombre de segments. */
export function estimateSms(text: string): SmsEstimate {
  const characters = Array.from(text)
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

  const length = text.length
  return { encoding: 'ucs2', length, segments: length <= 70 ? 1 : Math.ceil(length / 67) }
}

/**
 * Aperçu du rappel envoyé par le serveur, avec la même règle : le titre complet
 * tant que le message tient en un segment (160 GSM-7 ou 70 UCS-2), tronqué
 * seulement au-delà. Renvoie `null` si la date est inutilisable.
 */
export function buildSmsPreview(
  title: string,
  startsAt: string,
): ({ text: string } & SmsEstimate) | null {
  const moment = formatSmsMoment(startsAt)
  if (!moment) return null

  const tail = ` ${moment}. Lien envoyé dans votre boite email`
  const rawTitle = title.trim().length > 0 ? title.trim() : 'Réunion PhilDEV'

  const fitsOneSegment = (candidate: string) => estimateSms(candidate).segments <= 1
  const characters = Array.from(rawTitle)
  let fitted = characters.join('')
  if (!fitsOneSegment(fitted + tail)) {
    while (characters.length > 1) {
      characters.pop()
      fitted = `${characters.join('')}…`
      if (fitsOneSegment(fitted + tail)) break
    }
  }

  const text = `${fitted}${tail}`
  return { text, ...estimateSms(text) }
}
