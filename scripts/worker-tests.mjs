/**
 * Tests fonctionnels du Worker PhilDEV Visio — Phase 2.
 *
 * Le handler `fetch` est appelé exactement comme en production. Deux doubles
 * remplacent l'infrastructure : le binding `ASSETS` (artefact `dist/`) et
 * l'API Cloudflare RealtimeKit (interceptée au niveau du `fetch` global).
 *
 * Ce qui est vérifié : routage de l'API, service des assets, **repli SPA
 * inchangé** (404 conservé pour les ressources), session organisateur,
 * délivrance des jetons, limite de participants, refus cross-origin, limitation
 * de débit, et absence totale de fuite du jeton d'API ou de la clé organisateur.
 */

import assert from 'node:assert/strict'

import worker from '../worker/index.js'

const API_TOKEN = 'jeton-api-cloudflare-DE-TEST'
const HOST_KEY = 'cle-organisateur-DE-TEST'
const INDEX_HTML = '<!doctype html><html lang="fr"><body><div id="root"></div></body></html>'

let failures = 0
let checks = 0

async function testAsync(name, run) {
  checks += 1
  try {
    await run()
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  ✗ ${name}\n      ${error.message}`)
  }
}

function group(title) {
  console.log(`\n▶ ${title}`)
}

// ---------------------------------------------------------------------------
// Doubles d'infrastructure
// ---------------------------------------------------------------------------

/** Artefact statique minimal, joué par le binding `ASSETS`. */
async function assetsFetch(request) {
  const { pathname } = new URL(request.url)

  if (pathname === '/' || pathname === '/index.html') {
    return new Response(INDEX_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } })
  }
  if (pathname === '/assets/app.js') {
    return new Response('console.log(1)', {
      status: 200,
      headers: { 'Content-Type': 'text/javascript' },
    })
  }

  return new Response('Not found', { status: 404 })
}

/** Réunion et participants simulés côté Cloudflare. */
const rtkMeetings = new Map()
/** Titre de réunion, tel que stocké par Cloudflare RealtimeKit. */
const rtkTitles = new Map()
const rtkCalls = []

function seedMeeting() {
  const id = crypto.randomUUID()
  rtkMeetings.set(id, [])
  return id
}

function seedParticipant(meetingId, customParticipantId, presetName = 'group_call_participant') {
  const list = rtkMeetings.get(meetingId) ?? []
  list.push({
    id: crypto.randomUUID(),
    custom_participant_id: customParticipantId,
    preset_name: presetName,
    name: presetName,
  })
  rtkMeetings.set(meetingId, list)
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url)
  const method = init.method ?? 'GET'
  const path = url.pathname
  const headers = init.headers ?? {}
  const body = init.body ? JSON.parse(init.body) : {}

  rtkCalls.push({ method, path, headers, body })

  // Toute la surface RealtimeKit utilisée par le Worker est simulée ici.
  const meetingMatch = path.match(/\/realtime\/kit\/([^/]+)\/meetings\/([^/]+)\/participants$/)
  if (meetingMatch && method === 'GET') {
    const list = rtkMeetings.get(meetingMatch[2]) ?? []
    if (!rtkMeetings.has(meetingMatch[2])) {
      return new Response(JSON.stringify({ success: false, errors: [{ code: 1001, message: 'not found' }] }), { status: 404 })
    }
    return new Response(
      JSON.stringify({ success: true, data: list, paging: { total_count: list.length } }),
      { status: 200 },
    )
  }

  if (meetingMatch && method === 'POST') {
    const meetingId = meetingMatch[2]
    if (!rtkMeetings.has(meetingId)) {
      return new Response(JSON.stringify({ success: false, errors: [{ code: 1001 }] }), { status: 404 })
    }
    const list = rtkMeetings.get(meetingId)
    const participant = {
      id: crypto.randomUUID(),
      custom_participant_id: body.custom_participant_id,
      preset_name: body.preset_name,
      name: body.name,
    }
    list.push(participant)
    return new Response(
      JSON.stringify({ success: true, data: { ...participant, token: `jeton-participant-${list.length}` } }),
      { status: 200 },
    )
  }

  if (path.endsWith('/meetings') && method === 'POST') {
    const id = seedMeeting()
    rtkTitles.set(id, body.title)
    return new Response(JSON.stringify({ success: true, data: { id, title: body.title } }), { status: 200 })
  }

  // Lecture d'une réunion : utilisée par `GET /api/meetings/:id`.
  const meetingDetail = path.match(/\/realtime\/kit\/([^/]+)\/meetings\/([^/]+)$/)
  if (meetingDetail && method === 'GET') {
    const id = meetingDetail[2]
    if (!rtkTitles.has(id)) {
      return new Response(JSON.stringify({ success: false, errors: [{ code: 1001 }] }), { status: 404 })
    }
    return new Response(
      JSON.stringify({ success: true, data: { id, title: rtkTitles.get(id) } }),
      { status: 200 },
    )
  }

  if (path.endsWith('/presets') && method === 'GET') {
    return new Response(
      JSON.stringify({ success: true, data: [{ name: 'group_call_host' }, { name: 'group_call_participant' }] }),
      { status: 200 },
    )
  }

  return new Response(JSON.stringify({ success: false, errors: [{ code: 9999 }] }), { status: 404 })
}

const baseEnv = {
  CLOUDFLARE_API_TOKEN: API_TOKEN,
  PHILDEV_HOST_KEY: HOST_KEY,
  ASSETS: { fetch: assetsFetch },
}

function appRequest(path, { method = 'GET', headers = {}, body, env = baseEnv } = {}) {
  const request = new Request(`https://visio.phildev.test${path}`, {
    method,
    headers: { Origin: 'https://visio.phildev.test', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return worker.fetch(request, env)
}

/**
 * Lit une réponse d'API en vérifiant qu'aucun secret n'y figure.
 * Le corps n'est consommé qu'une fois : les contrôles portent sur le texte brut.
 */
async function readJson(response, label) {
  const text = await response.text()
  assert.ok(!text.includes(API_TOKEN), `${label} : le jeton d'API apparaît dans la réponse`)
  assert.ok(!text.includes(HOST_KEY), `${label} : la clé organisateur apparaît dans la réponse`)

  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} : réponse non JSON (${text.slice(0, 80)})`)
  }
}

async function login(ip) {
  const response = await appRequest('/api/host/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: { key: HOST_KEY },
  })
  assert.equal(response.status, 200, `ouverture de session : ${response.status}`)
  const payload = await readJson(response, 'session organisateur')
  return payload.token
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

group('Service de l’application (artefact statique)')

await testAsync('la racine sert index.html', async () => {
  const response = await appRequest('/', { headers: { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate' } })
  assert.equal(response.status, 200)
  assert.ok((await response.text()).includes('id="root"'))
})

await testAsync('une route de réunion reçoit index.html (repli SPA)', async () => {
  const response = await appRequest('/rdv-aurore', {
    headers: { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate' },
  })
  assert.equal(response.status, 200)
  assert.ok((await response.text()).includes('id="root"'))
})

await testAsync('une ressource absente conserve son 404', async () => {
  const script = await appRequest('/assets/absent-xyz.js', { headers: { 'Sec-Fetch-Mode': 'script' } })
  assert.equal(script.status, 404, 'un JavaScript absent ne doit pas devenir une page HTML 200')

  const css = await appRequest('/assets/absent-xyz.css', { headers: { 'Sec-Fetch-Mode': 'style' } })
  assert.equal(css.status, 404)
})

await testAsync('une ressource existante est servie telle quelle', async () => {
  const response = await appRequest('/assets/app.js', { headers: { 'Sec-Fetch-Mode': 'script' } })
  assert.equal(response.status, 200)
  assert.ok((response.headers.get('Content-Type') ?? '').includes('javascript'))
})

await testAsync('une route inconnue hors navigation reste 404', async () => {
  const response = await appRequest('/inconnu', { headers: { 'Sec-Fetch-Mode': 'no-cors' } })
  assert.equal(response.status, 404)
})

group('En-têtes HTTP de sécurité')

await testAsync('le document et les assets reçoivent les en-têtes de sécurité', async () => {
  for (const path of ['/', '/assets/app.js']) {
    const response = await appRequest(path, {
      headers: { 'Sec-Fetch-Mode': path === '/' ? 'navigate' : 'script', Accept: path === '/' ? 'text/html' : '*/*' },
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff')
    assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer')
    assert.equal(response.headers.get('X-Frame-Options'), 'DENY')
    assert.match(response.headers.get('Content-Security-Policy') ?? '', /frame-ancestors 'none'/)

    const policy = response.headers.get('Content-Security-Policy') ?? ''
    assert.match(policy, /default-src 'self'/, 'CSP bloquante absente')
    assert.match(policy, /script-src 'self' 'wasm-unsafe-eval'/, 'MediaPipe doit rester autorisé')
    assert.match(policy, /https:\/\/api\.realtime\.cloudflare\.com/, 'API RealtimeKit absente')
    assert.match(policy, /wss:\/\/\*\.realtime\.cloudflare\.com/, 'signaling RealtimeKit absent')
    assert.match(policy, /wss:\/\/\*\.dyte\.in/, 'hôtes hérités du SDK absents')
    assert.equal(
      response.headers.get('Content-Security-Policy-Report-Only'),
      null,
      'plus aucun Report-Only attendu',
    )
    assert.match(
      response.headers.get('Strict-Transport-Security') ?? '',
      /max-age=31536000/,
      'HSTS absent',
    )
  }
})

await testAsync('la CSP bloque réellement et HSTS protège le domaine', async () => {
  const response = await appRequest('/', { headers: { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html' } })
  const policy = response.headers.get('Content-Security-Policy') ?? ''

  assert.match(policy, /frame-ancestors 'none'/, 'intégration iframe non bloquée')
  assert.match(policy, /connect-src 'self' https:\/\/api\.realtime\.cloudflare\.com/, 'connect-src incomplète')
  assert.match(policy, /script-src 'self' 'wasm-unsafe-eval'/, 'script-src incomplète')
  assert.equal(response.headers.get('Strict-Transport-Security'), 'max-age=31536000; includeSubDomains')
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY')
})

await testAsync('les réponses 404 et API conservent leurs en-têtes et reçoivent les nouveaux', async () => {
  const missing = await appRequest('/assets/absent-xyz.js', { headers: { 'Sec-Fetch-Mode': 'script' } })
  assert.equal(missing.status, 404)
  assert.equal(missing.headers.get('X-Content-Type-Options'), 'nosniff')
  assert.match(missing.headers.get('Content-Security-Policy') ?? '', /default-src 'self'/, 'CSP absente sur un 404')

  const health = await appRequest('/api/health', { headers: { 'CF-Connecting-IP': '10.0.0.99' } })
  assert.equal(health.status, 200)
  assert.equal(health.headers.get('Cache-Control'), 'no-store')
  assert.equal(health.headers.get('X-Content-Type-Options'), 'nosniff')
  assert.match(health.headers.get('Content-Security-Policy') ?? '', /default-src 'self'/, 'CSP absente sur l’API')
})

group('API : état et sécurité')

await testAsync('GET /api/health répond sans secret', async () => {
  const response = await appRequest('/api/health', { headers: { 'CF-Connecting-IP': '10.0.0.1' } })
  assert.equal(response.status, 200)
  const payload = await readJson(response, 'health')
  assert.equal(payload.ok, true)
})

await testAsync('GET /api/version identifie le commit déployé', async () => {
  const response = await appRequest('/api/version', { headers: { 'CF-Connecting-IP': '10.0.0.4' } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')

  const payload = await readJson(response, 'version')
  assert.equal(payload.service, 'phildev-visio')
  assert.match(payload.version, /^\d+\.\d+\.\d+$/, 'version sémantique attendue')
  assert.match(payload.commit, /^[0-9a-f]{7,40}(-dirty)?$/, 'commit Git attendu')
  assert.equal(typeof payload.commitDate, 'string')
})

await testAsync('les réponses d’API ne sont jamais mises en cache', async () => {
  const response = await appRequest('/api/health', { headers: { 'CF-Connecting-IP': '10.0.0.2' } })
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
})

await testAsync('un chemin d’API inconnu renvoie 404 JSON', async () => {
  const response = await appRequest('/api/inconnu', { headers: { 'CF-Connecting-IP': '10.0.0.3' } })
  assert.equal(response.status, 404)
  assert.equal((await response.json()).error, 'not-found')
})

await testAsync('une mutation cross-origin est refusée', async () => {
  const response = await appRequest('/api/rtk/token', {
    method: 'POST',
    headers: { Origin: 'https://attaquant.example', 'Content-Type': 'application/json' },
    body: { meetingId: crypto.randomUUID(), displayName: 'Intrus', guestId: crypto.randomUUID(), role: 'guest' },
  })
  assert.equal(response.status, 403)
})

group('Session organisateur')

await testAsync('la clé correcte ouvre une session, la mauvaise est refusée', async () => {
  const refused = await appRequest('/api/host/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.0.0.10' },
    body: { key: 'mauvaise-cle' },
  })
  assert.equal(refused.status, 401)
  assert.equal((await readJson(refused, 'refus de clé')).error, 'host-key-invalid')

  const token = await login('10.0.0.11')
  assert.ok(typeof token === 'string' && token.includes('.'), 'session signée attendue')
})

await testAsync('sans secret configuré, l’accès organisateur est désactivé', async () => {
  const response = await appRequest('/api/host/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.0.0.12' },
    body: { key: HOST_KEY },
    env: { CLOUDFLARE_API_TOKEN: API_TOKEN, ASSETS: { fetch: assetsFetch } },
  })
  assert.equal(response.status, 503)
  assert.equal((await response.json()).error, 'host-key-missing')
})

group('Création de réunion (réservée à l’organisateur)')

await testAsync('sans session, la création est refusée', async () => {
  const response = await appRequest('/api/meetings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.0.0.20' },
    body: { title: 'Réunion pirate' },
  })
  assert.equal(response.status, 401)
  assert.equal((await response.json()).error, 'host-unauthorized')
})

await testAsync('avec session, la réunion est créée et l’emplacement hôte réservé', async () => {
  const token = await login('10.0.0.21')
  const response = await appRequest('/api/meetings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-PhilDEV-Host': token,
      'CF-Connecting-IP': '10.0.0.21',
    },
    body: { title: 'Réunion Test', displayName: 'PhilDEV' },
  })

  assert.equal(response.status, 200)
  const payload = await readJson(response, 'création de réunion')
  assert.ok(payload.meetingId, 'identifiant de réunion attendu')
  assert.equal(payload.maxParticipants, 5)
  assert.equal(payload.title, 'Réunion Test', 'le nom saisi doit être celui de la réunion')
  assert.equal(rtkTitles.get(payload.meetingId), 'Réunion Test')

  const participants = rtkMeetings.get(payload.meetingId)
  assert.equal(participants.length, 1)
  assert.equal(participants[0].preset_name, 'group_call_host', 'preset hôte attendu')
  assert.equal(participants[0].name, 'PhilDEV')
})

group('Nom de la réunion')

await testAsync('un nom vide ou trop long est normalisé côté serveur', async () => {
  const token = await login('10.0.5.1')
  const create = (title) =>
    appRequest('/api/meetings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PhilDEV-Host': token, 'CF-Connecting-IP': '10.0.5.1' },
      body: { title, displayName: 'PhilDEV' },
    })

  const blank = await (await create('   ')).json()
  assert.equal(blank.title, 'Réunion PhilDEV', 'nom par défaut attendu')

  const long = await (await create('x'.repeat(200))).json()
  assert.equal(long.title.length, 80, 'nom borné à 80 caractères')
})

await testAsync('GET /api/meetings/:id expose le nom aux participants, sans secret', async () => {
  const token = await login('10.0.5.2')
  const created = await (
    await appRequest('/api/meetings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PhilDEV-Host': token, 'CF-Connecting-IP': '10.0.5.2' },
      body: { title: 'Rendez-vous Aurore Studer', displayName: 'PhilDEV' },
    })
  ).json()

  // Lecture sans session : un invité doit pouvoir afficher le nom de la salle.
  const response = await appRequest(`/api/meetings/${created.meetingId}`, {
    headers: { 'CF-Connecting-IP': '10.0.5.3' },
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')

  const payload = await readJson(response, 'nom de réunion')
  assert.deepEqual(Object.keys(payload).sort(), ['meetingId', 'title'])
  assert.equal(payload.title, 'Rendez-vous Aurore Studer')
})

await testAsync('un identifiant invalide ou inconnu est refusé proprement', async () => {
  const invalid = await appRequest('/api/meetings/pas-un-uuid', {
    headers: { 'CF-Connecting-IP': '10.0.5.4' },
  })
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).error, 'meeting-invalid')

  const unknown = await appRequest(`/api/meetings/${crypto.randomUUID()}`, {
    headers: { 'CF-Connecting-IP': '10.0.5.5' },
  })
  assert.equal(unknown.status, 404)
  assert.equal((await readJson(unknown, 'réunion inconnue')).error, 'meeting-not-found')
})

group('Jetons de participation')

await testAsync('un invité reçoit un jeton sans compte, jamais le jeton d’API', async () => {
  const token = await login('10.0.0.30')
  const created = await (
    await appRequest('/api/meetings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PhilDEV-Host': token, 'CF-Connecting-IP': '10.0.0.30' },
      body: { title: 'Réunion Invités' },
    })
  ).json()

  const response = await appRequest('/api/rtk/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.0.0.31' },
    body: {
      meetingId: created.meetingId,
      displayName: 'Aurore Dupont',
      guestId: crypto.randomUUID(),
      role: 'guest',
    },
  })

  assert.equal(response.status, 200)
  const payload = await readJson(response, 'jeton invité')
  assert.ok(payload.token, 'jeton participant attendu')
  assert.equal(payload.role, 'guest')
  assert.equal(payload.presetName, 'group_call_participant')
})

await testAsync('une demande d’hôte sans session retombe en invité refusé', async () => {
  const meetingId = seedMeeting()
  const response = await appRequest('/api/rtk/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.0.0.32' },
    body: { meetingId, displayName: 'Faux hôte', guestId: crypto.randomUUID(), role: 'host' },
  })

  assert.equal(response.status, 401)
  assert.equal((await response.json()).error, 'host-unauthorized')
})

await testAsync('les entrées invalides sont refusées', async () => {
  const badMeeting = await appRequest('/api/rtk/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.0.0.33' },
    body: { meetingId: 'pas-un-uuid', displayName: 'Aurore', guestId: crypto.randomUUID(), role: 'guest' },
  })
  assert.equal(badMeeting.status, 400)
  assert.equal((await badMeeting.json()).error, 'meeting-invalid')

  const badName = await appRequest('/api/rtk/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.0.0.34' },
    body: { meetingId: crypto.randomUUID(), displayName: 'A', guestId: crypto.randomUUID(), role: 'guest' },
  })
  assert.equal(badName.status, 400)
  assert.equal((await badName.json()).error, 'name-invalid')

  const badGuest = await appRequest('/api/rtk/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.0.0.35' },
    body: { meetingId: crypto.randomUUID(), displayName: 'Aurore', guestId: 'x', role: 'guest' },
  })
  assert.equal(badGuest.status, 400)
  assert.equal((await badGuest.json()).error, 'guest-invalid')
})

await testAsync('une réunion inexistante est signalée sans détail amont', async () => {
  const response = await appRequest('/api/rtk/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.0.0.36' },
    body: {
      meetingId: crypto.randomUUID(),
      displayName: 'Aurore Dupont',
      guestId: crypto.randomUUID(),
      role: 'guest',
    },
  })

  assert.equal(response.status, 404)
  await readJson(response, 'réunion inconnue')
})

group('Limite de cinq participants (côté serveur)')

await testAsync('le sixième participant est refusé, un reconnecté est accepté', async () => {
  const meetingId = seedMeeting()
  const hostId = crypto.randomUUID()
  seedParticipant(meetingId, hostId, 'group_call_host')

  const admitted = []
  for (let index = 0; index < 4; index += 1) {
    const guestId = crypto.randomUUID()
    admitted.push(guestId)

    const response = await appRequest('/api/rtk/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `10.1.0.${index + 1}` },
      body: { meetingId, displayName: `Invité ${index + 1}`, guestId, role: 'guest' },
    })
    assert.equal(response.status, 200, `invité ${index + 1} refusé à tort`)
  }

  // Emplacements occupés : l'hôte + quatre invités = cinq.
  const overflow = await appRequest('/api/rtk/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.1.0.9' },
    body: { meetingId, displayName: 'Sixième', guestId: crypto.randomUUID(), role: 'guest' },
  })
  assert.equal(overflow.status, 409)
  assert.equal((await overflow.json()).error, 'meeting-full')

  // Un invité déjà admis retrouve son emplacement (pas de consommation nouvelle).
  const reconnect = await appRequest('/api/rtk/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.1.0.10' },
    body: { meetingId, displayName: 'Invité 1', guestId: admitted[0], role: 'guest' },
  })
  assert.equal(reconnect.status, 200, 'une reconnexion ne doit pas être bloquée')

  // L'organisateur reste toujours autorisé à entrer.
  const token = await login('10.1.0.11')
  const hostEntry = await appRequest('/api/rtk/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-PhilDEV-Host': token, 'CF-Connecting-IP': '10.1.0.11' },
    body: { meetingId, displayName: 'PhilDEV', guestId: hostId, role: 'host' },
  })
  assert.equal(hostEntry.status, 200, "l'organisateur doit pouvoir entrer malgré la limite")
  await readJson(hostEntry, 'entrée organisateur')
})

group('Diagnostic (lecture seule, réservé à l’organisateur)')

await testAsync('le diagnostic exige la session et ne renvoie aucun secret', async () => {
  const refused = await appRequest('/api/rtk/diagnostic', { headers: { 'CF-Connecting-IP': '10.2.0.1' } })
  assert.equal(refused.status, 401)

  const token = await login('10.2.0.2')
  const response = await appRequest('/api/rtk/diagnostic', {
    headers: { 'X-PhilDEV-Host': token, 'CF-Connecting-IP': '10.2.0.2' },
  })

  assert.equal(response.status, 200)
  const report = await readJson(response, 'diagnostic')
  assert.equal(report.apiTokenPresent, true)
  assert.equal(report.presetsRead, 'ok')
  assert.deepEqual(report.presetsAvailable, ['group_call_host', 'group_call_participant'])
})

group('Limitation de débit')

await testAsync('les demandes répétées de jetons finissent par être freinées', async () => {
  const meetingId = seedMeeting()
  const statuses = []

  for (let index = 0; index < 20; index += 1) {
    const response = await appRequest('/api/rtk/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.9.9.9' },
      body: { meetingId, displayName: 'Aurore Dupont', guestId: crypto.randomUUID(), role: 'guest' },
    })
    statuses.push(response.status)
    if (response.status === 429) {
      assert.ok(response.headers.get('Retry-After'), 'en-tête Retry-After attendu')
      break
    }
  }

  assert.ok(statuses.includes(429), `aucun 429 observé (statuts : ${statuses.join(',')})`)
})

console.log(
  `\n${checks - failures}/${checks} vérifications réussies${failures > 0 ? ` — ${failures} échec(s)` : ''}`,
)
if (failures > 0) process.exit(1)
