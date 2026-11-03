/**
 * Traduction des erreurs RealtimeKit et du réseau en messages français.
 *
 * Les codes proviennent de la table officielle du SDK (`ClientError.code`).
 * Aucun message brut du SDK n'est affiché : il est technique et souvent en
 * anglais, alors que l'interface est entièrement en français.
 */

import type { SessionError } from '../types/meeting'
import { MeetingApiError } from './rtkApi'

interface Description {
  message: string
  canRetry: boolean
}

const CLIENT_ERROR_CODES: Record<string, Description> = {
  '0001': { message: "L'initialisation de la réunion a échoué. Rechargez la page et réessayez.", canRetry: true },
  '0002': { message: "Impossible de rejoindre la réunion. Vérifiez votre connexion, puis réessayez.", canRetry: true },
  '0004': { message: "Votre accès à cette réunion n'est plus valide. Rechargez la page pour en obtenir un nouveau.", canRetry: true },
  '0010': { message: 'Ce navigateur ne prend pas en charge la visioconférence. Essayez Chrome, Edge, Firefox ou Safari à jour.', canRetry: false },
  '0011': { message: 'Connexion au serveur impossible (réseau). Vérifiez votre connexion internet.', canRetry: true },
  '0012': { message: 'La connexion temps réel a été interrompue. La reconnexion est automatique.', canRetry: true },
  '0013': { message: 'Trop de tentatives en peu de temps. Patientez quelques instants avant de réessayer.', canRetry: true },
  '0014': { message: "La connexion audio/vidéo n'a pas pu s'établir. Un pare-feu ou un réseau d'entreprise peut bloquer les flux : essayez un autre réseau.", canRetry: true },
  '0101': { message: "Votre rôle dans cette réunion ne permet pas cette action.", canRetry: false },
  '0904': { message: "Le profil de participant configuré pour cette réunion est introuvable.", canRetry: false },
  '1101': { message: "Cette action n'est pas autorisée par votre profil de participant.", canRetry: false },
  '1601': { message: "Aucun microphone exploitable n'a été trouvé.", canRetry: false },
  '1602': { message: "Aucune caméra exploitable n'a été trouvée.", canRetry: false },
  '1606': { message: "Aucun microphone n'est disponible sur cet appareil.", canRetry: false },
  '1607': { message: "Aucune caméra n'est disponible sur cet appareil.", canRetry: false },
  '1612': { message: "Le partage d'écran n'a pas pu démarrer. Autorisez la capture, puis réessayez.", canRetry: true },
}

/** Vrai si l'erreur ressemble à une erreur du SDK RealtimeKit. */
function readClientCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string' && /^\d{4}$/.test(code)) return code
  return null
}

/** Décrit une erreur de navigation (permission refusée, matériel absent…). */
function describeDomException(error: unknown): Description | null {
  if (typeof DOMException === 'undefined' || !(error instanceof DOMException)) return null

  switch (error.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return {
        message:
          "L'accès au micro ou à la caméra a été refusé. Autorisez-le depuis l'icône de cadenas de la barre d'adresse, puis réessayez.",
        canRetry: true,
      }
    case 'NotFoundError':
    case 'OverconstrainedError':
      return { message: "Le périphérique demandé n'est pas disponible sur cet appareil.", canRetry: true }
    case 'NotReadableError':
    case 'AbortError':
      return {
        message: 'Le périphérique est déjà utilisé par une autre application. Fermez-la, puis réessayez.',
        canRetry: true,
      }
    default:
      return null
  }
}

/**
 * Traduit un échec d'envoi de message en une phrase affichable.
 * Les codes viennent de la même table que les erreurs de session ; aucun
 * message brut du SDK n'est affiché.
 */
export function describeChatError(error: unknown): string {
  const clientCode = readClientCode(error)

  if (clientCode === '0101' || clientCode === '1101') {
    return "Vous n’êtes pas autorisé à envoyer des messages dans cette réunion."
  }
  if (clientCode === '0013') {
    return 'Trop de messages envoyés en peu de temps. Patientez quelques instants.'
  }
  if (clientCode === '0011' || clientCode === '0012' || clientCode === '0014') {
    return "Le message n'est pas parti : la connexion à la réunion est interrompue. Réessayez dans un instant."
  }
  if (clientCode === '0004') {
    return "Votre accès à la réunion n'est plus valide : rechargez la page pour continuer à écrire."
  }

  return "Le message n'a pas pu être envoyé. Réessayez dans quelques instants."
}

/** Traduit une erreur quelconque en message affichable et actionnable. */
export function describeSessionError(error: unknown): SessionError {
  if (error instanceof MeetingApiError) {
    return {
      code: error.code,
      message: error.message,
      // Une réunion complète ou un refus d'autorisation ne se règle pas en réessayant.
      canRetry: !error.isCapacityReached && !error.needsHostAccess && !error.isApiUnavailable,
    }
  }

  const clientCode = readClientCode(error)
  if (clientCode && CLIENT_ERROR_CODES[clientCode]) {
    return { code: clientCode, message: CLIENT_ERROR_CODES[clientCode].message, canRetry: CLIENT_ERROR_CODES[clientCode].canRetry }
  }

  const domDescription = describeDomException(error)
  if (domDescription) return { code: 'media-denied', ...domDescription }

  if (error instanceof Error && error.message.length > 0 && error.name !== 'Error') {
    return { code: 'client-error', message: error.message, canRetry: true }
  }

  return {
    code: 'unknown',
    message: "Une erreur inattendue a interrompu la réunion. Rechargez la page pour reprendre.",
    canRetry: true,
  }
}
