/**
 * En-têtes HTTP de sécurité, appliqués à **toutes** les réponses du Worker :
 * API, assets statiques, 404 et repli SPA.
 *
 * La politique CSP est désormais **bloquante** (`CSP_ENFORCED = true`). Elle a
 * été recoupée avec les hôtes réellement présents dans le bundle publié :
 * `api.realtime.cloudflare.com`, le signaling `wss://*.realtime.cloudflare.com`,
 * et les domaines `dyte.in` / `dyte.io` que le SDK RealtimeKit (bâti sur Dyte)
 * porte encore dans son code comme cibles historiques.
 *
 * Retour arrière : repasser `CSP_ENFORCED` à `false` et redéployer. La politique
 * complète redevient alors un simple rapport, sans blocage.
 *
 * HSTS est activé : le domaine personnalisé `visio.phildev.online` est validé
 * et servi en HTTPS depuis le 20/10/2026, donc la contrainte n'est plus
 * prématurée. `preload` n'est volontairement pas demandé — l'inscription est
 * très difficile à retirer ensuite.
 *
 * Limites connues de FreeBuff Sites :
 * - la plateforme injecte le beacon `static.cloudflareinsights.com` dans les
 *   documents de navigation. La CSP le bloque volontairement (analytics
 *   désactivé) plutôt que d'autoriser un script tiers à lire `localStorage` ;
 * - `frame-ancestors 'none'` empêche aussi d'afficher la Preview Sites dans
 *   une iframe : ouvrir son URL directement dans un onglet.
 */

/**
 * Politique appliquée telle quelle. La repasser à `false` restaure le mode
 * `Report-Only` (aucun blocage) : c'est le retour arrière d'urgence.
 */
export const CSP_ENFORCED = true

/** Durée HSTS : un an, sous-domaines inclus, sans `preload`. */
export const STRICT_TRANSPORT_SECURITY = 'max-age=31536000; includeSubDomains'

/**
 * Politique destinée à l'application réelle.
 *
 * - `'wasm-unsafe-eval'` est requis par MediaPipe Selfie Segmentation ; il
 *   n'autorise pas `eval()` JavaScript.
 * - `api.realtime.cloudflare.com` couvre l'API RealtimeKit 2.0.3.
 * - `wss://*.realtime.cloudflare.com` couvre le signaling, y compris
 *   `socket-edge` si le SDK l'utilise encore.
 * - `*.dyte.in` / `*.dyte.io` couvrent les hôtes hérités du SDK (RealtimeKit
 *   est bâti sur Dyte) : ils apparaissent dans le bundle publié et servent de
 *   repli si Cloudflare renvoie une URL de signaling historique.
 * - `r2.cloudflarestorage.com` est documenté pour le stockage des messages de
 *   chat ; à retirer si le test réel ne l'utilise pas.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self' https://api.realtime.cloudflare.com wss://api.realtime.cloudflare.com wss://*.realtime.cloudflare.com https://*.dyte.in wss://*.dyte.in https://*.dyte.io wss://*.dyte.io https://r2.cloudflarestorage.com",
  "worker-src 'self'",
  "manifest-src 'self'",
].join('; ')

/** Protection iframe minimale, conservée même en mode `Report-Only`. */
export const FRAME_PROTECTION_POLICY = "frame-ancestors 'none'"

/**
 * Recopie une réponse en y ajoutant les en-têtes de sécurité.
 *
 * Le corps, le statut et les en-têtes existants (Cache-Control, Content-Type,
 * Retry-After…) sont conservés : aucun comportement fonctionnel n'est modifié.
 */
export function applySecurityHeaders(response) {
  const headers = new Headers(response.headers)

  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Referrer-Policy', 'no-referrer')
  headers.set('X-Frame-Options', 'DENY')
  headers.set('Strict-Transport-Security', STRICT_TRANSPORT_SECURITY)
  headers.set(
    'Content-Security-Policy',
    CSP_ENFORCED ? CONTENT_SECURITY_POLICY : FRAME_PROTECTION_POLICY,
  )

  if (CSP_ENFORCED) {
    headers.delete('Content-Security-Policy-Report-Only')
  } else {
    headers.set('Content-Security-Policy-Report-Only', CONTENT_SECURITY_POLICY)
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
