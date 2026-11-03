import RealtimeKitClient from '@cloudflare/realtimekit'
import type RTKClient from '@cloudflare/realtimekit'
import type { RTKClientOptions, RTKParticipant } from '@cloudflare/realtimekit'

import { EMPTY_CHAT_STATE, emptySessionState } from '../../types/meeting'
import type {
  ChatMessageView,
  ChatState,
  MeetingSessionState,
  ParticipantView,
  TransportState,
} from '../../types/meeting'
import { applyVideoEffect } from '../../media/backgroundBlur'
import type { VideoEffectId } from '../../types/meeting'
import { getOrCreateGuestId } from '../hostSession'
import { MeetingApiError, requestParticipantToken } from '../rtkApi'
import type { ParticipantRole } from '../rtkApi'
import { describeChatError, describeSessionError } from '../rtkErrors'
import type { MeetingTransport, MeetingTransportOptions } from './types'

/** Capacité annoncée tant que le serveur ne l'a pas confirmée. */
const DEFAULT_MAX_PARTICIPANTS = 5

/** Nombre de messages d'historique demandés à l'entrée en réunion. */
const CHAT_HISTORY_LIMIT = 40

/** Longueur de message retenue si le SDK n'annonce pas sa propre limite. */
const FALLBACK_MAX_TEXT_LENGTH = 500

/**
 * Message texte tel qu'exposé par le SDK.
 * Sous-ensemble structurel assumé : les types publiés décrivent une union
 * discriminée par une énumération (`MessageType`) qui n'est pas exportée.
 */
interface ChatMessageLike {
  id: string
  type: string
  userId: string
  displayName?: string
  message?: string
  time?: Date
  timeMs?: number
  targetUserIds?: string[]
}

/** Signification affichable d'un état de sortie signalé par le SDK. */
const LEFT_STATE_MESSAGES: Record<string, string> = {
  kicked: "Vous avez été retiré de la réunion par l'organisateur.",
  ended: "L'organisateur a mis fin à la réunion.",
  rejected: "Votre entrée dans la réunion a été refusée.",
  failed: "La connexion à la réunion a échoué.",
}

/**
 * Transport Cloudflare RealtimeKit.
 *
 * Responsabilités : obtenir le jeton participant auprès du Worker, initialiser
 * le SDK, connecter le participant, puis exposer un instantané **réel** de la
 * session (participants, états audio/vidéo, partage d'écran). Le SDK est la
 * source de vérité : aucun état média n'est déduit d'une capture locale
 * parallèle.
 */
export class RealtimeKitTransport implements MeetingTransport {
  readonly meetingId: string
  readonly realtimeKitId: string | null

  private readonly options: MeetingTransportOptions
  private client: RTKClient | null = null
  private effectiveRole: ParticipantRole
  private state: TransportState
  private session: MeetingSessionState
  private readonly stateListeners = new Set<(state: TransportState) => void>()
  private readonly sessionListeners = new Set<(session: MeetingSessionState) => void>()
  private readonly chatListeners = new Set<(chat: ChatState) => void>()
  private readonly detachers: Array<() => void> = []
  private chat: ChatState = EMPTY_CHAT_STATE

  constructor(options: MeetingTransportOptions) {
    this.options = options
    this.meetingId = options.meetingId
    this.realtimeKitId = options.realtimeKitId
    this.effectiveRole = options.role

    this.state = {
      mode: 'realtimekit',
      supportsRemoteParticipants: options.realtimeKitId !== null,
      connection: options.realtimeKitId ? 'disconnected' : 'local',
    }

    this.session = emptySessionState(DEFAULT_MAX_PARTICIPANTS)
  }

  getState(): TransportState {
    return this.state
  }

