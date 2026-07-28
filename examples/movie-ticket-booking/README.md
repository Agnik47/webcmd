# Hermes Movie-Ticket Booking Demo

A local authenticated chat app uses one dedicated Hermes profile to recommend
District screenings and seats. A small `moviectl` wrapper maps each app user to
an isolated hosted WebCMD workspace, records booking state in SQLite, and stops
at District's payment page. Only District's booking-status result can confirm a
booking.

> Hosted release gate: this checkout does not make the complete hosted flow
> live. `district booking-status` works in WebCMD Cloud only after this WebCMD
> package is published and `webcmd-cloud` upgrades and deploys that release.
> Until then, do not claim or demo provider-verified hosted confirmation.

## Prerequisites

- Node.js 22.5 or newer
- Hermes Agent configured with a working model
- WebCMD installed
- A WebCMD Cloud account and API key
- macOS or Linux with `openssl`

Run every setup command from the WebCMD repository root.

## 1. Configure hosted WebCMD

```bash
webcmd setup
```

Choose `hosted` and enter the Cloud API key at the prompt. Do not put the key
in this repository, the Hermes skill, or chat.

## 2. Install the example and Hermes profile

```bash
npm --prefix examples/movie-ticket-booking install
hermes profile create movie-booking --clone
cp examples/movie-ticket-booking/hermes/SOUL.md ~/.hermes/profiles/movie-booking/SOUL.md
mkdir -p ~/.hermes/profiles/movie-booking/skills
cp -R examples/movie-ticket-booking/hermes/skills/movie-ticket-booking ~/.hermes/profiles/movie-booking/skills/
```

`--clone` copies the active Hermes profile's model configuration and
credentials, but starts this profile with fresh sessions and memory.

Create one profile-owned API key file, then remove only this demo's variables
from the cloned `.env`:

```bash
export MOVIE_DEMO_ROOT="$(pwd -P)/examples/movie-ticket-booking"
export MOVIE_DEMO_DB_PATH="$MOVIE_DEMO_ROOT/movie-demo.db"
export MOVIE_DEMO_PROFILE="$HOME/.hermes/profiles/movie-booking"
export MOVIE_DEMO_API_KEY_FILE="$MOVIE_DEMO_PROFILE/.movie-demo-api-key"

umask 077
openssl rand -hex 32 > "$MOVIE_DEMO_API_KEY_FILE"
chmod 600 "$MOVIE_DEMO_API_KEY_FILE"

node <<'NODE'
const fs = require('node:fs');
const envPath = `${process.env.MOVIE_DEMO_PROFILE}/.env`;
const demoKeys = new Set([
  'API_SERVER_ENABLED',
  'API_SERVER_KEY',
  'API_SERVER_HOST',
  'API_SERVER_PORT',
  'MOVIE_DEMO_ROOT',
  'MOVIE_DEMO_DB_PATH',
]);
const lines = fs.existsSync(envPath)
  ? fs.readFileSync(envPath, 'utf8').split(/\r?\n/)
  : [];
const kept = lines.filter((line) => {
  const key = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/.exec(line)?.[1];
  return !key || !demoKeys.has(key);
});
fs.writeFileSync(envPath, `${kept.join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600 });
fs.chmodSync(envPath, 0o600);
NODE
```

Hermes intentionally gives its profile `.env` precedence over stale shell
exports. The scrub prevents inherited demo values from overriding the launch
command while preserving the cloned model credentials. The generated key stays
outside the repository with mode 600 and is never printed.

Ports 8642 for Hermes and 3000 for the app must be free. To change 8642, set
`API_SERVER_PORT` and `HERMES_API_URL` to the same new port. To change 3000,
set `PORT` and open that port in the browser.

## 3. Start Hermes

In terminal 1:

```bash
export MOVIE_DEMO_ROOT="$(pwd -P)/examples/movie-ticket-booking"
export MOVIE_DEMO_DB_PATH="$MOVIE_DEMO_ROOT/movie-demo.db"
export MOVIE_DEMO_API_KEY_FILE="$HOME/.hermes/profiles/movie-booking/.movie-demo-api-key"

