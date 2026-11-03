import type RTKClient from '@cloudflare/realtimekit'
import type { RTKSelfMedia } from '@cloudflare/realtimekit'

import type { ChatState, MeetingSessionState, TransportState, VideoEffectId } from '../../types/meeting'

/**
 * Frontière d'intégration vers l'infrastructure temps réel.
 *
 * L'interface reste le seul point de contact entre les composants et le SDK :
 * l'implémentation actuelle est `RealtimeKitTransport` (Cloudflare RealtimeKit,
 * SFU). Le navigateur n'a jamais accès au jeton d'API Cloudflare : il ne reçoit
 * qu'un jeton participant, délivré par le Worker.
 */
export interface MeetingTransportOptions {
  /** Identifiant lisible de la réunion (route `/rdv-…`). */
  meetingId: string
  /** Identifiant de réunion Cloudflare RealtimeKit, `null` si le lien est incomplet. */
  realtimeKitId: string | null
  /** Nom affiché du participant. */
  displayName: string
  /** Rôle demandé : l'accès hôte est refusé par le serveur s'il n'est pas prouvé. */
  role: 'host' | 'guest'
  /** Jeton de session organisateur, transmis en en-tête (jamais en URL). */
  hostToken: string | null
  /**
   * Support média déjà acquis par le SDK lors de l'écran de préparation.
   * Le transmettre évite une seconde capture des périphériques.
   */
  mediaHandler: RTKSelfMedia | null
}

export interface MeetingTransport {
  readonly meetingId: string
  readonly realtimeKitId: string | null

  /** État courant du transport (mode, connexion, capacités). */
  getState(): TransportState

  /** Observe les changements d'état ; renvoie la fonction de désabonnement. */
  subscribe(listener: (state: TransportState) => void): () => void

  /** Rejoint la session : jeton participant, initialisation du SDK, connexion. */
  join(): Promise<void>

  /** Quitte la session et libère les ressources du transport. */
  leave(): Promise<void>

  /** Instantané de la session temps réel (participants, médias, erreurs). */
  getSession(): MeetingSessionState

  /** Observe les changements de session ; renvoie la fonction de désabonnement. */
  subscribeSession(listener: (session: MeetingSessionState) => void): () => void

  /** Instantané du chat de réunion (messages reçus, permissions, erreurs). */
  getChat(): ChatState

  /** Observe les changements du chat ; renvoie la fonction de désabonnement. */
  subscribeChat(listener: (chat: ChatState) => void): () => void

  /**
   * Envoie un message texte aux participants connectés.
   * Renvoie `true` quand le message a été accepté par le SDK.
   */
  sendChatMessage(text: string): Promise<boolean>

  /** Client RealtimeKit, exposé uniquement à l'interface de la salle. */
  getClient(): RTKClient | null

  /** Efface l'erreur de session affichée (après accusé de réception). */
  clearError(): void

  setMicrophoneEnabled(enabled: boolean): Promise<void>
  setCameraEnabled(enabled: boolean): Promise<void>
  setScreenShareEnabled(enabled: boolean): Promise<void>

  /**
   * Applique un effet de traitement vidéo local (`none` retire l'effet).
   * `onRuntimeFailure` est appelé si l'effet s'arrête après avoir démarré.
   */
  setVideoEffect(
    effect: VideoEffectId,
    onRuntimeFailure?: (message: string) => void,
  ): Promise<void>
}

export type MeetingTransportFactory = (options: MeetingTransportOptions) => MeetingTransport
