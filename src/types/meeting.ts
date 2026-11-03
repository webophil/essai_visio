/**
 * Types du domaine « réunion ».
 * Ils constituent l'interface publique consommée par les composants : les
 * objets du SDK RealtimeKit sont traduits vers ces types par l'adaptateur de
 * transport (`src/meeting/transport`), jamais exposés directement à l'UI.
 */

export type SessionPhase = 'prejoin' | 'in-meeting'

export type SidePanelId = 'participants' | 'chat' | 'effects'

export type MediaKind = 'audio' | 'video'

/** État d'accès à un périphérique (un état par famille de périphérique). */
export type MediaAccessState = 'idle' | 'requesting' | 'granted' | 'denied' | 'error'

export interface MediaDeviceOption {
  deviceId: string
  label: string
}

export interface MediaDeviceList {
  audioInputs: MediaDeviceOption[]
  videoInputs: MediaDeviceOption[]
}

export const EMPTY_DEVICE_LIST: MediaDeviceList = { audioInputs: [], videoInputs: [] }

/** Participant local : le seul participant réellement présent en Phase 1. */
export interface LocalParticipant {
  displayName: string
  audioEnabled: boolean
  videoEnabled: boolean
  screenSharing: boolean
}

export type TransportMode = 'local-only' | 'realtimekit'

/** Rôle effectif d'un participant dans la réunion. */
export type ParticipantRole = 'host' | 'guest'

/**
 * État de connexion du transport.
 * `local` signifie explicitement : aucune connexion réseau n'est établie.
 */
export type TransportConnectionState =
  | 'local'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'

export interface TransportState {
  mode: TransportMode
  supportsRemoteParticipants: boolean
  connection: TransportConnectionState
}

/** Vue d'un participant (locale ou distante), dérivée du SDK. */
export interface ParticipantView {
  id: string
  name: string
  isLocal: boolean
  isHost: boolean
  audioEnabled: boolean
  videoEnabled: boolean
  screenShareEnabled: boolean
}

/** État média du participant local, tel que rapporté par le SDK. */
export interface LiveSelfState {
  audioEnabled: boolean
  videoEnabled: boolean
  screenShareEnabled: boolean
  hasAudioTrack: boolean
  hasVideoTrack: boolean
}

/** Partage d'écran en cours (local ou distant). */
export interface ScreenShareState {
  participantId: string
  participantName: string
  isLocal: boolean
}

/**
 * Effet appliqué à la caméra locale **avant diffusion**.
 * `none` diffuse le flux tel quel ; `blur` détoure la silhouette et floute le
 * fond (traitement local, aucun service externe).
 */
export type VideoEffectId = 'none' | 'blur'

/**
 * Fichier joint à un message : ses métadonnées et le lien de téléchargement
 * délivré par la réunion. Le contenu du fichier n'est jamais lu par
 * l'application, qui ne conserve qu'un lien valable pour les participants.
 */
export interface ChatAttachmentView {
  name: string
  /** Taille annoncée par l'expéditeur, en octets (`0` si inconnue). */
  bytes: number
  url: string
}

/** Champs communs à tous les messages affichés dans le panneau. */
interface ChatMessageBase {
  id: string
  /** Nom affiché de l'auteur, fourni par le SDK. */
  authorName: string
  /** Vrai pour les messages envoyés depuis ce navigateur. */
  isLocal: boolean
  /** Horodatage de réception (millisecondes). */
  sentAt: number
}

/** Message écrit. */
export interface ChatTextMessageView extends ChatMessageBase {
  kind: 'text'
  text: string
}

/** Message portant un fichier à télécharger. */
export interface ChatFileMessageView extends ChatMessageBase {
  kind: 'file'
  file: ChatAttachmentView
}

/** Message du chat de réunion, tel qu'affiché dans le panneau. */
export type ChatMessageView = ChatTextMessageView | ChatFileMessageView

/**
 * Taille maximale acceptée pour un fichier partagé (25 Mo).
 *
 * C'est une garde de l'application, pas une limite de la plateforme : au-delà,
 * le téléversement est refusé avant tout envoi, avec un message explicite
 * plutôt qu'un échec réseau difficile à interpréter.
 */
export const MAX_CHAT_FILE_BYTES = 25 * 1024 * 1024

/**
 * État du chat de réunion.
 * Les messages vivent dans la réunion RealtimeKit : ils ne sont ni stockés ni
 * relus après la réunion, et disparaissent avec elle.
 */
export interface ChatState {
  /** Le chat est-il proposé par le profil de participant ? */
  available: boolean
  /** L'envoi de messages écrits est-il autorisé par le profil de participant ? */
  canSend: boolean
  /** L'envoi de fichiers est-il autorisé par le profil de participant ? */
  canSendFiles: boolean
  /** Explication affichée quand le chat n'est pas utilisable. */
  unavailableReason: string | null
  /** Longueur maximale d'un message, imposée par le SDK. */
  maxTextLength: number
  /** Taille maximale acceptée pour un fichier, en octets. */
  maxFileBytes: number
  messages: ChatMessageView[]
  /** Envoi d'un message écrit en cours. */
  sending: boolean
  /** Envoi d'un fichier en cours. */
  sendingFile: boolean
  /** Dernière erreur d'envoi de message, en français. */
  error: string | null
  /** Dernière erreur d'envoi de fichier, en français. */
  fileError: string | null
}

export const EMPTY_CHAT_STATE: ChatState = {
  available: false,
  canSend: false,
  canSendFiles: false,
  unavailableReason: null,
  maxTextLength: 500,
  maxFileBytes: MAX_CHAT_FILE_BYTES,
  messages: [],
  sending: false,
  sendingFile: false,
  error: null,
  fileError: null,
}

/** Erreur lisible remontée par la couche temps réel. */
export interface SessionError {
  code: string
  message: string
  canRetry: boolean
}

/**
 * Instantané de la session temps réel.
 * Chaque valeur provient du SDK RealtimeKit : aucune n'est simulée.
 */
export interface MeetingSessionState {
  connection: TransportConnectionState
  /** Nombre maximum de participants autorisé pour la réunion. */
  maxParticipants: number
  /** Participants présents, participant local inclus en tête de liste. */
  participants: ParticipantView[]
  /** Nombre de participants distants effectivement connectés. */
  remoteCount: number
  self: LiveSelfState
  screenShare: ScreenShareState | null
  error: SessionError | null
}

export const EMPTY_SELF_STATE: LiveSelfState = {
  audioEnabled: false,
  videoEnabled: false,
  screenShareEnabled: false,
  hasAudioTrack: false,
  hasVideoTrack: false,
}

export function emptySessionState(maxParticipants = 0): MeetingSessionState {
  return {
    connection: 'disconnected',
    maxParticipants,
    participants: [],
    remoteCount: 0,
    self: EMPTY_SELF_STATE,
    screenShare: null,
    error: null,
  }
}
