# Protocol 1

The platform's statement of this protocol is `packages/contracts/src/venue-relay.ts` in the
`ezpug` repo. This file restates it; the two are changed together, never imported.

1. The relay opens a WebSocket to `wss://api.pug.saar-lan.de/venue/relay` with
   `Authorization: Bearer <token>`. Wrong token: `401` before the upgrade. Platform without a
   token configured: `404`. One relay at a time; a second line replaces the first.
2. First frame from the relay: `{type:"hello", protocol:1, agent, check}` with the self-check
   (`ezlan`, `addresses`, `local`, `tls`, `reachable`).
3. Platform → relay: `{type:"request", id, method:"POST", path, headers, body}`. Relay → platform:
   `{type:"response", id, status, headers, body}` or `{type:"failure", id, reason, detail?}` with
   `reason` one of `refused | unreachable | timeout | too-large`.
4. Only `POST /api/oauth/token` and `POST /api/oauth/userinfo`, checked on both ends. Request
   headers kept: `accept`, `authorization`, `content-type`, `x-access-token`. Response headers
   kept: `content-type`. Bodies: request ≤ 8 KiB, response ≤ 256 KiB, frame ≤ 512 KiB.
   10 s per call.
5. Heartbeat: the platform sends `{type:"ping", at}` every 15 s, the relay answers
   `{type:"pong", at}`. 45 s of silence either way ends the line; the relay reconnects forever
   with capped, jittered backoff (1 s doubling to 30 s; 60 s after a refused token).
6. Secrets: the relay holds no ezLAN secret. Neither side logs a body, an `authorization`, an
   `x-access-token` or the relay token.
