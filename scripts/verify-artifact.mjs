/**
 * Vérifie l'artefact de déploiement **avant** toute publication.
 *
 * Deux pannes sont visées, toutes deux déjà rencontrées :
 *
 * 1. un module du Worker importé mais absent du manifeste (le déploiement
 *    échoue, ou pire, sert un Worker incomplet) ;
 * 2. un artefact publié qui n'est pas celui du dépôt (mauvaise version en
 *    production).
 *
 * Le script refuse donc de valider : module manquant ou vide, import relatif
 * non déclaré, entrée introuvable, asset référencé absent, `.map` ou fichier
 * d'environnement dans `dist/`, dépassement des limites de la plateforme.
 *
 * Usage : `npm run verify:artifact` (après `npm run build`).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Limites imposées au dépôt d'un site (voir la documentation de la plateforme). */
const MAX_BYTES = 10 * 1024 * 1024
const MAX_FILES = 1000

const problems = []
const summary = []

const manifest = JSON.parse(readFileSync(join(root, 'preview.manifest.json'), 'utf8'))

// --- Manifeste ---------------------------------------------------------------

// `spa: true` ferait répondre `index.html` en 200 à *toute* requête absente et
// masquerait une erreur de livraison : le README l'interdit, ce contrôle aussi.
if ('spa' in manifest) {
  problems.push('clé « spa » interdite : le repli SPA doit rester décidé par le Worker')
}
if (!manifest.entrypoint) problems.push('manifeste : `entrypoint` manquant')
if (!/^\d{4}-\d{2}-\d{2}$/.test(manifest.compatibilityDate ?? '')) {
  problems.push('manifeste : `compatibilityDate` absente ou mal formée')
}

const modules = Array.isArray(manifest.modules) ? manifest.modules : []
if (modules.length === 0) problems.push('manifeste : aucun module déclaré')

const moduleNames = new Set()
for (const mod of modules) {
  if (!mod.name) {
    problems.push('manifeste : module sans nom')
    continue
  }
  if (moduleNames.has(mod.name)) problems.push(`manifeste : module dupliqué « ${mod.name} »`)
  moduleNames.add(mod.name)

  if (!['esm', 'text', 'wasm'].includes(mod.type)) {
    problems.push(`manifeste : type inconnu pour « ${mod.name} » (${mod.type})`)
  }

  let stats
  try {
    stats = statSync(resolve(root, mod.path ?? ''))
  } catch {
    problems.push(`module introuvable : ${mod.path} — lancer « npm run build »`)
    continue
  }
  if (!stats.isFile() || stats.size === 0) {
    problems.push(`module vide : ${mod.path}`)
  } else {
    summary.push(`  ${mod.name.padEnd(18)} ${(stats.size / 1024).toFixed(1)} Ko`)
  }
}

if (manifest.entrypoint && !moduleNames.has(manifest.entrypoint)) {
  problems.push(`manifeste : « ${manifest.entrypoint} » n'est pas déclaré dans \`modules\``)
}

// Chaque import relatif d'un module doit être déclaré : c'est exactement la
// panne qu'a failli provoquer l'ajout de `version.js`.
for (const mod of modules) {
  if (mod.type !== 'esm' || !mod.path) continue
  let source
  try {
    source = readFileSync(resolve(root, mod.path), 'utf8')
  } catch {
    continue
  }
  for (const match of source.matchAll(/from\s+['"]\.\/([^'"]+)['"]/g)) {
    const target = match[1]
    if (!moduleNames.has(target)) {
      problems.push(`import non déclaré : « ${mod.name} » importe ./${target}`)
    }
  }
}

// --- Assets ------------------------------------------------------------------

const assetsDir = resolve(root, manifest.assetsDirectory ?? '')
const files = []

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (entry.isFile()) files.push(path)
  }
}

try {
  walk(assetsDir)
} catch {
  problems.push(`assets introuvables : ${manifest.assetsDirectory} — lancer « npm run build »`)
}

let bytes = 0
for (const file of files) {
  const size = statSync(file).size
  bytes += size

  const path = relative(assetsDir, file)
  if (path.startsWith('.git/') || path.includes('node_modules/')) {
    problems.push(`fichier interdit dans l'artefact : ${path}`)
  }
  if (path.endsWith('.map')) problems.push(`source map dans l'artefact : ${path}`)
  if (/(^|\/)\.(env|dev\.vars)/.test(path)) problems.push(`fichier d'environnement dans l'artefact : ${path}`)
}

if (files.length > MAX_FILES) {
  problems.push(`${files.length} fichiers dans l'artefact (limite ${MAX_FILES})`)
}
if (bytes > MAX_BYTES) {
  problems.push(`${(bytes / 1024 / 1024).toFixed(2)} Mio dans l'artefact (limite 10 Mio)`)
}

// `index.html` doit exister et ne référencer que des fichiers réellement présents.
const indexPath = join(assetsDir, 'index.html')
let indexHtml = ''
try {
  indexHtml = readFileSync(indexPath, 'utf8')
} catch {
  problems.push(`index.html absent de ${manifest.assetsDirectory}`)
}

for (const match of indexHtml.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
  const referenced = join(assetsDir, match[1].replace(/^\//, ''))
  try {
    statSync(referenced)
  } catch {
    problems.push(`index.html référence un fichier absent : ${match[1]}`)
  }
}

// --- Verdict -----------------------------------------------------------------

console.log('Modules déclarés (manifeste → disque) :')
for (const line of summary) console.log(line)
console.log(
  `\nAssets : ${files.length} fichier(s), ${(bytes / 1024 / 1024).toFixed(2)} Mio ` +
    `(limites : ${MAX_FILES} fichiers, 10 Mio)`,
)

if (problems.length > 0) {
  console.error('\nArtefact refusé :')
  for (const problem of problems) console.error(`  ✗ ${problem}`)
  process.exit(1)
}

console.log('\nArtefact conforme : publiable tel quel.')
