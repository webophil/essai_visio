/**
 * Confronte la version annoncée par un environnement au commit local.
 *
 * C'est le contrôle qui rend impossible la panne d'origine : une production
 * plus récente (ou plus ancienne) que le dépôt. À lancer après chaque
 * publication, et à brancher en fin de pipeline.
 *
 *   node scripts/check-deployed-version.mjs [url]
 *
 * Sorties : 0 si les commits correspondent, 1 en cas d'écart, 2 si l'endpoint
 * est absent (donc si la version publiée précède `/api/version`).
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const url = (process.argv[2] ?? 'https://visio.phildev.online').replace(/\/+$/, '')

function git(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

const head = git(['rev-parse', '--short', 'HEAD'])
const expectedVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version

const dirty =
  git(['status', '--porcelain', '--', 'src', 'worker', 'index.html', 'package.json'])
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.endsWith('worker/version.js')).length > 0

if (!head) {
  console.error('Impossible de lire HEAD : ce contrôle doit tourner dans un dépôt Git.')
  process.exit(2)
}

let response
try {
  response = await fetch(`${url}/api/version`, { headers: { Accept: 'application/json' } })
} catch (error) {
  console.error(`Service injoignable : ${url} (${error.message})`)
  process.exit(2)
}

if (response.status === 404) {
  console.error(
    `${url}/api/version est absent : la version publiée est antérieure à cet endpoint.`,
  )
  process.exit(2)
}

if (!response.ok) {
  console.error(`Réponse inattendue de ${url}/api/version : ${response.status}`)
  process.exit(2)
}

const payload = await response.json()
const deployed = String(payload.commit ?? '')
const expected = head

console.log(`attendu  : ${expectedVersion} @ ${expected}${dirty ? ' (arbre local modifié)' : ''}`)
console.log(`déployé  : ${payload.version ?? '?'} @ ${deployed || '?'} (${url})`)

if (!deployed.startsWith(expected) && !expected.startsWith(deployed.replace(/-dirty$/, ''))) {
  console.error(
    '\nÉcart : la production ne tourne pas le commit local. Publier depuis un arbre propre, puis relancer ce contrôle.',
  )
  process.exit(1)
}

if (dirty && !deployed.includes('-dirty')) {
  console.log(
    '\nCommit identique, mais l\'arbre local contient des modifications non commitées : la production est en avance sur le dépôt.',
  )
  process.exit(1)
}

console.log('\nProduction alignée sur le commit local.')
