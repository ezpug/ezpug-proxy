#!/usr/bin/env node
// EZPug venue relay (protocol 1). See README.md and PROTOCOL.md.
//
// At the SaarLAN venue the network resolves `saar-lan.de` to a local copy of
// ezLAN. A SaarLAN link started there gets its OAuth code from that copy, and
// the platform (on the internet) cannot redeem it. This process runs inside
// the venue LAN, dials OUT to the platform over one authenticated WebSocket,
// and performs exactly two calls on the platform's behalf against
// `saar-lan.de` as this network resolves it: POST /api/oauth/token and
// POST /api/oauth/userinfo. Nothing else, ever. It holds no ezLAN secret and
// never logs a body, an authorization header or its own token.

import { lookup } from 'node:dns/promises'
import { readFileSync, existsSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { arch, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

export const PROTOCOL_VERSION = 1
export const VERSION = '1.0.1'
export const DEFAULT_RELAY_URL = 'wss://api.pug.saar-lan.de/venue/relay'
export const DEFAULT_EZLAN_URL = 'https://saar-lan.de'
export const PUBLIC_EZLAN_ADDRESS = '152.53.253.187'

export const ALLOWED = [
  { method: 'POST', path: '/api/oauth/token' },
  { method: 'POST', path: '/api/oauth/userinfo' },
]
export const REQUEST_HEADERS = ['accept', 'authorization', 'content-type', 'x-access-token']
export const RESPONSE_HEADERS = ['content-type']
export const TIMEOUT_MS = 10_000
export const SILENCE_MS = 45_000
export const MAX_REQUEST_BODY = 8 * 1024
export const MAX_RESPONSE_BODY = 256 * 1024
export const MAX_FRAME = 512 * 1024
export const BACKOFF_MIN_MS = 1_000
export const BACKOFF_MAX_MS = 30_000
export const BACKOFF_REFUSED_MS = 60_000

export function isAllowed(method, path) {
  return ALLOWED.some(entry => entry.method === method && entry.path === path)
}

/** True for loopback and RFC 1918 / unique-local / link-local addresses. */
export function isPrivateAddress(address) {
  if (address.includes(':')) {
    const a = address.toLowerCase()
    return a === '::1' || a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe80')
  }
  const [a, b] = address.split('.').map(Number)
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
}

/** Capped, jittered exponential backoff: attempt 0 → ~1 s, then doubling to 30 s. */
export function backoffMs(attempt, random = Math.random) {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, attempt))
  return Math.round(base / 2 + random() * (base / 2))
}

export function pickHeaders(headers, allowed) {
  const out = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    const name = key.toLowerCase()
    if (allowed.includes(name) && typeof value === 'string') out[name] = value
  }
  return out
}

function log(...parts) {
  console.log(`${new Date().toISOString()} ${parts.join(' ')}`)
}

