/**
 * Écrit `worker/version.js` à partir de `package.json` et de Git.
 *
 * Le Worker est déployé **tel quel** : le manifeste liste ses modules et aucun
 * bundler ne le traverse. Sa version doit donc vivre dans un fichier du dépôt,
 * régénéré avant chaque build pour que `GET /api/version` annonce toujours le
 * commit réellement construit — c'est ce qui rend vérifiable la question
 * « quel code tourne en production ? ».
 *
 * Le contenu ne dépend que du commit : deux builds du même commit produisent
 * exactement le même fichier (et donc le même artefact).
 *
 * Sans Git (archive, image de build), le fichier existant est conservé : la
 * version annoncée reste celle du dernier état publié.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = resolve(root, 'worker/version.js')
const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))

function git(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

const commit = git(['rev-parse', '--short', 'HEAD'])

if (!commit) {
  console.log('version:stamp — Git indisponible, worker/version.js conservé tel quel')
  process.exit(0)
}

// Un arbre modifié est signalé dans le commit annoncé : la version publiée ne
// correspond alors pas exactement à un commit, et le diagnostic le montre.
// `worker/version.js` est le fichier écrit ici : sa modification en attente
// n'est pas une modification du code. L'ignorer évite qu'un build succédant à
// un build se déclare « -dirty » à cause de sa propre estampille.
const dirty = git(['status', '--porcelain', '--', 'src', 'worker', 'index.html', 'package.json'])
  .split('\n')
  .filter((line) => line.trim() !== '' && !line.endsWith('worker/version.js')).length > 0
const commitDate = git(['show', '-s', '--format=%cI', 'HEAD']) || new Date().toISOString()

const content = `/**
 * Version de l'application — fichier **généré** par \`scripts/stamp-version.mjs\`.
 *
 * Régénéré à chaque \`npm run build\` (crochet \`prebuild\`) depuis \`package.json\`
 * et le commit Git courant, puis exposé par \`GET /api/version\`. Le Worker est
 * déployé tel quel (le manifeste liste ses modules) : sa version doit donc
 * vivre dans un module, pas dans une variable d'environnement.
 *
 * Ne pas modifier à la main : lancer \`npm run version:stamp\`.
 */
export const APP_VERSION = '${version}'
export const BUILD_COMMIT = '${commit}${dirty ? '-dirty' : ''}'
export const BUILD_COMMIT_DATE = '${commitDate}'
`

writeFileSync(target, content)
console.log(`version:stamp — ${version} @ ${commit}${dirty ? ' (arbre modifié)' : ''}`)
