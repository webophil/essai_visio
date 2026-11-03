import type RTKClient from '@cloudflare/realtimekit'
import type { RTKParticipant } from '@cloudflare/realtimekit'
import { RealtimeKitContext } from '@cloudflare/realtimekit-react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { RTKSelf } from '@cloudflare/realtimekit'

import { ChatPanel } from '../src/components/meeting/ChatPanel'
import { ParticipantsPanel } from '../src/components/meeting/ParticipantsPanel'
import { MeetingStage } from '../src/components/meeting/MeetingStage'
import {
  RemoteScreenShare,
  RtkParticipantVideo,
  RtkSelfVideo,
} from '../src/components/meeting/RtkVideoSurface'
import { RemoteAudioSinks } from '../src/components/meeting/RemoteAudio'
import {
  COMPACT_TILE_CLASS,
  PRESENTATION_STAGE_CLASS,
  SIDE_PANEL_CLASS,
  WAITING_BANNER_CLASS,
  presentationSurfaceClass,
  stageColumns,
  stageGridClass,
  stageTileClass,
} from '../src/components/meeting/layout'
import { MeetingContext } from '../src/state/meetingContext'
import type { MeetingContextValue } from '../src/state/meetingContext'
import { MeetingScreen } from '../src/components/screens/MeetingScreen'
import { UnknownRouteScreen } from '../src/components/screens/UnknownRouteScreen'
import { WelcomeScreen } from '../src/components/screens/WelcomeScreen'
import { remoteAudioTracks } from '../src/media/remoteAudio'
import { CHAT_BOTTOM_THRESHOLD, isScrolledToBottom } from '../src/lib/chatScroll'
import { createMeetingId, generateUuid, isRealtimeKitId, meetingDisplayName, parseMeetingInput } from '../src/lib/ids'
import { mediaFailure } from '../src/lib/mediaErrors'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

import {
  BLUR_ENGINE_SCRIPT_URL,
  VideoEffectError,
  applyPersonMask,
  applyVideoEffect,
  applyVideoEffectWith,
  maskOpacity,
  maskSizeFor,
  maskValueForPixel,
  normalizedFrameSize,
  normalizedWorkSize,
  readVideoEffectStats,
} from '../src/media/backgroundBlur'
import { DEFAULT_MEETING_TITLE, MAX_MEETING_TITLE_LENGTH, normalizeMeetingTitle } from '../src/lib/meetingTitle'
import { MeetingApiError } from '../src/meeting/rtkApi'
import { describeChatError, describeSessionError } from '../src/meeting/rtkErrors'
import {
  buildInvitationUrl,
  buildMeetingUrl,
  formatClockTime,
  formatDuration,
  meetingPath,
  parseMeetingLink,
} from '../src/lib/format'
import { parsePath, readRealtimeKitId } from '../src/lib/router'

const checks: { name: string; run: () => void | Promise<void> }[] = []

function expect(condition: boolean, label: string) {
  if (!condition) throw new Error(`ÉCHEC : ${label}`)
  console.log(`  ok  ${label}`)
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

const UUID = '497f6eca-6276-4993-bfeb-53cbbbba6f08'

// --- Routeur -------------------------------------------------------------
checks.push({
  name: 'routeur',
  run: () => {
    expect(parsePath('/').name === 'welcome', '« / » → accueil')
    expect(parsePath('/rdv-aurore').name === 'meeting', '« /rdv-aurore » → réunion')
    const route = parsePath('/rdv-aurore')
    expect(route.name === 'meeting' && route.meetingId === 'aurore', 'identifiant extrait')
    expect(parsePath('/rdv-').name === 'unknown', 'identifiant vide rejeté')
    const trailing = parsePath('/rdv-aurore/')
    expect(
      trailing.name === 'meeting' && trailing.meetingId === 'aurore',
      'barre oblique finale tolérée',
    )
    expect(parsePath('/rdv-ab').name === 'meeting', 'identifiant de 2 caractères accepté')
    expect(parsePath('/inconnu').name === 'unknown', 'route inconnue détectée')

    const withLink = parsePath('/rdv-aurore', `?r=${UUID}`)
    expect(
      withLink.name === 'meeting' && withLink.realtimeKitId === UUID,
      'identifiant Cloudflare lu depuis le lien',
    )
    const badLink = parsePath('/rdv-aurore', '?r=pas-un-uuid')
    expect(
      badLink.name === 'meeting' && badLink.realtimeKitId === null,
      'identifiant Cloudflare invalide ignoré',
    )
    expect(readRealtimeKitId(`?autre=1&r=${UUID}`) === UUID, 'paramètre retrouvé parmi d’autres')
    expect(readRealtimeKitId('') === null, 'aucun paramètre → null')
  },
})

// --- Identifiants --------------------------------------------------------
checks.push({
  name: 'identifiants',
  run: () => {
    expect(parseMeetingInput('aurore') === 'aurore', 'identifiant simple')
    expect(parseMeetingInput('rdv-aurore') === 'aurore', 'préfixe rdv- retiré')
    expect(parseMeetingInput('/rdv-aurore') === 'aurore', 'chemin interne accepté')
    expect(
      parseMeetingInput('https://visio.phildev.online/rdv-aurore?x=1') === 'aurore',
      'URL complète avec paramètres',
    )
    expect(parseMeetingInput('   ') === null, 'saisie vide rejetée')
    expect(parseMeetingInput('!!') === null, 'caractères invalides rejetés')
    expect(meetingPath('aurore') === '/rdv-aurore', 'chemin de réunion')

    const generated = createMeetingId()
    expect(generated.length === 7, 'identifiant généré de 7 caractères')
    expect(/^[a-z0-9]+$/.test(generated), 'identifiant généré alphanumérique')
    expect(createMeetingId() !== generated, 'deux identifiants générés diffèrent')
    expect(meetingDisplayName('aurore') === 'Aurore', 'nom affiché capitalisé')
    expect(
      meetingDisplayName('visio-client-dupont') === 'Visio Client Dupont',
      'nom affiché multi-mots',
    )

    expect(isRealtimeKitId(UUID), 'UUID Cloudflare reconnu')
    expect(!isRealtimeKitId('rdv-aurore'), 'identifiant lisible refusé comme UUID')
    expect(!isRealtimeKitId(null), 'valeur absente refusée')

    const uuid = generateUuid()
    expect(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid),
      'UUID v4 généré conforme',
    )
    expect(generateUuid() !== uuid, 'deux UUID générés diffèrent')
  },
})

