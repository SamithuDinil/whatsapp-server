# CampusFlow WhatsApp server

Links one WhatsApp account (WhatsApp, Linked devices, Link a device) and sends CampusFlow messages from it. Unofficial: it uses the WhatsApp Web protocol through Baileys.

## Run

1. `npm install`
2. Copy `.env.example` to `.env` and fill it in. `ALLOWED_EMAILS` are the verified CampusFlow accounts allowed to send.
3. `node --env-file=.env server.js` (Node 20+)
4. Host it on an always-on machine with HTTPS and keep the `auth` folder on a persistent disk (a small VPS, Railway or Render with a volume). Firebase Hosting and the free Firebase plan cannot run it.
5. In CampusFlow, open **WhatsApp**, paste the server URL, scan the QR with the phone.

## Safety

- Use a dedicated number. Unofficial automation can get a number banned.
- Messages are queued with a random 4 to 9 second gap and capped per day (`DAILY_LIMIT`).
- Only message guardians who expect to hear from you.
