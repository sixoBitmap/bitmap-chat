# Deploying Bitmap Chat to chat.bitmap.center

The email app (btcmail) runs as a Render Web Service from
`github.com/sixoBitmap/btcmail`, with a 1 GB disk at `/data`, and serves
`bitmap.center` (apex A record → `216.24.57.1`).

Render runs **one app per service** — two apps cannot share an instance. So
"the same server" means: a **second Web Service in the same Render account**,
from its own repo, with `chat.bitmap.center` as its custom domain. Same
account, same dashboard, same billing; separate container.

---

## 1 · Put the code on GitHub

Already done: the code lives on the **`main`** branch of
`github.com/sixoBitmap/bitmap-chat`.

`.gitignore` keeps `.env`, `.jwt-secret`, `.admin.json`, `.claims.json`,
`.questions.json`, `.free-quota.json` and `.system-prompt.txt` out of the repo
— check `git status` still shows none of them before any future push.

That repo previously held an unrelated `live-chat.html` prototype; `main` was
overwritten on purpose. The old commit is still reachable through the `mm` tag
that was already on it, so nothing is actually gone.

## 2 · Create the Render service

New + → **Web Service** → the `bitmap-chat` repo → **Runtime: Docker** (it
picks up the `Dockerfile`).

- **Region:** the same one btcmail uses — check its Settings page.
- **Instance type:** Starter or higher. Free will not do: free services sleep
  after 15 idle minutes (a sleeping service loses every in-memory crawl and
  makes the first visitor wait ~1 minute) and **cannot have a disk**.
- **Health check path:** `/health`
- **Disk:** add one, name `data`, mount path `/data`, 1 GB.

Everything else is default. `PORT` is injected by Render and the server reads it.

## 3 · Environment variables

| key | value | why |
|---|---|---|
| `ANTHROPIC_API_KEY` | your key | free + bought questions run on it; visitors with their own key never touch it |
| `ADMIN_CODE` | your admin code | `/admin.html`; leave unset to disable the panel entirely |
| `JWT_SECRET` | any long random string | **set this** — without it every deploy signs out every wallet |
| `ORD_API` | `https://ordinals.com,https://ord.xverse.app` | see §5 |
| `PAY_ADDRESS` | `34DXHZZebFcBkq5VsNDmMkVMNu7hWdRL14` | where question payments go — confirm before going live |
| `ORDERS_FILE` | `/data/questions.json` | bought balances + order history |
| `QUOTA_FILE` | `/data/free-quota.json` | today's free questions per address |
| `ADMIN_FILE` | `/data/admin.json` | promo codes, admins, PathScriber registry |
| `CLAIMS_FILE` | `/data/claims.json` | manually claimed PathScribers |
| `BUGS_FILE` | `/data/bugs.json` | bug reports shown in the admin panel |
| `BLOCKART_FILE` | `/data/blockart.json` | district mosaics; a block is fetched and laid out once, then cached forever |
| `MARKET_FILE` | `/data/market.json` | parcel listings — signed offers only, never coins or keys |
| `PROMPT_FILE` | `/data/system-prompt.txt` | the prompt saved from the admin panel |

**The five file paths are not optional.** Render's container filesystem is
wiped on every deploy and restart; without them, a redeploy erases everyone's
paid question balances, the order history, promo codes and the live prompt.

Optional knobs: `FREE_BASE` (free questions/day, default 1), `FREE_MAX_PER_DAY`
(cap, 0 = uncapped), `DAILY_TOKEN_LIMIT` (server-key spend guard),
`FREE_CONTEXT_CAP`, `WALLET_GATE=0` (open access), `GATE_BITMAP`.

## 4 · The domain

In the service → **Settings → Custom Domains** → add `chat.bitmap.center`.
Render shows the target host; at the DNS provider for `bitmap.center` add:

```
CNAME   chat   <your-service>.onrender.com
```

Leave the apex `A @ 216.24.57.1` alone — that is btcmail. Render issues the TLS
certificate automatically once the CNAME resolves (usually minutes).

## 5 · The one real gotcha: ordinals.com blocks Render

`ordinals.com` returns 403 to Render's datacenter IPs — the same thing btcmail
hit. The app talks to nothing else for on-chain data, so **without `ORD_API`
every crawl fails in production.**

`https://ord.xverse.app` serves every recursive endpoint this app needs
(verified: `/r/blockinfo`, `/r/children`, `/r/parents`, `/r/sat/<sat>/<page>`,
`/r/sat/<sat>/at/N`, `/r/inscription` — with `address` — and `/content/`,
including the new bitmap-index pages 9 and 10).

Its trade-off is freshness: its load balancer serves nodes that lag. Measured
while writing this: xverse at block 961,003 against ordinals.com at 961,639 —
about 4½ days behind. What that means in practice:

- a bitmap or parcel inscribed in the last few days may not resolve yet;
- a PathScriber minted today will report *"ordinals.com doesn't know that
  inscription yet"* until the node catches up;
- ownership after a very recent transfer can be stale, so a brand-new buyer may
  fail the wallet gate for a while.

Nothing breaks; recent things are just invisible for a few days. If that
matters, the fix is your own ord node (or any gateway that serves `/r/*`) in
`ORD_API` — the code needs no change, it is a list.

Browser-side requests (the inscription iframes in the tree, the images) go to
ordinals.com from the visitor's own residential IP, so those are unaffected.

## 6 · After the first deploy

1. `https://chat.bitmap.center/health` → `{"ok":true}`
2. `/api/config` → `maxBitmap: 941999` and your `payTo`
3. Explore a small bitmap end to end — this proves `ORD_API` is working.
4. `/admin.html` → connect the 114588 wallet, enter the admin code, check the
   Promo codes and PathScribers tabs load.
5. Buy nothing yet: send **one** small real payment yourself and confirm it
   credits, before telling anyone the app is live.

## 7 · Backups

The disk holds real money-adjacent state (balances, orders). Render disks are
not snapshotted on the Starter plan in a way you can self-restore quickly —
download `/data/questions.json` and `/data/admin.json` occasionally, or add a
periodic copy to object storage. Same recommendation still open for btcmail's
SQLite disk.