// --- Formatage -----------------------------------------------------------
checks.push({
  name: 'formatage',
  run: () => {
    expect(formatDuration(0) === '00:00', 'durée nulle')
    expect(formatDuration(252_000) === '04:12', 'durée en minutes')
    expect(formatDuration(3_852_000) === '01:04:12', 'durée avec heures')
    expect(formatDuration(-5000) === '00:00', 'durée négative bornée')
    expect(
      buildMeetingUrl('aurore', 'https://visio.phildev.online/') ===
        'https://visio.phildev.online/rdv-aurore',
      'URL publique sans identifiant Cloudflare',
    )
    expect(
      buildInvitationUrl('aurore', UUID, 'https://visio.phildev.online/') ===
        `https://visio.phildev.online/rdv-aurore?r=${UUID}`,
      'lien d’invitation complet',
    )

    expect(formatClockTime(new Date(2026, 0, 5, 14, 7).getTime()) === '14:07', 'heure d’un message')
    expect(formatClockTime(new Date(2026, 0, 5, 9, 3, 30).getTime()) === '09:03', 'heure à un chiffre complétée')
    expect(formatClockTime(Number.NaN) === '--:--', 'horodatage invalide neutre')
  },
})

// --- Nom de la réunion ---------------------------------------------------
checks.push({
  name: 'nom de réunion',
  run: () => {
    expect(normalizeMeetingTitle('') === DEFAULT_MEETING_TITLE, 'champ vide → nom par défaut')
    expect(normalizeMeetingTitle('   ') === DEFAULT_MEETING_TITLE, 'espaces seuls → nom par défaut')
    expect(normalizeMeetingTitle(undefined) === DEFAULT_MEETING_TITLE, 'absence → nom par défaut')
    expect(
      normalizeMeetingTitle('  Rendez-vous   Aurore Studer ') === 'Rendez-vous Aurore Studer',
      'espaces réduits',
    )
    expect(
      normalizeMeetingTitle('x'.repeat(200)).length === MAX_MEETING_TITLE_LENGTH,
      'longueur bornée',
    )
    expect(DEFAULT_MEETING_TITLE === 'Réunion PhilDEV', 'nom par défaut attendu par l’interface')
  },
})

// --- Flou d'arrière-plan -------------------------------------------------
checks.push({
  name: 'flou d’arrière-plan',
  run: () => {
    expect(
      normalizedWorkSize(1280, 720).width === 480 && normalizedWorkSize(1280, 720).height === 270,
      'plan de travail réduit à 480 px de large',
    )
    expect(
      normalizedWorkSize(320, 240).width === 320 && normalizedWorkSize(320, 240).height === 240,
      'petite image conservée telle quelle',
    )
    const odd = normalizedWorkSize(641, 361)
    expect(odd.width % 2 === 0 && odd.height % 2 === 0, 'dimensions paires (pas de couture)')
    expect(normalizedWorkSize(0, 0).width === 0, 'image absente → aucun traitement')

    // Géométrie du flux publié : déduite de la piste, rapport d'image conservé.
    const hd = normalizedFrameSize(1280, 720)
    expect(hd.width === 1280 && hd.height === 720, '1280×720 conservé')
    const uhd = normalizedFrameSize(2560, 1440)
    expect(uhd.width === 1280 && uhd.height === 720, '1440p ramené à 1280×720')
    const vga = normalizedFrameSize(640, 480)
    expect(vga.width === 640 && vga.height === 480, '640×480 conservé')
    expect(normalizedFrameSize(0, 0).width === 1280, 'taille inconnue → valeur sûre')

    // Le masque suit le rapport d'image de la vidéo, jamais un 16:9 figé.
    const wideMask = maskSizeFor(1280, 720)
    expect(wideMask.width === 160 && wideMask.height === 90, 'masque 16:9 pour une vidéo 16:9')
    const squareMask = maskSizeFor(1000, 1000)
    expect(squareMask.width === 160 && squareMask.height === 160, 'masque carré pour une vidéo carrée')

    // Le moteur doit être servi par l'application : jamais un CDN.
    expect(
      BLUR_ENGINE_SCRIPT_URL.startsWith('/vendor/mediapipe/selfie_segmentation/'),
      'moteur servi depuis notre propre origine',
    )
    expect(
      BLUR_ENGINE_SCRIPT_URL.endsWith('/selfie_segmentation.js'),
      'script du moteur identifié',
    )

    // Régression réelle (Phase 2.1) : importé dans le bundle, ce paquet ne
    // publie **aucun** export ES — `import { SelfieSegmentation }` valait
    // `undefined`, le middleware levait et le SDK republiait la piste brute en
    // répondant « succès ». Chargé comme un script classique, il publie bien
    // son constructeur sur l'objet global.
    const engineSource = readFileSync(
      new URL(
        '../node_modules/@mediapipe/selfie_segmentation/selfie_segmentation.js',
        import.meta.url,
      ),
      'utf8',
    )
    const sandbox: Record<string, unknown> = { console }
    vm.runInNewContext(engineSource, sandbox, { filename: 'selfie_segmentation.js' })
    expect(
      typeof sandbox.SelfieSegmentation === 'function',
      'le script du moteur publie son constructeur global',
    )
  },
})

