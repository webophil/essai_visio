/**
 * Version de l'application — fichier **généré** par `scripts/stamp-version.mjs`.
 *
 * Régénéré à chaque `npm run build` (crochet `prebuild`) depuis `package.json`
 * et le commit Git courant, puis exposé par `GET /api/version`. Le Worker est
 * déployé tel quel (le manifeste liste ses modules) : sa version doit donc
 * vivre dans un module, pas dans une variable d'environnement.
 *
 * Ne pas modifier à la main : lancer `npm run version:stamp`.
 */
export const APP_VERSION = '2.1.0'
export const BUILD_COMMIT = '7adc932-dirty'
export const BUILD_COMMIT_DATE = '2026-11-03T17:46:30+00:00'