  subscribe(listener: (state: TransportState) => void): () => void {
    this.stateListeners.add(listener)
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  getSession(): MeetingSessionState {
    return this.session
  }

  subscribeSession(listener: (session: MeetingSessionState) => void): () => void {
    this.sessionListeners.add(listener)
    return () => {
      this.sessionListeners.delete(listener)
    }
  }

  getChat(): ChatState {
    return this.chat
  }

  /**
   * Observe le chat. L'état courant est transmis immédiatement : l'abonnement
   * arrive après l'entrée en salle, donc après le chargement de l'historique.
   */
  subscribeChat(listener: (chat: ChatState) => void): () => void {
    this.chatListeners.add(listener)
    listener(this.chat)
    return () => {
      this.chatListeners.delete(listener)
    }
  }

  /**
   * Envoie un message texte dans la salle.
   * Le message part par la messagerie **native** de RealtimeKit : il n'est ni
   * stocké par l'application, ni relu après la réunion.
   */
  async sendChatMessage(text: string): Promise<boolean> {
    const client = this.client
    const trimmed = text.trim()
    if (!client || trimmed.length === 0) return false

    if (!this.chat.available || !this.chat.canSend) {
      this.setChat({ error: this.chat.unavailableReason ?? "Le chat n'est pas autorisé dans cette réunion." })
      return false
    }

    if (trimmed.length > this.chat.maxTextLength) {
      this.setChat({ error: `Votre message dépasse ${this.chat.maxTextLength} caractères.` })
      return false
    }

    this.setChat({ sending: true, error: null })

    try {
      await client.chat.sendTextMessage(trimmed)
      this.refreshChat(client)
      this.setChat({ sending: false })
      return true
    } catch (error) {
      this.setChat({ sending: false, error: describeChatError(error) })
      return false
    }
  }

  getClient(): RTKClient | null {
    return this.client
  }

  clearError(): void {
    if (!this.session.error) return
    this.session = { ...this.session, error: null }
    this.emitSession()
  }

  async join(): Promise<void> {
    const { realtimeKitId, displayName, mediaHandler } = this.options

    if (!realtimeKitId) {
      throw new MeetingApiError({
        status: 400,
        code: 'meeting-link-incomplete',
        message:
          "Ce lien ne contient pas l'identifiant de la réunion Cloudflare. Demandez le lien complet à l'organisateur.",
      })
    }

    this.setConnection('connecting')
    this.session = { ...this.session, error: null }
    this.emitSession()

    const credential = await this.requestCredential(displayName)

    try {
      const client = await RealtimeKitClient.init({
        authToken: credential.token,
        // Le support média acquis à l'écran de préparation est réutilisé tel
        // quel : le SDK ne réouvre pas les périphériques.
        //
        // Le cast est imposé par les types publiés du SDK, qui déclarent
        // `mediaHandler` comme `SelfMedia` (classe à membres protégés) alors
        // que `initMedia` renvoie `Readonly<SelfMedia>` : les deux objets sont
        // pourtant bien le même type à l'exécution.
        defaults: (mediaHandler
          ? { mediaHandler }
          : { audio: false, video: false }) as unknown as RTKClientOptions['defaults'],
        onError: (error) => this.recordError(error),
      })

      this.client = client
      this.attachSessionListeners(client)
      await client.join()
      this.applyDisplayName(displayName)
      this.refreshSession()
      // Les droits de messagerie ne sont connus qu'après l'entrée dans la salle.
      this.attachChat(client)
      this.setConnection('connected')
    } catch (error) {
      this.client = null
      this.detachSessionListeners()
      this.setConnection('disconnected')
      this.recordError(error)
      throw error
    }
  }

  async leave(): Promise<void> {
    const client = this.client
    this.detachSessionListeners()
    this.client = null

    if (client) {
      try {
        await client.leave()
      } catch {
        // Une sortie déjà effectuée côté serveur n'est pas une erreur pour l'utilisateur.
      }
    }

    this.session = emptySessionState(this.session.maxParticipants)
    this.chat = EMPTY_CHAT_STATE
    this.setConnection('disconnected')
    this.emitSession()
    this.emitChat()
  }

  async setMicrophoneEnabled(enabled: boolean): Promise<void> {
    const self = this.client?.self
    if (!self) return

    try {
      if (enabled) await self.enableAudio()
      else await self.disableAudio()
    } catch (error) {
      this.recordError(error)
    }
    this.refreshSession()
  }

  async setCameraEnabled(enabled: boolean): Promise<void> {
    const self = this.client?.self
    if (!self) return

    try {
      if (enabled) await self.enableVideo()
      else await self.disableVideo()
    } catch (error) {
      this.recordError(error)
    }
    this.refreshSession()
  }

  async setScreenShareEnabled(enabled: boolean): Promise<void> {
    const self = this.client?.self
    if (!self) return

    try {
      if (enabled) await self.enableScreenShare()
      else await self.disableScreenShare()
    } catch (error) {
      this.recordError(error)
    }
    this.refreshSession()
  }

  /**
   * Applique un effet au flux vidéo publié.
   * Le traitement est local : il ne touche ni la piste audio, ni le partage
   * d'écran, ni les flux des autres participants.
   */
  async setVideoEffect(
    effect: VideoEffectId,
    onRuntimeFailure?: (message: string) => void,
  ): Promise<void> {
    const self = this.client?.self
    if (!self) return
    await applyVideoEffect(self, effect, onRuntimeFailure)
  }

  // -------------------------------------------------------------------------
  // Interne
  // -------------------------------------------------------------------------

  /**
   * Demande un jeton de participation.
   * Si la session organisateur a expiré, l'entrée se poursuit en invité plutôt
   * que d'échouer : l'utilisateur peut toujours rejoindre sa propre réunion.
   */
  private async requestCredential(displayName: string) {
    const { realtimeKitId, role, hostToken } = this.options
    // Identifiant stable par navigateur et par réunion : une reconnexion
    // réutilise le même emplacement dans la salle.
    const guestId = realtimeKitId ? getOrCreateGuestId(realtimeKitId) : ''

    try {
      const credential = await requestParticipantToken({
        meetingId: realtimeKitId as string,
        displayName,
        guestId,
        role,
        hostToken: role === 'host' ? hostToken : null,
      })
      this.effectiveRole = credential.role
      this.session = { ...this.session, maxParticipants: credential.maxParticipants }
      return credential
    } catch (error) {
      if (role === 'host' && error instanceof MeetingApiError && error.needsHostAccess) {
        const credential = await requestParticipantToken({
          meetingId: realtimeKitId as string,
          displayName,
          guestId,
          role: 'guest',
          hostToken: null,
        })
        this.effectiveRole = 'guest'
        this.session = { ...this.session, maxParticipants: credential.maxParticipants }
        this.recordError(
          new MeetingApiError({
            status: 401,
            code: 'host-session-expired',
            message:
              "Votre session organisateur a expiré : vous êtes entré comme invité. Reconnectez-vous en organisateur pour retrouver les droits d'hôte.",
          }),
        )
        return credential
      }
      throw error
    }
  }

  /** Abonne la messagerie de la salle et charge l'historique déjà échangé. */
  private attachChat(client: RTKClient): void {
    this.chat = {
      ...EMPTY_CHAT_STATE,
      ...readChatPermissions(client),
      maxTextLength: readMaxTextLength(client),
    }

    const onChatUpdate = () => this.refreshChat(client)
    client.chat.on('chatUpdate', onChatUpdate)
    this.detachers.push(() => client.chat.removeListener('chatUpdate', onChatUpdate))

    this.emitChat()
    void this.loadChatHistory(client)
  }

  /**
   * Historique des messages publics déjà envoyés dans la réunion.
   * Un échec n'est pas bloquant : les messages suivants arrivent par l'événement
   * `chatUpdate`, et le panneau reste utilisable.
   */
  private async loadChatHistory(client: RTKClient): Promise<void> {
    if (!this.chat.available) return

    try {
      const history = (await client.chat.fetchPublicMessages({
        limit: CHAT_HISTORY_LIMIT,
        direction: 'before',
      })) as unknown as ChatMessageLike[]

      const selfUserId = readSelfUserId(client)
      const incoming = (history ?? [])
        .map((message) => toChatView(message, selfUserId))
        .filter((message): message is ChatMessageView => message !== null)

      this.setChat({ messages: mergeChatMessages(this.chat.messages, incoming) })
    } catch {
      // Historique indisponible : le chat en direct reste fonctionnel.
    }
  }

  /** Recopie l'état des messages du SDK dans l'instantané exposé à l'interface. */
  private refreshChat(client: RTKClient): void {
    const selfUserId = readSelfUserId(client)
    const messages = (client.chat.messages as unknown as ChatMessageLike[] | undefined) ?? []
    const incoming = messages
      .map((message) => toChatView(message, selfUserId))
      .filter((message): message is ChatMessageView => message !== null)

    this.setChat({ messages: mergeChatMessages(this.chat.messages, incoming) })
  }

  private setChat(patch: Partial<ChatState>): void {
    this.chat = { ...this.chat, ...patch }
    this.emitChat()
  }

  private emitChat(): void {
    for (const listener of this.chatListeners) listener(this.chat)
  }

  private applyDisplayName(displayName: string): void {
    try {
      this.client?.self.setName(displayName)
    } catch {
      // Le nom transmis au serveur reste celui du jeton : l'affichage distant
      // peut conserver l'ancienne valeur, sans conséquence sur la réunion.
    }
  }

  private attachSessionListeners(client: RTKClient): void {
    const refresh = () => this.refreshSession()

    const onRoomJoined = () => this.setConnection('connected')
    const onRoomLeft = (payload: { state: string }) => {
      const message = LEFT_STATE_MESSAGES[payload?.state ?? '']
      if (message) {
        this.session = { ...this.session, error: { code: payload.state, message, canRetry: true } }
      }
      this.setConnection(payload?.state === 'disconnected' ? 'reconnecting' : 'disconnected')
      this.refreshSession()
    }

    client.self.on('roomJoined', onRoomJoined)
    client.self.on('roomLeft', onRoomLeft)
    // Toute mutation (média local, participants, partage) rafraîchit
    // l'instantané : le SDK est la seule source de vérité.
    client.self.on('*', refresh)
    client.participants.joined.on('*', refresh)

    this.detachers.push(
      () => client.self.removeListener('roomJoined', onRoomJoined),
      () => client.self.removeListener('roomLeft', onRoomLeft),
      () => client.self.removeListener('*', refresh),
      () => client.participants.joined.removeListener('*', refresh),
    )
  }

  private detachSessionListeners(): void {
    for (const detach of this.detachers.splice(0)) {
      try {
        detach()
      } catch {
        // Le client est peut-être déjà détruit : rien à faire.
      }
    }
  }

  private refreshSession(): void {
    const client = this.client

    if (!client) {
      this.session = { ...emptySessionState(this.session.maxParticipants), connection: this.state.connection }
      this.emitSession()
      return
    }

    const self = client.self
    const remote = client.participants.joined.toArray()

    const participants: ParticipantView[] = [
      {
        id: self.id,
        name: self.name || this.options.displayName,
        isLocal: true,
        isHost: this.effectiveRole === 'host',
        audioEnabled: self.audioEnabled,
        videoEnabled: self.videoEnabled,
        screenShareEnabled: self.screenShareEnabled,
      },
      ...remote.map((participant) => toParticipantView(participant)),
    ]

    const sharingRemote = remote.find((participant) => participant.screenShareEnabled)
    const screenShare = self.screenShareEnabled
      ? { participantId: self.id, participantName: self.name || this.options.displayName, isLocal: true }
      : sharingRemote
        ? { participantId: sharingRemote.id, participantName: sharingRemote.name, isLocal: false }
        : null

    this.session = {
      connection: this.state.connection,
      maxParticipants: this.session.maxParticipants,
      participants,
      remoteCount: remote.length,
      self: {
        audioEnabled: self.audioEnabled,
        videoEnabled: self.videoEnabled,
        screenShareEnabled: self.screenShareEnabled,
        hasAudioTrack: Boolean(self.audioTrack),
        hasVideoTrack: Boolean(self.videoTrack),
      },
      screenShare,
      error: this.session.error,
    }

    this.emitSession()
  }

  private recordError(error: unknown): void {
    this.session = { ...this.session, error: describeSessionError(error) }
    this.emitSession()
  }

  private setConnection(connection: TransportState['connection']): void {
    if (this.state.connection === connection) {
      this.session = { ...this.session, connection }
      return
    }

    this.state = { ...this.state, connection }
    for (const listener of this.stateListeners) listener(this.state)
    this.session = { ...this.session, connection }
    this.emitSession()
  }

  private emitSession(): void {
    for (const listener of this.sessionListeners) listener(this.session)
  }
}

/** Identifiant d'utilisateur local, utilisé pour distinguer ses propres messages. */
function readSelfUserId(client: RTKClient): string {
  try {
    return client.self.userId ?? ''
  } catch {
    return ''
  }
}

/** Limite de longueur annoncée par le SDK (bornée pour l'affichage). */
function readMaxTextLength(client: RTKClient): number {
  try {
    const limit = client.chat.maxTextLimit
    return Number.isFinite(limit) && limit > 0 ? Math.min(limit, 2000) : FALLBACK_MAX_TEXT_LENGTH
  } catch {
    return FALLBACK_MAX_TEXT_LENGTH
  }
}

/**
 * Droits de messagerie du profil de participant.
 * Ils sont lus dans le preset : le panneau n'annonce jamais un chat utilisable
 * quand le profil l'interdit.
 */
function readChatPermissions(
  client: RTKClient,
): Pick<ChatState, 'available' | 'canSend' | 'unavailableReason'> {
  try {
    const chat = client.self.permissions?.chatPublic

    if (!chat) {
      return {
        available: false,
        canSend: false,
        unavailableReason: "La messagerie n’est pas disponible pour le moment.",
      }
    }

    if (!chat.text) {
      return {
        available: false,
        canSend: false,
        unavailableReason:
          "Les messages écrits ne sont pas activés pour cette réunion. L’organisateur peut les autoriser.",
      }
    }

    return {
      available: true,
      canSend: chat.canSend,
      unavailableReason: chat.canSend
        ? null
        : "Vous pouvez lire les messages, mais l’envoi n’est pas autorisé dans cette réunion.",
    }
  } catch {
    return {
      available: false,
      canSend: false,
      unavailableReason: "La messagerie n’est pas disponible pour le moment.",
    }
  }
}

/** Horodatage d'un message, en millisecondes. */
function messageTime(message: ChatMessageLike): number {
  if (typeof message.timeMs === 'number' && Number.isFinite(message.timeMs)) return message.timeMs
  if (message.time instanceof Date) return message.time.getTime()
  return Date.now()
}

/** Traduit un message du SDK en vue affichable, ou `null` s'il n'est pas textuel. */
function toChatView(message: ChatMessageLike, selfUserId: string): ChatMessageView | null {
  if (message.type !== 'text') return null

  const text = (message.message ?? '').trim()
  if (text.length === 0) return null

  // Message adressé à certains participants : il n'apparaît pas dans le canal
  // public du panneau.
  if (Array.isArray(message.targetUserIds) && message.targetUserIds.length > 0) return null

  return {
    id: message.id,
    authorName: message.displayName?.trim() || 'Participant',
    isLocal: message.userId === selfUserId,
    sentAt: messageTime(message),
    text,
  }
}

/** Fusion sans doublon (les messages peuvent arriver par l'historique et par événement). */
function mergeChatMessages(
  current: ChatMessageView[],
  incoming: ChatMessageView[],
): ChatMessageView[] {
  const byId = new Map<string, ChatMessageView>()
  for (const message of [...current, ...incoming]) byId.set(message.id, message)
  return [...byId.values()].sort((a, b) => a.sentAt - b.sentAt)
}

function toParticipantView(participant: RTKParticipant): ParticipantView {
  return {
    id: participant.id,
    name: participant.name || 'Participant',
    isLocal: false,
    isHost: participant.isHost,
    audioEnabled: participant.audioEnabled,
    videoEnabled: participant.videoEnabled,
    screenShareEnabled: participant.screenShareEnabled,
  }
}