// --- Masque de segmentation ----------------------------------------------
checks.push({
  name: 'masque de segmentation',
  run: () => {
    // MediaPipe écrit `vec4(m, 0, 0, m)` : rouge et alpha portent la même valeur.
    expect(maskValueForPixel(255, 255) === 255, 'personne lue à 255 (rouge = alpha)')
    expect(maskValueForPixel(0, 0) === 0, 'fond lu à 0')
    expect(maskValueForPixel(128, 128) === 128, 'contour progressif conservé')
    expect(maskValueForPixel(200, 255) === 200, 'alpha aplati → rouge utilisé')

    // La rampe rend le premier plan totalement net sans toucher au flou du fond.
    expect(maskOpacity(0) === 0, 'fond → totalement transparent')
    expect(maskOpacity(255) === 255, 'personne → totalement opaque')
    expect(maskOpacity(26) === 0, 'bruit de fond éliminé')
    expect(maskOpacity(153) === 255, 'silhouette franche rendue nette à 60 %')

    // Masque synthétique 8×8 : silhouette 4×4 au centre, fond autour.
    const size = 8
    const mask = new Uint8ClampedArray(size * size * 4)
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const index = (y * size + x) * 4
        const inPerson = x >= 2 && x < 6 && y >= 2 && y < 6
        // Encodage réel de MediaPipe : [m, 0, 0, m]
        mask[index] = inPerson ? 255 : 0
        mask[index + 3] = inPerson ? 255 : 0
      }
    }

    const stats = applyPersonMask(mask)
    expect(Math.abs(stats.coverage - 0.25) < 0.001, 'couverture = 25 % de l’image')
    // Diagnostic de format : 25 % de pixels à 255 ⇒ moyenne brute de 64.
    expect(stats.redMean === 64, 'moyenne du rouge exposée (64)')
    expect(stats.alphaMean === 64, 'moyenne de l’alpha exposée (64)')

    const alphaAt = (x: number, y: number) => mask[(y * size + x) * 4 + 3]
    expect(alphaAt(4, 4) === 255, 'centre → premier plan opaque')
    expect(alphaAt(0, 0) === 0, 'coin → arrière-plan')
    expect(alphaAt(2, 2) === 255, 'bord de la silhouette conservé')

    // Composition de référence : la personne nette recouvre le fond flou.
    const sharp = 200
    const blurred = 40
    const compose = (alpha: number) => Math.round((sharp * alpha + blurred * (255 - alpha)) / 255)
    expect(compose(alphaAt(4, 4)) === sharp, 'centre : image nette, pas le fond flou')
    expect(compose(alphaAt(0, 0)) === blurred, 'coin : fond flou conservé')
    expect(compose(alphaAt(7, 7)) === blurred, 'second coin : fond flou conservé')
  },
})

// --- Application de l'effet vidéo ----------------------------------------
checks.push({
  name: 'application du flou',
  run: async () => {
    /** Faux support média : le SDK y répond « succès » quoi qu'il arrive. */
    const createFakeMedia = (silentFallback: boolean) => {
      const raw = { id: 'raw-track' } as unknown as MediaStreamTrack
      const processed = { id: 'processed-track' } as unknown as MediaStreamTrack
      let applied = false
      let removals = 0
      let ownsCanvas = false

      return {
        media: {
          videoEnabled: true,
          async setVideoMiddlewareGlobalConfig(config: { disablePerFrameCanvasRendering: boolean }) {
            ownsCanvas = config.disablePerFrameCanvasRendering === true
          },
          get videoTrack() {
            return applied && !silentFallback ? processed : raw
          },
          get rawVideoTrack() {
            return raw
          },
          async addVideoMiddleware() {
            applied = true
            return { success: true, message: 'Successfully added the middleware.' }
          },
          async removeVideoMiddleware() {
            applied = false
            removals += 1
            return { success: true, message: 'Successfully removed the middleware.' }
          },
        },
        removals: () => removals,
        ownsCanvas: () => ownsCanvas,
      }
    }

    const createFakeRenderer = async () => ({
      attach: async () => {},
      detach: () => {},
      stats: () => ({
        imagesReceived: 3,
        personCoverage: 0.4,
        maskRedMean: 64,
        maskAlphaMean: 64,
        imagesBlurred: 3,
        masks: 2,
        imagesPerSecond: 20,
        masksPerSecond: 14,
        lastImageAgoMs: 50,
        frameWidth: 1280,
        frameHeight: 720,
      }),
      dispose: () => {},
    })

    // Cas réellement observé en Phase 2.1 : le SDK répond « succès », garde le
    // middleware, mais republie la piste brute (sa fabrication a échoué en
    // silence). L'interface affichait alors « Flou · Actif » sans effet.
    const silent = createFakeMedia(true)
    let rejection: unknown = null
    try {
      await applyVideoEffectWith(silent.media, 'blur', createFakeRenderer)
    } catch (error) {
      rejection = error
    }

    expect(rejection instanceof VideoEffectError, 'piste brute non substituée → échec explicite')
    expect(
      rejection instanceof Error && rejection.message.includes("n'a pas appliqué"),
      'message explicite pour l’utilisateur',
    )
    expect(silent.removals() === 1, 'middleware retiré après échec')
    expect(readVideoEffectStats() === null, 'aucun rendu fantôme conservé')

    const working = createFakeMedia(false)
    await applyVideoEffectWith(working.media, 'blur', createFakeRenderer)
    expect(readVideoEffectStats()?.imagesBlurred === 3, 'compteurs de traitement exposés')
    expect(
      working.ownsCanvas(),
      'le canvas est piloté par le traitement (géométrie de la piste)',
    )
    await applyVideoEffect(working.media, 'none')
    expect(readVideoEffectStats() === null, '« Aucun effet » libère le traitement')
    expect(working.removals() === 1, 'middleware retiré explicitement')
  },
})

