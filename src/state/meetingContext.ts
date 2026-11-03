import type RTKClient from '@cloudflare/realtimekit'
import { createContext, useContext } from 'react'

import type { RtkMediaController } from '../media/useRtkMedia'
import type {
  ChatState,
  MeetingSessionState,
  SessionError,
  SessionPhase,
  SidePanelId,
  TransportState,
  VideoEffectId,
} from '../types/meeting'

export interface MeetingContextValue {
  /** Identifiant lisible de la réunion (route `/rdv-…`). */
  meetingId: string
  /** Nom affiché de la réunion. */
  meetingName: string
  /** Identifiant de réunion Cloudflare, `null` si le lien est incomplet. */
  realtimeKitId: string | null

  phase: SessionPhase
  joining: boolean
  durationMs: number

  /** Erreur d'entrée en réunion (jeton refusé, réunion complète, réseau…). */
  joinError: SessionError | null
  clearJoinError: () => void

  participantName: string
  setParticipantName: (name: string) => void

  activePanel: SidePanelId | null
  togglePanel: (panel: SidePanelId) => void
  closePanel: () => void

  joinMeeting: () => Promise<void>
  leaveMeeting: () => Promise<void>

  /** Matériel local, capturé une seule fois par le SDK (écran de préparation). */
  media: RtkMediaController
  toggleAudio: (enabled: boolean) => Promise<void>
  toggleVideo: (enabled: boolean) => Promise<void>

  /** État du transport (mode, connexion). */
  transport: TransportState
  /** Instantané de la session temps réel : participants, médias, erreurs. */
  session: MeetingSessionState

  /** Chat de la réunion (messagerie native RealtimeKit, sans stockage). */
  chat: ChatState
  /** Envoie un message aux participants connectés (`true` si accepté). */
  sendChatMessage: (text: string) => Promise<boolean>

  /** Effet vidéo local actif (aucun effet par défaut). */
  videoEffect: VideoEffectId
  /** Active ou retire un effet vidéo ; l'échec est exposé par `videoEffectError`. */
  setVideoEffect: (effect: VideoEffectId) => Promise<void>
  videoEffectBusy: boolean
  videoEffectError: string | null

  /** Vrai si la session locale est bien celle de l'organisateur. */
  isHost: boolean

  setMicrophoneEnabled: (enabled: boolean) => Promise<void>
  setCameraEnabled: (enabled: boolean) => Promise<void>
  setScreenShareEnabled: (enabled: boolean) => Promise<void>
  clearSessionError: () => void

  /** Client RealtimeKit, disponible uniquement pendant la réunion. */
  client: RTKClient | null
}

export const MeetingContext = createContext<MeetingContextValue | null>(null)

export function useMeeting(): MeetingContextValue {
  const context = useContext(MeetingContext)

  if (!context) {
    throw new Error("useMeeting doit être utilisé à l'intérieur d'un MeetingProvider")
  }

  return context
}
