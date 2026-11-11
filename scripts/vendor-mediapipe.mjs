/**
 * Recopie les fichiers du moteur de segmentation dans `public/`, afin qu'ils
 * soient servis par l'application elle-même.
 *
 * Pourquoi : le flou d'arrière-plan s'appuie sur MediaPipe Selfie Segmentation,
 * qui charge un binaire WebAssembly, un graphe `.binarypb` et un modèle
 * `.tflite` **au moment où l'utilisateur active l'effet**. Ces fichiers doivent
 * donc être servis depuis notre origine — aucun CDN, aucun service externe.
 *
 * Les fichiers ne sont pas versionnés (`public/vendor/` est ignoré) : ils sont
 * recopiés depuis `node_modules` à chaque `dev` et `build`, sans réseau.
 */

import { existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'node_modules', '@mediapipe', 'selfie_segmentation')
const destination = join(root, 'public', 'vendor', 'mediapipe', 'selfie_segmentation')

/** Fichiers nécessaires au graphe SIMD (navigateurs modernes). */
const FILES = [
  'selfie_segmentation.js',
  'selfie_segmentation.binarypb',
  'selfie_segmentation_solution_simd_wasm_bin.js',
  'selfie_segmentation_solution_simd_wasm_bin.wasm',
  'selfie_segmentation_solution_simd_wasm_bin.data',
  // Modèle général (256×256), retenu pour sa précision sur les visages ; le
  // modèle « paysage » du paquet n'est pas livré, il n'est plus utilisé.
  'selfie_segmentation.tflite',
]

if (!existsSync(source)) {
  console.error(
    `[vendor-mediapipe] paquet introuvable : ${source}\n` +
      'Installez les dépendances (npm ci) avant de construire le projet.',
  )
  process.exit(1)
}

mkdirSync(destination, { recursive: true })

let copied = 0
let bytes = 0

for (const file of FILES) {
  const from = join(source, file)
  const to = join(destination, file)

  if (!existsSync(from)) {
    console.error(`[vendor-mediapipe] fichier manquant dans le paquet : ${file}`)
    process.exit(1)
  }

  const sourceSize = statSync(from).size
  // Recopie uniquement si le fichier a changé : `dev` et `build` restent rapides.
  if (!existsSync(to) || statSync(to).size !== sourceSize) {
    copyFileSync(from, to)
    copied += 1
    bytes += sourceSize
  }
}

const totalMb = (FILES.reduce((sum, file) => sum + statSync(join(destination, file)).size, 0) / 1024 / 1024).toFixed(1)
console.log(
  `[vendor-mediapipe] ${copied === 0 ? 'fichiers déjà à jour' : `${copied} fichier(s) recopié(s)`} — ${totalMb} Mo servis depuis public/vendor`,
)