// --- Mise en page de la réunion ------------------------------------------
checks.push({
  name: 'mise en page',
  run: () => {
    expect(stageColumns(1) === 1, '1 vignette → 1 colonne')
    expect(stageColumns(2) === 2 && stageColumns(4) === 2, '2 à 4 vignettes → 2 colonnes')
    expect(stageColumns(5) === 3, '5 vignettes → 3 colonnes sur grand écran')

    const grid = stageGridClass(4)
    expect(grid.includes('auto-rows-fr'), 'lignes de hauteur égale')
    expect(grid.includes('min-h-0') && grid.includes('min-w-0'), 'la scène ne dicte pas sa taille')
    expect(grid.includes('overflow-hidden'), 'aucun débordement de la scène')
    expect(!grid.includes('min-h-40'), 'aucune hauteur minimale fixe sur la scène')
    expect(stageGridClass(5).includes('lg:grid-cols-3'), '5 participants → 3 colonnes')

    // Vignettes en grille : dimensions issues de la grille uniquement.
    const gridTile = stageTileClass(3)
    expect(gridTile.includes('min-h-0'), 'vignette sans hauteur imposée')
    expect(gridTile.includes('min-w-0'), 'vignette sans largeur imposée')
    expect(gridTile.includes('h-full') && gridTile.includes('w-full'), 'la vignette remplit sa cellule')
    expect(!gridTile.includes('min-h-40'), 'plus de hauteur minimale sur la vignette')
    expect(COMPACT_TILE_CLASS.includes('aspect-video'), 'vignette compacte en 16:9')

    // Mode présentation : surface dédiée, jamais une cellule de grille.
    expect(
      PRESENTATION_STAGE_CLASS.includes('flex-1') &&
        PRESENTATION_STAGE_CLASS.includes('min-h-0') &&
        PRESENTATION_STAGE_CLASS.includes('overflow-hidden'),
      'scène de présentation bornée par l’espace disponible',
    )
    expect(
      presentationSurfaceClass(false).includes('size-full') &&
        presentationSurfaceClass(false).includes('min-h-0'),
      'surface de partage plein cadre',
    )
    expect(
      presentationSurfaceClass(true).includes('fixed inset-0') &&
        presentationSurfaceClass(true).includes('z-50'),
      'repli plein écran sans API Fullscreen',
    )

    // Panneau : largeur fixe, non compressible et non extensible.
    expect(SIDE_PANEL_CLASS.includes('lg:w-[22rem]'), 'largeur fixe sur ordinateur')
    expect(
      SIDE_PANEL_CLASS.includes('lg:min-w-[22rem]') && SIDE_PANEL_CLASS.includes('lg:max-w-[22rem]'),
      'largeur non compressible par un message long',
    )
    expect(SIDE_PANEL_CLASS.includes('min-w-0'), 'le contenu ne peut pas élargir le panneau')
    expect(SIDE_PANEL_CLASS.includes('overflow-hidden'), 'panneau borné, défilement interne')

    // Rendu réel du panneau de chat avec un message d'un seul « mot » très long.
    const longWord = 'x'.repeat(600)
    const context = {
      closePanel: () => {},
      chat: {
        available: true,
        canSend: true,
        sending: false,
        error: null,
        unavailableReason: null,
        maxTextLength: 1000,
        messages: [
          {
            id: 'm1',
            text: longWord,
            authorName: 'Aurore',
            isLocal: false,
            sentAt: Date.now(),
          },
        ],
      },
      sendChatMessage: async () => true,
    } as unknown as MeetingContextValue

    const html = renderToStaticMarkup(
      <MeetingContext.Provider value={context}>
        <ChatPanel />
      </MeetingContext.Provider>,
    )

    expect(html.includes('lg:w-[22rem]'), 'panneau rendu à largeur fixe')
    expect(html.includes('overflow-wrap:anywhere'), 'mot très long renvoyé à la ligne')
    expect(html.includes('break-words'), 'césure autorisée dans les bulles')
    expect(html.includes('min-w-0'), 'bulles et en-têtes compressibles')
    expect(
      /aria-label="Messages de la réunion"[^>]*overflow-y-auto/.test(html),
      'la liste des messages défile dans le panneau',
    )
    expect(html.includes(longWord), 'message long rendu intégralement')

    // --- Disposition de la scène ------------------------------------------
    // Seul : une seule vignette, centrée, dans un cadre 16:9 borné.
    const one = stageGridClass(1)
    expect(one.includes('grid-cols-1'), 'seul → une seule colonne')
    expect(one.includes('place-items-center'), 'seul → vignette centrée')
    expect(one.includes('h-full'), 'scène de hauteur explicite (1 participant)')
    expect(!one.includes('auto-rows-fr'), 'seul → aucune répartition en plusieurs lignes')

    const oneTile = stageTileClass(1)
    expect(oneTile.includes('stage-frame'), 'seul → cadre 16:9 dimensionné par la scène')
    expect(!oneTile.includes('h-full'), 'seul → la vignette ne s’étire pas sur toute la hauteur')
    expect(!oneTile.includes('col-span') && !oneTile.includes('row-span'), 'seul → aucune cellule réservée')

    // À deux : deux colonnes dès que la largeur le permet.
    const two = stageGridClass(2)
    expect(two.includes('h-full'), 'scène de hauteur explicite (2 participants)')
    expect(two.includes('sm:grid-cols-2'), '2 participants → côte à côte sur écran large')
    expect(two.includes('auto-rows-fr'), '2 participants → une seule ligne, hauteur répartie')

    const twoTile = stageTileClass(2)
    expect(twoTile.includes('h-full') && twoTile.includes('w-full'), '2 participants → chaque vignette occupe sa colonne')
    expect(!twoTile.includes('aspect-video'), '2 participants → pas de cadre 16:9 forcé qui rétrécit l’image')
    expect(!twoTile.includes('object-cover'), '2 participants → aucun recadrage imposé par le cadre')

    // Trois à cinq : grille équilibrée et responsive.
    expect(stageGridClass(3).includes('sm:grid-cols-2'), '3 participants → 2 colonnes')
    expect(stageGridClass(5).includes('lg:grid-cols-3'), '5 participants → 3 colonnes')
    expect(stageTileClass(4).includes('h-full'), 'grille → la vignette remplit la hauteur de sa cellule')

    // L'emplacement vide est un bandeau, jamais une cellule de grille.
    expect(WAITING_BANNER_CLASS.includes('shrink-0'), 'bandeau d’attente compact')
    expect(
      !WAITING_BANNER_CLASS.includes('col-span') &&
        !WAITING_BANNER_CLASS.includes('row-span') &&
        !WAITING_BANNER_CLASS.includes('grid'),
      'l’attente ne réserve aucune cellule de la scène',
    )

    // --- La scène réelle : une seule vignette, aucune cellule réservée ------
    const stageClient = {
      self: {
        videoEnabled: true,
        audioEnabled: true,
        screenShareEnabled: false,
        registerVideoElement: () => {},
        deregisterVideoElement: () => {},
      },
      participants: { joined: { toArray: () => [] } },
    }

    const stageContext = {
      participantName: 'Aurore',
      setScreenShareEnabled: async () => {},
    } as unknown as MeetingContextValue

    const stageHtml = renderToStaticMarkup(
      <RealtimeKitContext.Provider
        value={{ meeting: stageClient, updates: undefined } as unknown as React.ContextType<
          typeof RealtimeKitContext
        >}
      >
        <MeetingContext.Provider value={stageContext}>
          <MeetingStage />
        </MeetingContext.Provider>
      </RealtimeKitContext.Provider>,
    )

    const gridIndex = stageHtml.indexOf('stage-area')
    const bannerIndex = stageHtml.indexOf('En attente des participants')
    expect(gridIndex > 0, 'scène rendue avec son cadre mesuré')
    expect(bannerIndex > 0 && bannerIndex < gridIndex, 'l’attente est rendue hors de la grille')
    expect(
      !stageHtml.slice(gridIndex).includes('border-dashed'),
      'aucune cellule d’attente dans la grille',
    )
    expect(
      stageHtml.split('Votre flux vidéo').length - 1 === 1,
      'seul → exactement une vignette, celle du participant local',
    )

    // --- Partage : scène de présentation automatique -----------------------
    const sharingParticipant = {
      id: 'share-1',
      name: 'Aurore',
      videoEnabled: true,
      audioEnabled: true,
      isHost: false,
      screenShareEnabled: true,
      screenShareTracks: null,
      audioTrack: null,
      registerVideoElement: () => {},
      deregisterVideoElement: () => {},
      on: () => {},
      removeListener: () => {},
    } as unknown as RTKParticipant

    const sharingClient = {
      self: {
        ...stageClient.self,
        screenShareTracks: null,
        on: () => {},
        removeListener: () => {},
      },
      participants: { joined: { toArray: () => [sharingParticipant] } },
    }

    const sharingHtml = renderToStaticMarkup(
      <RealtimeKitContext.Provider
        value={{ meeting: sharingClient, updates: undefined } as unknown as React.ContextType<
          typeof RealtimeKitContext
        >}
      >
        <MeetingContext.Provider value={stageContext}>
          <MeetingStage />
        </MeetingContext.Provider>
      </RealtimeKitContext.Provider>,
    )

    expect(sharingHtml.includes('Mode présentation'), 'le partage ouvre la présentation automatique')
    expect(sharingHtml.includes('Écran partagé par Aurore'), 'le partageur est identifié')
    expect(sharingHtml.includes('Masquer les caméras'), 'les caméras peuvent être masquées')
    expect(sharingHtml.includes('Agrandir le partage'), 'commande de plein écran présente')
    expect(sharingHtml.includes('presentation-surface'), 'surface de partage dédiée')
    expect(!sharingHtml.includes('stage-area'), 'le partage ne passe pas par la grille des caméras')
    expect(sharingHtml.includes('object-contain'), 'le partage conserve son ratio sans recadrage')
    expect(sharingHtml.includes('aspect-video'), 'les caméras passent en vignettes compactes')

    // Les utilitaires CSS qui portent le cadre et la mesure de la scène.
    const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
    expect(/@utility stage-area \{[^}]*container-type: size/.test(css), 'scène mesurable (container-type)')
    expect(
      /@utility stage-frame \{[^}]*aspect-ratio: 16 \/ 9/.test(css),
      'cadre 16:9 défini en CSS',
    )
    expect(/@utility stage-frame \{[^}]*min\(100cqw, 177\.78cqh\)/.test(css), 'cadre borné par la scène')

    // --- Les médias ne dictent jamais la taille des cadres -----------------
    const selfStub = {
      registerVideoElement: () => {},
      deregisterVideoElement: () => {},
    } as unknown as RTKSelf

    const selfHtml = renderToStaticMarkup(
      <RtkSelfVideo
        self={selfStub}
        enabled
        label="Votre caméra"
        className="size-full"
        placeholder={<span>caméra coupée</span>}
      />,
    )
    expect(selfHtml.includes('absolute inset-0'), 'aperçu local hors du flux')
    expect(selfHtml.includes('object-contain'), 'aperçu local entier, sans recadrage')

    const participantStub = {
      id: 'p2',
      name: 'Aurore',
      videoEnabled: true,
      audioEnabled: true,
      isHost: false,
      screenShareTracks: null,
      registerVideoElement: () => {},
      deregisterVideoElement: () => {},
      on: () => {},
      removeListener: () => {},
    } as unknown as RTKParticipant

    const remoteHtml = renderToStaticMarkup(
      <RtkParticipantVideo
        participant={participantStub}
        enabled
        label="Flux vidéo de Aurore"
        className="size-full"
        placeholder={<span>en attente</span>}
      />,
    )
    expect(remoteHtml.includes('absolute inset-0'), 'vidéo distante hors du flux')
    expect(remoteHtml.includes('object-contain'), 'vidéo distante entière, sans recadrage')

    const shareHtml = renderToStaticMarkup(
      <RemoteScreenShare
        participant={participantStub}
        label="Écran partagé"
        className="min-h-0 flex-1"
        placeholder={<span>écran</span>}
      />,
    )
    expect(shareHtml.includes('object-contain'), 'partage d’écran sans recadrage')
    expect(shareHtml.includes('absolute inset-0'), 'partage d’écran hors du flux')
    expect(/<video[^>]*muted/.test(shareHtml), 'partage visuel non bloqué par la lecture automatique')
  },
})

