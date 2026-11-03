/**
 * Envoi des invitations de rendez-vous par e-mail.
 *
 * Le Worker appelle l'API **HTTP** du fournisseur (Resend) : il n'y a ni SDK
 * Node ni socket à ouvrir, seulement un `fetch` avec la clé `RESEND_API_KEY`.
 * Cette clé reste côté serveur — elle n'est jamais renvoyée au navigateur, ni
 * journalisée, ni incluse dans un message d'erreur.
 *
 * Deux règles tenues ici :
 *
 * 1. **un message par destinataire** — les invités ne voient pas les adresses
 *    des autres, et un refus isolé n'invalide pas les envois déjà faits ;
 * 2. **contenu rédigé côté serveur** — sujet et corps sont construits à partir
 *    du nom réel de la réunion, jamais de texte fourni par le navigateur : le
 *    domaine d'envoi ne peut pas servir de relais.
 */

const ENDPOINT = 'https://api.resend.com/emails'

/** Expéditeur par défaut : domaine vérifié chez le fournisseur. */
const DEFAULT_FROM = 'PhilDEV Visio <invitation@phildev.online>'

/** Fuseau affiché dans les invitations (les rendez-vous sont pris à Paris). */
const APPOINTMENT_TIME_ZONE = 'Europe/Paris'

/** Refus d'envoi normalisé : statut amont et code stable, jamais le corps amont. */
export class MailError extends Error {
  constructor(status, code) {
    super(`envoi d'e-mail refusé (${status} ${code})`)
    this.name = 'MailError'
    this.status = status
    this.code = code
  }
}

/** Le fournisseur est-il configuré ? (secret `RESEND_API_KEY` présent) */
export function hasMailer(env) {
  return typeof env?.RESEND_API_KEY === 'string' && env.RESEND_API_KEY.length > 0
}

/** Adresse d'expédition, surchargeable par `MAIL_FROM`. */
export function mailFrom(env) {
  const configured = env?.MAIL_FROM
  return typeof configured === 'string' && configured.trim().length > 0
    ? configured.trim()
    : DEFAULT_FROM
}

/**
 * Envoie un message à **une** adresse.
 * Lève `MailError` : `mail-not-configured` (secret absent), `mail-unreachable`
 * (réseau), ou le statut du fournisseur avec son code d'erreur.
 */
export async function sendMail(env, { to, subject, text, html }) {
  if (!hasMailer(env)) throw new MailError(503, 'mail-not-configured')

  let response
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: mailFrom(env), to: [to], subject, text, html }),
    })
  } catch {
    throw new MailError(0, 'mail-unreachable')
  }

  if (response.ok) return true

  // Seul un nom d'erreur stable est lu : le corps amont n'est jamais relayé.
  let code = 'mail-rejected'
  try {
    const payload = await response.json()
    if (payload && typeof payload.name === 'string') code = payload.name
  } catch {
    // Corps non JSON : le statut suffit à qualifier l'échec.
  }

  throw new MailError(response.status, code)
}

/** Échappement HTML des valeurs insérées dans le message. */
function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  )
}

/** Rendez-vous lisible, ex. « mardi 4 novembre 2026 à 14:30 ». */
export function formatAppointment(startsAt) {
  const date = new Date(startsAt)
  if (Number.isNaN(date.getTime())) return null

  return new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: APPOINTMENT_TIME_ZONE,
  }).format(date)
}

/**
 * Rédige l'invitation (sujet, texte, HTML) pour un destinataire.
 * L'organisateur reçoit le même lien sous forme de rappel, avec un sujet
 * distinct pour le retrouver dans sa boîte.
 */
export function buildInvitation({ title, startsAt, link, maxParticipants, isHost }) {
  const moment = formatAppointment(startsAt)
  if (!moment) return null

  // L'invitation s'ouvre sur une phrase, puis le nom de la réunion sur sa
  // propre ligne : c'est ce que le destinataire cherche en premier.
  const intro = isHost
    ? `Voici le rappel du lien de la réunion « ${title} » que vous organisez.`
    : 'PhilDEV vous invite à une réunion :'
  const titleLine = isHost ? null : `« ${title} »`
  const subject = `${isHost ? 'Rappel — ' : ''}${title} : ${moment}`
  const closing =
    "Aucun compte n'est nécessaire : ouvrez ce lien à l'heure du rendez-vous, indiquez votre nom, puis rejoignez la salle. " +
    `La réunion accueille jusqu'à ${maxParticipants} participants.`

  const text = [
    'Bonjour,',
    '',
    intro,
    ...(titleLine ? [titleLine] : []),
    `Rendez-vous : ${moment} (heure de Paris).`,
    '',
    'Rejoindre la réunion :',
    link,
    '',
    closing,
    '',
    '— PhilDEV Visio',
  ].join('\n')

  const safeLink = escapeHtml(link)
  const html = `<!doctype html>
<html lang="fr"><body style="margin:0;padding:24px;background:#0b1220;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#e2e8f0">
  <div style="max-width:520px;margin:0 auto;background:#111c30;border-radius:16px;padding:24px">
    <p style="margin:0 0 ${titleLine ? '4' : '16'}px;font-size:15px;line-height:1.6">${escapeHtml(intro)}</p>${titleLine ? `
    <p style="margin:0 0 16px;font-size:18px;line-height:1.4;font-weight:600;color:#ffffff">${escapeHtml(titleLine)}</p>` : ''}
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6"><strong>Rendez-vous :</strong> ${escapeHtml(moment)} (heure de Paris)</p>
    <p style="margin:0 0 20px"><a href="${safeLink}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#3b82f6;color:#ffffff;text-decoration:none;font-weight:600">Rejoindre la réunion</a></p>
    <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#94a3b8">Lien direct : <a href="${safeLink}" style="color:#93c5fd">${safeLink}</a></p>
    <p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:#94a3b8">${escapeHtml(closing)}</p>
    <p style="margin:24px 0 0;font-size:13px;color:#64748b">PhilDEV Visio</p>
  </div>
</body></html>`

  return { subject, text, html }
}
