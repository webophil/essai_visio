import { useRealtimeKitSelector } from '@cloudflare/realtimekit-react'
import {
  MessageSquare,
  Mic,
  MicOff,
  MonitorOff,
  MonitorUp,
  PhoneOff,
  Users,
  Video,
  VideoOff,
  WandSparkles,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { ControlButton } from '../ui/ControlButton'
import { useMeeting } from '../../state/meetingContext'
import type { SidePanelId } from '../../types/meeting'

/**
 * Barre de contrôle de la réunion.
 * Chaque bouton reflète un état **réel du SDK** : les bascules agissent sur les
 * pistes publiées, jamais sur une intention locale.
 */
export function ControlBar() {
  const {
    session,
    activePanel,
    togglePanel,
    leaveMeeting,
    setMicrophoneEnabled,
    setCameraEnabled,
    setScreenShareEnabled,
  } = useMeeting()

  const microphoneOn = useRealtimeKitSelector((client) => client.self.audioEnabled)
  const cameraOn = useRealtimeKitSelector((client) => client.self.videoEnabled)
  const sharing = useRealtimeKitSelector((client) => client.self.screenShareEnabled)

  const participantCount = session.participants.length

  const panelButton = (panel: SidePanelId, label: string, icon: LucideIcon, badge?: string) => (
    <ControlButton
      icon={icon}
      label={label}
      badge={badge}
      pressed={activePanel === panel}
      onClick={() => togglePanel(panel)}
    />
  )

  return (
    <div className="surface-panel flex flex-wrap items-center justify-center gap-2 rounded-2xl p-2.5 sm:gap-2.5 sm:p-3">
      <ControlButton
        icon={microphoneOn ? Mic : MicOff}
        label={microphoneOn ? 'Micro' : 'Micro coupé'}
        pressed={microphoneOn}
        off={!microphoneOn}
        onClick={() => void setMicrophoneEnabled(!microphoneOn)}
      />

      <ControlButton
        icon={cameraOn ? Video : VideoOff}
        label={cameraOn ? 'Caméra' : 'Caméra coupée'}
        pressed={cameraOn}
        off={!cameraOn}
        onClick={() => void setCameraEnabled(!cameraOn)}
      />

      <ControlButton
        icon={sharing ? MonitorOff : MonitorUp}
        label={sharing ? 'Arrêter le partage' : 'Partager l’écran'}
        pressed={sharing}
        highlighted={sharing}
        title={
          sharing
            ? 'Arrêter le partage d’écran'
            : 'Partager un écran, une fenêtre ou un onglet (le navigateur propose les sources)'
        }
        onClick={() => void setScreenShareEnabled(!sharing)}
      />

      <span aria-hidden="true" className="mx-1 hidden h-10 w-px bg-ink-700 sm:block" />

      {panelButton('participants', 'Participants', Users, String(participantCount))}
      {panelButton('chat', 'Chat', MessageSquare)}
      {panelButton('effects', 'Effets', WandSparkles)}

      <span aria-hidden="true" className="mx-1 hidden h-10 w-px bg-ink-700 sm:block" />

      <ControlButton
        icon={PhoneOff}
        label="Quitter"
        tone="danger"
        onClick={() => void leaveMeeting()}
      />
    </div>
  )
}