// --- Analyse d'un lien d'invitation --------------------------------------
checks.push({
  name: 'lien d’invitation',
  run: () => {
    const full = parseMeetingLink(`https://visio.phildev.online/rdv-aurore?r=${UUID}`)
    expect(
      full !== null && full.meetingId === 'aurore' && full.realtimeKitId === UUID,
      'lien complet analysé',
    )

    const bare = parseMeetingLink('rdv-aurore')
    expect(bare !== null && bare.meetingId === 'aurore' && bare.realtimeKitId === null, 'identifiant seul accepté')

    const invalidLink = parseMeetingLink('https://visio.phildev.online/rdv-aurore?r=xyz')
    expect(
      invalidLink !== null && invalidLink.realtimeKitId === null,
      'paramètre invalide neutralisé',
    )

    expect(parseMeetingLink('   ') === null, 'saisie vide rejetée')
    expect(parseMeetingLink('!!!') === null, 'saisie invalide rejetée')
  },
})

// --- Erreurs : API et périphériques --------------------------------------
checks.push({
  name: 'erreurs',
  run: () => {
    const invalidToken = describeSessionError({ code: '0004', name: 'ClientError' })
    expect(invalidToken.canRetry, 'jeton invalide : nouvelle tentative proposée')
    expect(
      invalidToken.message.includes('plus valide'),
      'jeton invalide : message explicite',
    )

    const unsupported = describeSessionError({ code: '0010' })
    expect(!unsupported.canRetry, 'navigateur non pris en charge : pas de relance')
    expect(unsupported.message.includes('navigateur'), 'message orienté navigateur')

    const network = describeSessionError({ code: '0012' })
    expect(network.canRetry, 'coupure réseau : relance possible')

    const denied = describeSessionError(new DOMException('refus', 'NotAllowedError'))
    expect(
      denied.message.includes('refusé') && denied.canRetry,
      'permission refusée traduite en français',
    )

    const busy = describeSessionError(new DOMException('occupé', 'NotReadableError'))
    expect(busy.message.includes('déjà utilisé'), 'périphérique occupé expliqué')

    const full = describeSessionError(
      new MeetingApiError({ status: 409, code: 'meeting-full', message: 'Réunion complète' }),
    )
    expect(!full.canRetry, 'réunion complète : relance inutile')
    expect(full.message === 'Réunion complète', 'message du serveur conservé')

    const unauthorized = describeSessionError(
      new MeetingApiError({ status: 401, code: 'host-unauthorized', message: 'Accès requis' }),
    )
    expect(!unauthorized.canRetry, 'refus d\u2019autorisation : pas de relance automatique')

    const offline = describeSessionError(
      new MeetingApiError({ status: 0, code: 'network', message: 'Serveur injoignable' }),
    )
    expect(offline.canRetry && offline.message.includes('injoignable'), 'réseau absent expliqué')

    const unknown = describeSessionError(undefined)
    expect(unknown.code === 'unknown' && unknown.canRetry, 'erreur inconnue traitée')

    expect(mediaFailure('permission-denied').canRetry, 'échec matériel : permission réessayable')
    expect(
      mediaFailure('unsupported').canRetry === false,
      'API média absente : aucune relance proposée',
    )
    expect(mediaFailure('no-device').title.includes('Aucun périphérique'), 'matériel absent expliqué')

    expect(
      describeChatError({ code: '1101' }).includes('autorisé à envoyer'),
      'chat refusé par le profil expliqué',
    )
    expect(describeChatError({ code: '0013' }).includes('Trop de messages'), 'limite de débit expliquée')
    expect(
      describeChatError({ code: '0012' }).includes('connexion'),
      'coupure pendant l’envoi expliquée',
    )
    expect(describeChatError(undefined).includes('Réessayez'), 'échec inconnu : message actionnable')
  },
})

