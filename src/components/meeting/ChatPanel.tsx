import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import { FileDown, Loader2, MessageSquare, Paperclip, Send } from 'lucide-react'

import { Button } from '../ui/Button'
import { Notice } from '../ui/Notice'
import { SidePanel } from '../ui/SidePanel'
import { isScrolledToBottom } from '../../lib/chatScroll'
import { formatClockTime, formatFileSize } from '../../lib/format'
import { NOTICES } from '../../lib/notices'
import { useMeeting } from '../../state/meetingContext'
import type { ChatAttachmentView, ChatMessageView } from '../../types/meeting'

/**
 * Messagerie de réunion.
 *
 * Les messages circulent entre les participants connectés et ne sont ni
 * enregistrés ni relus après la réunion. Un fichier peut y être joint : il
 * passe par la réunion elle-même, jamais par notre serveur, et se télécharge
 * via un lien réservé à ses participants.
 *
 * Quand l'envoi n'est pas autorisé, le panneau l'annonce explicitement et
 * conserve un champ désactivé plutôt que d'afficher une saisie sans effet.
 */
export function ChatPanel() {
  const { closePanel, chat, sendChatMessage, sendChatFile } = useMeeting()
  const [draft, setDraft] = useState('')
  const listRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  // Vrai tant que l'utilisateur n'a pas remonté le fil volontairement.
  const stickToBottom = useRef(true)

  const scrollToBottom = () => {
    requestAnimationFrame(() => {
      const node = listRef.current
      if (node) node.scrollTop = node.scrollHeight
    })
  }

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
  const canAttach = chat.available && chat.canSendFiles
  const busy = chat.sending
  const attaching = chat.sendingFile

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
      scrollToBottom()
      setDraft((current) => (current.trim() === text ? '' : current))
    }
  }

  const handlePickFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    // Le champ est vidé aussitôt : renvoyer deux fois le même fichier reste
    // possible, et un fichier refusé ne reste pas sélectionné.
    event.target.value = ''
    if (!file || !canAttach || attaching) return

    const sent = await sendChatFile(file)
    if (sent) {
      stickToBottom.current = true
      scrollToBottom()
    }
  }

  return (
    <SidePanel
      title="Chat"
      icon={MessageSquare}
      onClose={closePanel}
      footer={
        <form className="flex flex-col gap-2" onSubmit={(event) => void handleSubmit(event)}>
          <input
            ref={fileInputRef}
            type="file"
            className="sr-only"
            aria-hidden="true"
            tabIndex={-1}
            onChange={(event) => void handlePickFile(event)}
          />

          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-11 w-11 shrink-0 px-0"
              disabled={!canAttach || attaching}
              aria-label="Joindre un fichier"
              title={
                canAttach
                  ? `Joindre un fichier (${formatFileSize(chat.maxFileBytes)} maximum)`
                  : "L'envoi de fichiers n'est pas autorisé dans cette réunion."
              }
              onClick={() => fileInputRef.current?.click()}
            >
              {attaching ? (
                <Loader2 aria-hidden="true" className="size-4 animate-spin" />
              ) : (
                <Paperclip aria-hidden="true" className="size-4" />
              )}
            </Button>

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

        {chat.fileError ? (
          <Notice tone="danger" title="Fichier non envoyé">
            {chat.fileError}
          </Notice>
        ) : null}

        {chat.messages.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-ink-600 px-4 py-10 text-center">
            <MessageSquare aria-hidden="true" className="size-6 text-slate-500" />
            <p className="text-sm font-medium text-slate-300">Aucun message</p>
            {chat.available ? (
              canAttach ? (
                <p className="max-w-xs text-xs leading-relaxed text-slate-500">
                  Vous pouvez aussi joindre un fichier : il sera téléchargeable par les participants.
                </p>
              ) : null
            ) : (
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

      {message.kind === 'file' ? (
        <FileAttachment file={message.file} />
      ) : (
        <p className="text-sm leading-relaxed break-words whitespace-pre-wrap [overflow-wrap:anywhere] text-slate-100">
          {message.text}
        </p>
      )}
    </article>
  )
}

/**
 * Fichier joint : nom, taille et lien de téléchargement.
 * Le lien est fourni par la réunion ; il s'ouvre dans un nouvel onglet pour ne
 * pas interrompre la visio. La taille est affichée seulement si l'expéditeur
 * l'a annoncée.
 */
function FileAttachment({ file }: { file: ChatAttachmentView }) {
  return (
    <a
      href={file.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Télécharger ${file.name}`}
      className="flex min-w-0 items-center gap-2.5 rounded-lg border border-ink-600 bg-ink-900/60 px-2.5 py-2 transition-colors hover:border-accent-500/50 hover:bg-ink-800"
    >
      <FileDown aria-hidden="true" className="size-4 shrink-0 text-accent-300" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium text-slate-100 [overflow-wrap:anywhere]">
          {file.name}
        </span>
        <span className="font-mono text-[10px] text-slate-400 tabular-nums">
          {file.bytes > 0 ? formatFileSize(file.bytes) : 'Télécharger'}
        </span>
      </span>
    </a>
  )
}
