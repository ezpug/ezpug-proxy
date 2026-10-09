# ezpug-proxy: the venue relay

**DE.** Im LAN-Netz der SaarLAN zeigt `saar-lan.de` auf eine **lokale Kopie** von ezLAN. Wer dort
seinen SaarLAN-Account mit EZPug verknüpft, bekommt den Code von dieser Kopie, und EZPug (im
Internet) kann ihn nicht einlösen. Dieses kleine Programm läuft auf **irgendeinem Rechner im
LAN**, baut selbst eine Verbindung **nach draußen** zu EZPug auf und erledigt genau zwei Aufrufe
für EZPug gegen die lokale Kopie: Token tauschen und Benutzerinfo lesen. Sonst nichts. Kein
offener Port, keine DNS-Änderung, nichts einzurichten außer dem Token.

**EN.** On the SaarLAN venue network, `saar-lan.de` points at a **local copy** of ezLAN. A
SaarLAN link made there gets its code from that copy, which EZPug (on the internet) cannot
redeem. This relay runs on **any machine in the LAN**, dials **out** to EZPug and performs
exactly two calls against the local copy for it: the token exchange and the userinfo read.
Nothing else. No open port, no DNS change, nothing to set up but the token.

## Run it (Docker, recommended)

```bash
git clone git@github.com:ezpug/ezpug-proxy.git && cd ezpug-proxy
echo "EZPUG_RELAY_TOKEN=<the token from the platform admin>" > .env
docker compose up -d --build && docker logs -f ezpug-relay
```

Without compose: `docker build -t ezpug-relay . && docker run -d --name ezpug-relay --restart unless-stopped --network host --env-file .env ezpug-relay`

`--network host` matters: the relay must use the **venue's** DNS. Stop it with
`docker compose down` (or `docker rm -f ezpug-relay`).

Without Docker (Node 20+): `npm ci && npm start`. Just the self-check: `npm run check`.

## What "working" looks like

```
self-check: https://saar-lan.de
  resolves to: 10.10.111.5
  verdict: LOCAL venue copy of ezLAN. This is what the relay is for.
  token endpoint: 400 {"error":"invalid_request",...}
  reachable: yes (TLS verified)
line: connected and authenticated. Waiting for link requests.
```

Then one line per relayed call, e.g. `relayed POST /api/oauth/token → 200 in 85 ms`.
Lines starting with `!!!` say what is wrong: the public ezLAN instead of the local one (run it
on the venue network, with `--network host`), the token refused (ask for the right one), or
TLS failing (only on a network you trust: `EZPUG_RELAY_INSECURE_TLS=1`).

## Settings

| Variable | Default | |
|---|---|---|
| `EZPUG_RELAY_TOKEN` | (required) | the platform's `EZPUG_VENUE_RELAY_TOKEN` |
| `EZPUG_RELAY_URL` | `wss://api.pug.saar-lan.de/venue/relay` | the platform's relay door |
| `EZPUG_RELAY_EZLAN_URL` | `https://saar-lan.de` | resolved by this network's DNS |
| `EZPUG_RELAY_INSECURE_TLS` | off | only for a local copy with a broken certificate |

The wire format is in `PROTOCOL.md`. Tests: `npm test`.