/** Reads `.env` next to this file (and in the working directory) without overriding the real environment. */
export function loadEnvFile(file) {
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!match || line.trimStart().startsWith('#')) continue
    const [, key, raw] = match
    const value = raw.replace(/^(['"])(.*)\1$/, '$2')
    if (process.env[key] === undefined) process.env[key] = value
  }
}

export function readConfig(env = process.env) {
  const token = (env.EZPUG_RELAY_TOKEN ?? '').trim()
  const relayUrl = (env.EZPUG_RELAY_URL ?? DEFAULT_RELAY_URL).trim()
  const ezlanUrl = (env.EZPUG_RELAY_EZLAN_URL ?? DEFAULT_EZLAN_URL).trim().replace(/\/+$/, '')
  const insecure = ['1', 'true', 'yes'].includes((env.EZPUG_RELAY_INSECURE_TLS ?? '').toLowerCase())
  return { token, relayUrl, ezlanUrl, insecure }
}

/**
 * One HTTP call to the configured ezLAN, for an allowed path only. Resolves
 * `{status, headers, body}`; rejects with `{reason, detail}`.
 */
export function forward(config, { path, headers, body }, { timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (!isAllowed('POST', path)) return reject({ reason: 'refused', detail: `not on the allow-list: POST ${path}` })
    if (Buffer.byteLength(body ?? '') > MAX_REQUEST_BODY) return reject({ reason: 'too-large', detail: 'request body over the cap' })
    const url = new URL(config.ezlanUrl + path)
    const send = url.protocol === 'http:' ? httpRequest : httpsRequest
    const req = send(
      url,
      {
        method: 'POST',
        headers: { ...pickHeaders(headers, REQUEST_HEADERS), 'content-length': Buffer.byteLength(body ?? '') },
        rejectUnauthorized: !config.insecure,
        timeout: timeoutMs,
      },
      res => {
        const chunks = []
        let size = 0
        res.on('data', chunk => {
          size += chunk.length
          if (size > MAX_RESPONSE_BODY) {
            req.destroy()
            reject({ reason: 'too-large', detail: 'response body over the cap' })
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 502,
            headers: pickHeaders(res.headers, RESPONSE_HEADERS),
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
        res.on('error', error => reject({ reason: 'unreachable', detail: String(error.message ?? error) }))
      },
    )
    req.on('timeout', () => {
      req.destroy()
      reject({ reason: 'timeout', detail: `no answer in ${timeoutMs} ms` })
    })
    req.on('error', error => reject({ reason: 'unreachable', detail: `${error.code ?? ''} ${error.message ?? error}`.trim() }))
    req.end(body ?? '')
  })
}

/** What the relay sees from inside this network. Never decides anything; it is reported. */
export async function selfCheck(config) {
  const host = new URL(config.ezlanUrl).hostname
  let addresses = []
  try {
    addresses = (await lookup(host, { all: true })).map(entry => entry.address)
  } catch {
    addresses = []
  }
  const local = addresses.length === 0 ? null : addresses.every(isPrivateAddress)
  let reachable = false
  let tlsError = null
  let answer = null
  try {
    const res = await forward(config, {
      path: '/api/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: 'grant_type=authorization_code',
    })
    reachable = res.status >= 400 && res.status < 500
    answer = `${res.status} ${res.body.slice(0, 120)}`
  } catch (failure) {
    if (/CERT|SSL|TLS|self.signed|UNABLE_TO/i.test(failure.detail ?? '')) tlsError = failure.detail
    answer = `${failure.reason}: ${failure.detail ?? ''}`
  }
  return {
    check: { ezlan: config.ezlanUrl, addresses, local, tls: config.insecure ? 'insecure' : 'verified', reachable },
    answer,
    tlsError,
  }
}

export function printSelfCheck({ check, answer, tlsError }) {
  log(`self-check: ${check.ezlan}`)
  log(`  resolves to: ${check.addresses.join(', ') || '(nothing)'}`)
  if (check.local === true) log('  verdict: LOCAL venue copy of ezLAN. This is what the relay is for.')
  else if (check.addresses.includes(PUBLIC_EZLAN_ADDRESS))
    log('  !!! verdict: this is the PUBLIC ezLAN. From here the relay is useless: run it on the venue network,',
      'and under Docker use --network host so the venue DNS answers.')
  else if (check.local === false) log('  !!! verdict: a public address that is not the known public ezLAN. Check the network.')
  else log('  !!! verdict: could not resolve it at all. Check the network / DNS.')
  log(`  token endpoint: ${answer}`)
  if (check.reachable) log(`  reachable: yes (TLS ${check.tls})`)
  else log('  !!! reachable: NO')
  if (tlsError) log('  !!! TLS failed. Only if you trust this network: set EZPUG_RELAY_INSECURE_TLS=1')
}

/** The line to the platform: connect, hello, answer requests, pong pings, reconnect forever. */
export function startRelay(config, { onState = () => {}, WebSocketImpl = WebSocket, random = Math.random } = {}) {
  let attempt = 0
  let socket = null
  let silence = null
  let retry = null
  let pending = false
  let stopped = false
  let check = null

  const armSilence = () => {
    clearTimeout(silence)
    silence = setTimeout(() => {
      log('line: silent too long, reconnecting')
      socket?.terminate()
    }, SILENCE_MS)
  }

  const schedule = delay => {
    if (stopped || pending) return
    pending = true
    log(`line: reconnecting in ${Math.round(delay / 1000)} s`)
    retry = setTimeout(connect, delay)
  }

  const send = frame => {
    if (socket?.readyState === WebSocketImpl.OPEN) socket.send(JSON.stringify(frame))
  }

  async function handle(frame) {
    if (frame.type === 'ping') {
      send({ type: 'pong', at: frame.at })
      return
    }
    if (frame.type !== 'request') return
    const started = Date.now()
    if (frame.method !== 'POST' || !isAllowed(frame.method, frame.path)) {
      send({ type: 'failure', id: frame.id, reason: 'refused', detail: 'not on the relay allow-list' })
      log(`refused ${frame.method} ${frame.path}`)
      return
    }
    try {
      const res = await forward(config, frame)
      send({ type: 'response', id: frame.id, ...res })
      log(`relayed ${frame.method} ${frame.path} → ${res.status} in ${Date.now() - started} ms`)
    } catch (failure) {
      send({ type: 'failure', id: frame.id, reason: failure.reason ?? 'unreachable', detail: (failure.detail ?? '').slice(0, 400) })
      log(`failed ${frame.method} ${frame.path}: ${failure.reason} in ${Date.now() - started} ms`)
    }
  }

  async function connect() {
    pending = false
    if (stopped) return
    if (!check) {
      const result = await selfCheck(config)
      printSelfCheck(result)
      check = result.check
    }
    log(`line: connecting to ${config.relayUrl}`)
    socket = new WebSocketImpl(config.relayUrl, {
      headers: { authorization: `Bearer ${config.token}` },
      maxPayload: MAX_FRAME,
      handshakeTimeout: TIMEOUT_MS,
    })
    socket.on('unexpected-response', (_req, res) => {
      const status = res.statusCode
      if (status === 401 || status === 403) log('!!! line: the platform refused the token (401). Ask the platform admin for the right one.')
      else if (status === 404) log('!!! line: the platform has no relay door switched on (404).')
      else log(`!!! line: the platform answered ${status} instead of opening the line`)
      onState({ connected: false, status })
      socket.terminate()
      schedule(status === 401 || status === 403 || status === 404 ? BACKOFF_REFUSED_MS : backoffMs(attempt++, random))
    })
    socket.on('open', () => {
      attempt = 0
      log('line: connected and authenticated. Waiting for link requests.')
      onState({ connected: true })
      armSilence()
      send({
        type: 'hello',
        protocol: PROTOCOL_VERSION,
        agent: `ezpug-proxy/${VERSION} node/${process.versions.node} ${platform()}-${arch()}`,
        check,
      })
    })
    socket.on('message', data => {
      armSilence()
      let frame
      try {
        frame = JSON.parse(String(data))
      } catch {
        return
      }
      if (frame && typeof frame === 'object') void handle(frame)
    })
    socket.on('close', code => {
      clearTimeout(silence)
      onState({ connected: false, code })
      if (code === 4001) {
        log('!!! line: another relay took over (4001). Only one may run; this one waits a minute.')
        schedule(BACKOFF_REFUSED_MS)
        return
      }
      schedule(backoffMs(attempt++, random))
    })
    socket.on('error', error => {
      log(`line: ${error.code ?? ''} ${error.message ?? error}`.trim())
    })
  }

  void connect()
  return {
    stop() {
      stopped = true
      clearTimeout(silence)
      clearTimeout(retry)
      socket?.close()
    },
  }
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url))
  loadEnvFile(join(process.cwd(), '.env'))
  loadEnvFile(join(here, '.env'))
  const config = readConfig()
  log(`ezpug-proxy ${VERSION} (protocol ${PROTOCOL_VERSION}), node ${process.versions.node}`)
  if (process.argv.includes('--check')) {
    printSelfCheck(await selfCheck(config))
    return
  }
  if (config.token.length < 32) {
    log('!!! EZPUG_RELAY_TOKEN is missing or too short. Ask the platform admin for it, put it in .env, start again.')
    process.exit(2)
  }
  const relay = startRelay(config)
  const stop = signal => {
    log(`${signal}: closing the line`)
    relay.stop()
    setTimeout(() => process.exit(0), 200).unref()
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main()
