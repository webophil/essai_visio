/**
 * Messages affichés dans l'interface.
 * Ils décrivent l'état **réel** de l'application : ce qui fonctionne, ce qui est
 * volontairement hors périmètre, et ce qui dépend d'une action de
 * l'organisateur. Rien n'y est présenté comme actif à tort.
 */
export const NOTICES = {
  /** Invitation */
  inviteLink:
    "Toute personne qui possède ce lien peut rejoindre la réunion. Aucun compte n'est nécessaire côté invité.",
  inviteLinkHostOnly:
    "Ce lien est celui de la réunion Cloudflare. Il ne contient aucun jeton : chaque participant reçoit le sien au moment de rejoindre.",

  /** Capacité */
  capacity:
    "Une réunion accueille cinq personnes au maximum, organisateur compris. Le contrôle est effectué côté serveur, au moment où un participant rejoint.",

  /** Audio */
  audioPlayback:
    "Cliquez dans la page (ou sur le bouton) pour autoriser la lecture du son : votre navigateur ne l'a pas lancée de lui-même.",

  /** Partage d'écran */
  screenShareNote:
    "Votre écran est transmis à tous les participants. Votre caméra reste visible en vignette pendant le partage.",

  /** Chat */
  chat: "Les messages ne sont pas conservés après la réunion.",
  chatUnavailable:
    "Les messages écrits ne sont pas activés pour cette réunion. L’organisateur peut les autoriser.",

  /** Effets de fond */
  backgroundEffects:
    "Le flou s'applique à votre flux vidéo avant sa diffusion : seuls les participants voient le résultat, votre caméra locale n'est pas modifiée.",
  backgroundBlurUnsupported:
    "Si votre navigateur ne prend pas en charge ce traitement, le flou n'est pas activé : votre caméra reste diffusée normalement, sans effet et sans message d'erreur technique.",

  /** Matériel */
  deviceFallback:
    "Si votre navigateur refuse l'accès au matériel, vous pouvez malgré tout rejoindre la réunion pour écouter et partager votre écran.",
} as const