// --- Audio des participants distants -------------------------------------
checks.push({
  name: 'audio distant',
  run: () => {
    const track = (id: string) => ({ id }) as MediaStreamTrack

    const speaking = remoteAudioTracks({ audioEnabled: true, audioTrack: track('voix-a') })
    expect(
      speaking.length === 1 && speaking[0].id === 'voix-a',
      'micro actif → une piste restituée',
    )

    const muted = remoteAudioTracks({ audioEnabled: false, audioTrack: track('voix-b') })
    expect(muted.length === 0, 'micro coupé → aucune piste restituée')

    const noTrackYet = remoteAudioTracks({ audioEnabled: true, audioTrack: null })
    expect(noTrackYet.length === 0, 'piste pas encore reçue → rien à restituer')

    const sharing = remoteAudioTracks({
      audioEnabled: true,
      audioTrack: track('voix-c'),
      screenShareEnabled: true,
      screenShareTracks: { audio: track('son-partage') },
    })
    expect(
      sharing.length === 2 && sharing.some((item) => item.id === 'son-partage'),
      'son du partage d’écran ajouté à la voix',
    )

    const duplicated = remoteAudioTracks({
      audioEnabled: true,
      audioTrack: track('voix-d'),
      screenShareEnabled: true,
      screenShareTracks: { audio: track('voix-d') },
    })
    expect(duplicated.length === 1, 'une même piste n’est jamais restituée deux fois')

    const sharingMuted = remoteAudioTracks({
      audioEnabled: false,
      audioTrack: track('voix-e'),
      screenShareEnabled: true,
      screenShareTracks: { audio: track('son-partage-2') },
    })
    expect(
      sharingMuted.length === 1 && sharingMuted[0].id === 'son-partage-2',
      'partage sonore audible malgré un micro coupé',
    )

    const noShareAudio = remoteAudioTracks({
      audioEnabled: true,
      audioTrack: track('voix-f'),
      screenShareEnabled: true,
      screenShareTracks: null,
    })
    expect(noShareAudio.length === 1, 'partage sans son → voix seule')
  },
})