API_SERVER_ENABLED=true \
API_SERVER_KEY="$(cat "$MOVIE_DEMO_API_KEY_FILE")" \
API_SERVER_HOST=127.0.0.1 \
API_SERVER_PORT=8642 \
MOVIE_DEMO_ROOT="$MOVIE_DEMO_ROOT" \
MOVIE_DEMO_DB_PATH="$MOVIE_DEMO_DB_PATH" \
hermes -p movie-booking gateway run
```

The profile gateway exposes its authenticated Sessions API at
`http://127.0.0.1:8642`. Keep this foreground process running.

## 4. Start the app

In terminal 2, from the repository root:

```bash
export MOVIE_DEMO_ROOT="$(pwd -P)/examples/movie-ticket-booking"
export MOVIE_DEMO_DB_PATH="$MOVIE_DEMO_ROOT/movie-demo.db"
export MOVIE_DEMO_API_KEY_FILE="$HOME/.hermes/profiles/movie-booking/.movie-demo-api-key"
export HERMES_API_URL="http://127.0.0.1:8642"
export API_SERVER_KEY="$(cat "$MOVIE_DEMO_API_KEY_FILE")"
export PORT=3000

npm --prefix "$MOVIE_DEMO_ROOT" run dev
```

Open `http://127.0.0.1:3000`, register a local account, and start a chat.

## Environment

| Variable | Used by | Purpose |
| --- | --- | --- |
| `API_SERVER_KEY` | Hermes and app | Backend-only bearer key; both processes must use the same value |
| `API_SERVER_HOST` | Hermes | API bind address, pinned to loopback |
| `API_SERVER_PORT` | Hermes | API port, pinned to match `HERMES_API_URL` |
| `HERMES_API_URL` | App | Hermes API base URL |
| `MOVIE_DEMO_ROOT` | Hermes skill | Absolute example package path |
| `MOVIE_DEMO_DB_PATH` | Hermes and app | Shared absolute SQLite path |
| `PORT` | App | Local HTTP port |

Do not expose these values to browser code or commit local key, `.env`, or
database files.

## Booking flow

1. Hermes reads saved preferences, then searches District for current
   screenings and seats.
2. `moviectl` records the selected movie, cinema, time, seats, and amount.
3. Hermes displays that exact summary and waits for an explicit yes.
4. Checkout runs once and returns District's payment link; the user completes
   payment on District.
5. A user's payment claim triggers `booking-status`. It is not proof.
6. The app shows `confirmed` only when District returns that status with a
   non-empty booking reference.

If login is required, complete it only in WebCMD's hosted browser handoff.
Never send passwords, OTPs, cookies, or payment details through chat.

## Stop

Press `Ctrl-C` in the app terminal, then in the Hermes gateway terminal.

The SQLite database remains at `MOVIE_DEMO_DB_PATH`. Hosted District browser
state remains in the derived WebCMD workspace.

To rotate the local API key, stop both processes and run:

```bash
export MOVIE_DEMO_API_KEY_FILE="$HOME/.hermes/profiles/movie-booking/.movie-demo-api-key"
umask 077
openssl rand -hex 32 > "$MOVIE_DEMO_API_KEY_FILE"
chmod 600 "$MOVIE_DEMO_API_KEY_FILE"
```

Both start commands read the new value on their next launch. To remove only
this demo's API key after stopping both processes:

```bash
export MOVIE_DEMO_API_KEY_FILE="$HOME/.hermes/profiles/movie-booking/.movie-demo-api-key"
rm -f "$MOVIE_DEMO_API_KEY_FILE"
```

## Verify the package

```bash
npm --prefix examples/movie-ticket-booking test
npm --prefix examples/movie-ticket-booking run typecheck
```

This is a single-process local demo. Its FIFO queues are in memory, and the
Hermes skill plus `moviectl` is a behavioral boundary rather than a production
sandbox.
