import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { WebSocketServer } from 'ws'
import { backoffMs, forward, isAllowed, isPrivateAddress, pickHeaders, startRelay } from '../relay.mjs'

const TOKEN = 'a'.repeat(64)

async function fakeEzlan() {
  const seen = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body, headers: req.headers })
      res.setHeader('content-type', 'application/json')
      res.setHeader('set-cookie', 'leak=1')
      if (req.url === '/api/oauth/token') res.end(JSON.stringify({ access_token: 'x'.repeat(64), token_type: 'Bearer', expires_in: 604800 }))
      else res.end(JSON.stringify({ sub: 'u1', tickets: [] }))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() }
}

async function fakePlatform({ refuse = false } = {}) {
  const http = createServer()
  const wss = new WebSocketServer({ noServer: true })
  const frames = []
  let socket = null
  const connected = new Promise(resolve => {
    http.on('upgrade', (req, sock, head) => {
      if (refuse || req.headers.authorization !== `Bearer ${TOKEN}`) {
        sock.end('HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n')
        return
      }
      wss.handleUpgrade(req, sock, head, ws => {
        socket = ws
        ws.on('message', data => frames.push(JSON.parse(String(data))))
        resolve(ws)
      })
    })
  })
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  return {
    url: `ws://127.0.0.1:${http.address().port}/venue/relay`,
    frames,
    connected,
    send: frame => socket.send(JSON.stringify(frame)),
    close: () => {
      wss.clients.forEach(c => c.terminate())
      http.close()
    },
  }
}

const until = async (predicate, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (predicate()) return
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error('timed out')
}

test('the allow-list is exactly token and userinfo, POST only', () => {
  assert.equal(isAllowed('POST', '/api/oauth/token'), true)
  assert.equal(isAllowed('POST', '/api/oauth/userinfo'), true)
  assert.equal(isAllowed('GET', '/api/oauth/authorize'), false)
  assert.equal(isAllowed('POST', '/api/oauth/authorize'), false)
  assert.equal(isAllowed('GET', '/api/oauth/token'), false)
  assert.equal(isAllowed('POST', '/api/oauth/token/../admin'), false)
})

test('private addresses are the venue copy, the public ezLAN is not', () => {
  for (const a of ['10.10.111.5', '192.168.1.2', '172.16.0.1', '172.31.255.1', '127.0.0.1', 'fd00::1', '::1']) assert.equal(isPrivateAddress(a), true, a)
  for (const a of ['152.53.253.187', '172.32.0.1', '8.8.8.8', '2a0a::1']) assert.equal(isPrivateAddress(a), false, a)
})

test('backoff is capped and jittered', () => {
  assert.equal(backoffMs(0, () => 0), 500)
  assert.equal(backoffMs(0, () => 1), 1000)
  assert.equal(backoffMs(20, () => 1), 30000)
})

test('headers are filtered both ways', () => {
  assert.deepEqual(pickHeaders({ Authorization: 'b', Cookie: 'c', 'X-Access-Token': 't', host: 'evil' }, ['authorization', 'x-access-token']), {
    authorization: 'b',
    'x-access-token': 't',
  })
})

test('forward refuses anything off the list and never leaves for another URL', async () => {
  const ezlan = await fakeEzlan()
  const config = { ezlanUrl: ezlan.url, insecure: false }
  await assert.rejects(forward(config, { path: '/api/oauth/authorize', headers: {}, body: '' }), { reason: 'refused' })
  await assert.rejects(forward(config, { path: 'https://evil.example/api/oauth/token', headers: {}, body: '' }), { reason: 'refused' })
  assert.equal(ezlan.seen.length, 0)
  ezlan.close()
})

test('end to end: hello, a relayed token call, a refused call, ping/pong', async () => {
  const ezlan = await fakeEzlan()
  const platform = await fakePlatform()
  const relay = startRelay({ token: TOKEN, relayUrl: platform.url, ezlanUrl: ezlan.url, insecure: false })
  await platform.connected
  await until(() => platform.frames.some(f => f.type === 'hello'))
  const hello = platform.frames.find(f => f.type === 'hello')
  assert.equal(hello.protocol, 1)
  assert.equal(hello.check.ezlan, ezlan.url)

  platform.send({
    type: 'request',
    id: 'r1',
    method: 'POST',
    path: '/api/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: 'nope' },
    body: 'grant_type=authorization_code&code=abc',
  })
  await until(() => platform.frames.some(f => f.id === 'r1'))
  const answer = platform.frames.find(f => f.id === 'r1')
  assert.equal(answer.type, 'response')
  assert.equal(answer.status, 200)
  assert.deepEqual(Object.keys(answer.headers), ['content-type'])
  assert.match(answer.body, /access_token/)
  const call = ezlan.seen.find(s => s.body.includes('code=abc'))
  assert.equal(call.url, '/api/oauth/token')
  assert.equal(call.headers.cookie, undefined)

  platform.send({ type: 'request', id: 'r2', method: 'POST', path: '/api/oauth/authorize', headers: {}, body: '' })
  await until(() => platform.frames.some(f => f.id === 'r2'))
  assert.equal(platform.frames.find(f => f.id === 'r2').reason, 'refused')

  platform.send({ type: 'ping', at: 42 })
  await until(() => platform.frames.some(f => f.type === 'pong'))
  assert.equal(platform.frames.find(f => f.type === 'pong').at, 42)

  relay.stop()
  platform.close()
  ezlan.close()
})

test('a wrong token never opens the line', async () => {
  const ezlan = await fakeEzlan()
  const platform = await fakePlatform({ refuse: true })
  const states = []
  const relay = startRelay({ token: TOKEN, relayUrl: platform.url, ezlanUrl: ezlan.url, insecure: false }, { onState: s => states.push(s) })
  await until(() => states.some(s => s.status === 401))
  assert.equal(states.some(s => s.connected), false)
  relay.stop()
  platform.close()
  ezlan.close()
})
