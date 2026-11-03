import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { MessageSquare, Send } from 'lucide-react'

import { Button } from '../ui/Button'
import { Notice } from '../ui/Notice'
import { SidePanel } from '../ui/SidePanel'
import { isScrolledToBottom } from '../../lib/chatScroll'
import { formatClockTime } from '../../lib/format'
import { NOTICES } from '../../lib/notices'
import { useMeeting } from '../../state/meetingContext'
import type { ChatMessageView } from '../../types/meeting'

/**
 * Messagerie de réunion.
 *
 * Les messages circulent entre les participants connectés et ne sont ni
 * enregistrés ni relus après la réunion. Quand l'envoi n'est pas autorisé, le
 * panneau l'annonce explicitement et conserve un champ désactivé plutôt que
 * d'afficher une saisie sans effet.
 */
export function ChatPanel() {
  const { closePanel, chat, sendChatMessage } = useMeeting()
  const [draft, setDraft] = useState('')
  const listRef = useRef<HTMLDivElement | null>(null)
  // Vrai tant que l'utilisateur n'a pas remonté le fil volontairement.
  const stickToBottom = useRef(true)

  // Suit le dernier message uniquement si la liste était déjà en bas : remonter
  // pour relire d'anciens messages ne provoque aucun saut à la réception.
  useEffect(() => {
    const node = listRef.current
    if (!node || !stickToBottom.current) return
    node.scrollTop = node.scrollHeight
  }, [chat.messages.length])

  const handleScroll = () => {
    const node = listRef.current
    if (!node) return
    stickToBottom.current = isScrolledToBottom(node)
  }

  const canWrite = chat.available && chat.canSend
  const busy = chat.sending

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const text = draft.trim()
    if (text.length === 0 || !canWrite || busy) return

    // Le brouillon n'est effacé qu'une fois le message accepté par le SDK :
    // un échec laisse la saisie intacte pour réessayer.
    const sent = await sendChatMessage(text)
    if (sent) {
      // Envoyer est un geste explicite : on revient au dernier message, même si
      // l'utilisateur lisait plus haut.
      stickToBottom.current = true
      requestAnimationFrame(() => {
        const node = listRef.current
        if (node) node.scrollTop = node.scrollHeight
      })
      setDraft((current) => (current.trim() === text ? '' : current))
    }
  }

  return (
    <SidePanel
      title="Chat"
      icon={MessageSquare}
      onClose={closePanel}
      footer={
        <form className="flex flex-col gap-2" onSubmit={(event) => void handleSubmit(event)}>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={draft}
              maxLength={chat.maxTextLength}
              disabled={!canWrite}
              enterKeyHint="send"
              aria-label="Votre message"
              placeholder={canWrite ? 'Écrire un message…' : 'Chat indisponible'}
              className="h-11 min-w-0 flex-1 rounded-xl border border-ink-600 bg-ink-850 px-3 text-base text-slate-100 placeholder:text-slate-500 focus:border-accent-500 focus:outline-none disabled:cursor-not-allowed disabled:text-slate-500 sm:text-sm"
              onChange={(event) => setDraft(event.target.value)}
            />
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              className="h-11"
              disabled={!canWrite || busy || draft.trim().length === 0}
              aria-label="Envoyer le message"
            >
              <Send aria-hidden="true" className="size-4" />
            </Button>
          </div>

          <p className="text-[11px] leading-relaxed text-slate-500">
            {canWrite ? 'Entrée pour envoyer' : 'La saisie est désactivée : aucun message ne peut être envoyé.'}
          </p>
        </form>
      }
    >
      <div className="flex h-full flex-col gap-3">
        {chat.available ? null : (
          <Notice tone="warning" title="Chat indisponible">
            {chat.unavailableReason ?? NOTICES.chatUnavailable}
          </Notice>
        )}

        {chat.error ? (
          <Notice tone="danger" title="Message non envoyé">
            {chat.error}
          </Notice>
        ) : null}

        {chat.messages.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-ink-600 px-4 py-10 text-center">
            <MessageSquare aria-hidden="true" className="size-6 text-slate-500" />
            <p className="text-sm font-medium text-slate-300">Aucun message</p>
            {chat.available ? null : (
              <p className="max-w-xs text-xs leading-relaxed text-slate-500">
                Ce panneau restera vide tant que les messages ne sont pas autorisés.
              </p>
            )}
          </div>
        ) : (
          <div
            ref={listRef}
            role="log"
            aria-live="polite"
            aria-label="Messages de la réunion"
            onScroll={handleScroll}
            className="flex min-h-0 flex-1 flex-col overflow-y-auto pr-0.5"
          >
            {/* `mt-auto` : avec peu de messages, le fil se pose au bas de la
                zone ; dès qu'il dépasse, l'ordre chronologique reprend et le
                défilement reste interne. */}
            <div className="mt-auto flex flex-col gap-2.5">
              {chat.messages.map((message) => (
                <ChatBubble key={message.id} message={message} />
              ))}
            </div>
          </div>
        )}

        <p className="text-[11px] leading-relaxed text-slate-500">{NOTICES.chat}</p>
      </div>
    </SidePanel>
  )
}

function ChatBubble({ message }: { message: ChatMessageView }) {
  return (
    <article
      className={[
        // `min-w-0` : sans lui, un mot très long élargit la bulle, puis le
        // panneau, puis comprime la scène vidéo.
        'flex min-w-0 max-w-[92%] flex-col gap-0.5 rounded-xl px-3 py-2',
        message.isLocal
          ? 'self-end border border-accent-500/40 bg-accent-500/10'
          : 'self-start border border-ink-600 bg-ink-850',
      ].join(' ')}
    >
      <header className="flex min-w-0 items-baseline gap-2">
        <span className="truncate text-xs font-semibold text-white">
          {message.isLocal ? 'Vous' : message.authorName}
        </span>
        <time
          dateTime={new Date(message.sentAt).toISOString()}
          className="shrink-0 font-mono text-[10px] text-slate-500 tabular-nums"
        >
          {formatClockTime(message.sentAt)}
        </time>
      </header>
      <p className="text-sm leading-relaxed break-words whitespace-pre-wrap [overflow-wrap:anywhere] text-slate-100">
        {message.text}
      </p>
    </article>
  )
}