// --- Sortie audio montée dans la salle -----------------------------------
checks.push({
  name: 'sortie audio des participants',
  run: () => {
    const guest = (id: string) =>
      ({
        id,
        name: id,
        isHost: false,
        audioEnabled: true,
        videoEnabled: false,
        screenShareEnabled: false,
      }) as unknown as RTKParticipant

    const withParticipants = (participants: RTKParticipant[]) =>
      ({
        participants: { joined: { toArray: () => participants } },
      }) as unknown as RTKClient

    const render = (participants: RTKParticipant[]) =>
      renderToStaticMarkup(
        <RealtimeKitContext.Provider
          value={{ meeting: withParticipants(participants), updates: undefined }}
        >
          <RemoteAudioSinks />
        </RealtimeKitContext.Provider>,
      )

    const twoGuests = render([guest('invite-1'), guest('invite-2')])
    expect(countOf(twoGuests, '<audio') === 2, 'un élément de lecture par participant distant')
    // React émet `autoPlay` en SSR ; la casse n'a pas d'importance, seule la
    // présence de la demande de lecture compte.
    expect(/autoplay/i.test(twoGuests), 'lecture automatique demandée sur chaque sortie')
    expect(!twoGuests.includes('muted'), 'aucune sortie distante n’est coupée')
    expect(!twoGuests.includes('Activer le son'), 'aucun avertissement sans blocage constaté')

    const alone = render([])
    expect(countOf(alone, '<audio') === 0, 'personne à écouter → aucune sortie')
  },
})

// --- Rendu des écrans ----------------------------------------------------
checks.push({
  name: 'écran d’accueil',
  run: () => {
    const html = renderToStaticMarkup(<WelcomeScreen onJoinMeeting={() => {}} />)
    expect(html.includes('Bienvenue sur votre'), 'titre d’accueil présent')
    expect(html.includes('rendez-vous visio'), 'titre d’accueil complet')
    expect(html.includes('Espace de rendez-vous PhilDEV'), 'sur-titre d’accueil')
    expect(html.includes('Échange en visio'), 'carte « échange en visio »')
    expect(html.includes('Partage d’écran'), 'carte « partage d’écran »')
    expect(html.includes('Accès simple'), 'carte « accès simple »')
    expect(html.includes('espace de rendez-vous'), 'footer discret')
    expect(!html.includes('RealtimeKit'), 'aucune mention technique visible')
    expect(!html.includes('visio.phildev.online'), 'aucune cible de déploiement affichée')
    expect(html.includes('Créer une réunion'), 'bouton de création')
    expect(html.includes('Rejoindre'), 'bouton rejoindre')
    expect(html.includes('Lien d’invitation'), 'champ de lien')
    expect(html.includes('Accès organisateur'), 'accès protégé de l’organisateur')
    expect(html.includes('Nom de la réunion'), 'champ du nom de réunion')
    expect(html.includes(DEFAULT_MEETING_TITLE), 'nom de réunion par défaut proposé')
    expect(html.includes('PhilDEV'), 'marque PhilDEV')
    expect(html.includes('Visio'), 'marque Visio')
    expect(html.includes('lang="fr"') === false, 'aucun attribut parasite')
    expect(html.length > 2000, 'markup non trivial')
  },
})

checks.push({
  name: 'salle de réunion',
  run: () => {
    const remote = (index: number) => ({
      id: `invite-${index}`,
      name: `Invité ${index}`,
      videoEnabled: true,
      audioEnabled: true,
      isHost: false,
      screenShareEnabled: false,
      screenShareTracks: null,
      audioTrack: null,
      registerVideoElement: () => {},
      deregisterVideoElement: () => {},
      on: () => {},
      removeListener: () => {},
    })

    const renderRoom = (remoteCount: number) => {
      const remotes = Array.from({ length: remoteCount }, (_, index) => remote(index + 1))
      const roomClient = {
        self: {
          videoEnabled: true,
          audioEnabled: true,
          screenShareEnabled: false,
          registerVideoElement: () => {},
          deregisterVideoElement: () => {},
        },
        participants: {
          joined: { toArray: () => remotes, on: () => {}, removeListener: () => {} },
        },
      } as unknown as RTKClient

      const roomContext = {
        meetingId: 'aurore',
        meetingName: 'Rendez-vous Aurore',
        realtimeKitId: UUID,
        durationMs: 3_725_000,
        activePanel: null,
        session: {
          participants: [{ id: 'self' }, ...remotes.map((participant) => ({ id: participant.id }))],
          error: null,
        },
        transport: { mode: 'realtimekit', connection: 'connected', supportsRemoteParticipants: true },
        participantName: 'Aurore',
        setScreenShareEnabled: async () => {},
        isHost: true,
        clearSessionError: () => {},
        leaveMeeting: async () => {},
        setMicrophoneEnabled: async () => {},
        setCameraEnabled: async () => {},
        client: roomClient,
      } as unknown as MeetingContextValue

      return renderToStaticMarkup(
        <MeetingContext.Provider value={roomContext}>
          <MeetingScreen />
        </MeetingContext.Provider>,
      )
    }

    // `buildInvitationUrl` lit l'origine du navigateur au rendu : un substitut
    // minimal suffit pour le rendu serveur du test.
    const scope = globalThis as unknown as { window?: unknown }
    const previousWindow = scope.window
    scope.window = { location: { origin: 'https://visio.test' } }

    try {
      const waiting = renderRoom(0)
      expect(waiting.includes('Rendez-vous Aurore'), 'nom de réunion affiché')
      expect(waiting.includes('Organisateur'), 'statut organisateur')
      expect(waiting.includes('Copier le lien'), 'bouton de copie du lien')
      expect(waiting.includes('Participants') && waiting.includes('Chat'), 'commandes conservées')
      expect(waiting.includes('Quitter'), 'commande de sortie conservée')
      expect(!waiting.includes('/>rdv-') && !waiting.includes('>/rdv-'), 'aucun identifiant technique dans l’en-tête')
      expect(!waiting.includes('cinq personnes'), 'aucune limite de participants dans le pied de page')
      expect(!waiting.includes('contrôle est effectué côté serveur'), 'aucune explication de contrôle serveur')
      expect(!waiting.includes('Cloudflare'), 'aucune mention technique dans la salle')
      expect(!waiting.includes('Effets'), 'bouton « Effets » masqué')
      expect(waiting.includes('En attente des participants'), 'bandeau d’attente simplifié')
      expect(
        waiting.includes('Partagez le lien de réunion pour les inviter.'),
        'invitation à partager le lien',
      )

      const joined = renderRoom(1)
      expect(!joined.includes('En attente des participants'), 'le bandeau disparaît dès qu’un invité rejoint')
    } finally {
      if (previousWindow === undefined) delete scope.window
      else scope.window = previousWindow
    }
  },
})

checks.push({
  name: 'panneau de chat',
  run: () => {
    const renderChat = (
      available: boolean,
      messages: { id: string; text: string; authorName: string; isLocal: boolean; sentAt: number }[] = [],
    ) => {
      const context = {
        closePanel: () => {},
        chat: {
          available,
          canSend: available,
          sending: false,
          error: null,
          unavailableReason: available
            ? null
            : 'Les messages écrits ne sont pas activés pour cette réunion. L’organisateur peut les autoriser.',
          maxTextLength: 500,
          messages,
        },
        sendChatMessage: async () => true,
      } as unknown as MeetingContextValue

      return renderToStaticMarkup(
        <MeetingContext.Provider value={context}>
          <ChatPanel />
        </MeetingContext.Provider>,
      )
    }

    const empty = renderChat(true)
    expect(empty.includes('Chat'), 'titre du panneau')
    expect(empty.includes('Aucun message'), 'état vide lisible')
    expect(empty.includes('Écrire un message…'), 'champ de saisie disponible')
    expect(empty.includes('Entrée pour envoyer'), 'aide d’envoi simplifiée')
    expect(!empty.includes('caractères.'), 'compteur de caractères retiré de l’aide')
    expect(
      empty.includes('Les messages ne sont pas conservés après la réunion.'),
      'mention discrète de conservation',
    )
    expect(!empty.includes('Messages non conservés'), 'encadré de conservation retiré')

    const blocked = renderChat(false)
    expect(blocked.includes('Chat indisponible'), 'état indisponible annoncé')
    expect(
      blocked.includes('L’organisateur peut les autoriser'),
      'raison de l’indisponibilité compréhensible',
    )

    const visible = `${empty}${blocked}`
    expect(!visible.includes('Cloudflare'), 'aucune mention de Cloudflare')
    expect(!visible.includes('RealtimeKit'), 'aucune mention de RealtimeKit')
    expect(!visible.includes('SDK'), 'aucune mention du SDK')
    expect(!visible.includes('profil de participant'), 'aucun jargon de profil de participant')

    // Ancrage en bas et ordre chronologique du fil.
    const thread = renderChat(true, [
      { id: 'm1', text: 'Premier message', authorName: 'Aurore', isLocal: false, sentAt: 1 },
      { id: 'm2', text: 'Second message', authorName: 'Aurore', isLocal: false, sentAt: 2 },
    ])
    expect(thread.includes('mt-auto'), 'le fil est ancré au bas de la zone')
    expect(
      thread.indexOf('Premier message') < thread.indexOf('Second message'),
      'ordre chronologique conservé dans le DOM',
    )
    expect(thread.includes('aria-live="polite"'), 'annonces accessibles conservées')

    // Décision de suivi : en bas (tolérance incluse) vs remontée volontaire.
    expect(
      isScrolledToBottom({ scrollTop: 500, scrollHeight: 1000, clientHeight: 500 }),
      'liste en bas → suivi du dernier message',
    )
    expect(
      isScrolledToBottom({ scrollTop: 480, scrollHeight: 1000, clientHeight: 500 }),
      'proximité immédiate du bas → suivi conservé',
    )
    expect(
      !isScrolledToBottom({ scrollTop: 300, scrollHeight: 1000, clientHeight: 500 }),
      'remontée volontaire → aucun retour forcé en bas',
    )
    expect(
      !isScrolledToBottom({
        scrollTop: 1000 - 500 - CHAT_BOTTOM_THRESHOLD - 1,
        scrollHeight: 1000,
        clientHeight: 500,
      }),
      'juste au-delà de la tolérance → pas de suivi',
    )
  },
})

checks.push({
  name: 'panneau des participants',
  run: () => {
    const context = {
      closePanel: () => {},
      session: {
        maxParticipants: 5,
        participants: [
          {
            id: 'self',
            name: 'Aurore',
            isHost: true,
            isLocal: true,
            audioEnabled: true,
            videoEnabled: false,
            screenShareEnabled: false,
          },
        ],
      },
    } as unknown as MeetingContextValue

    const html = renderToStaticMarkup(
      <MeetingContext.Provider value={context}>
        <ParticipantsPanel />
      </MeetingContext.Provider>,
    )

    expect(html.includes('Participants'), 'titre du panneau')
    expect(html.includes('1 participant sur 5'), 'compteur de participants conservé')
    expect(html.includes('En attente des invités…'), 'message d’attente simplifié')
    expect(html.includes('Aurore'), 'nom du participant affiché')
    expect(html.includes('Micro actif') && html.includes('Caméra coupée'), 'indicateurs média conservés')
    expect(!html.includes('Capacité de la réunion'), 'encadré de capacité retiré')
    expect(!html.includes('contrôle est effectué côté serveur'), 'aucune explication de contrôle serveur')
  },
})

checks.push({
  name: 'route inconnue',
  run: () => {
    const html = renderToStaticMarkup(<UnknownRouteScreen path="/inconnu" onGoHome={() => {}} />)
    expect(html.includes('Page introuvable'), 'titre de page introuvable')
    expect(html.includes('/inconnu'), 'chemin affiché')
  },
})

let failures = 0
for (const check of checks) {
  console.log(`\n▶ ${check.name}`)
  try {
    await check.run()
  } catch (error) {
    failures += 1
    console.error(`  ✗ ${(error as Error).message}`)
  }
}

console.log(`\n${checks.length - failures}/${checks.length} groupes de vérifications réussis`)
if (failures > 0) process.exit(1)
