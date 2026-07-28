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
- Hermes Agent installed; the setup below configures a working model in a
  fresh profile
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
(
  set -eu

  MOVIE_DEMO_ROOT="$(pwd -P)/examples/movie-ticket-booking"
  MOVIE_DEMO_PROFILE="$HOME/.hermes/profiles/movie-booking"
  MOVIE_DEMO_API_KEY_FILE="$MOVIE_DEMO_PROFILE/.movie-demo-api-key"

  if [ -e "$MOVIE_DEMO_PROFILE" ] || [ -L "$MOVIE_DEMO_PROFILE" ]; then
    echo "Profile already exists; refusing to modify it: $MOVIE_DEMO_PROFILE" >&2
    exit 1
  fi

  npm --prefix "$MOVIE_DEMO_ROOT" install
  hermes profile create movie-booking
  hermes -p movie-booking setup

  MOVIE_DEMO_SECRETS_JSON="$(hermes -p movie-booking config get secrets --json)"
  MOVIE_DEMO_MANAGED_DIR="${HERMES_MANAGED_DIR-}"
  MOVIE_DEMO_PROFILE="$MOVIE_DEMO_PROFILE" \
  MOVIE_DEMO_MANAGED_DIR="$MOVIE_DEMO_MANAGED_DIR" \
  MOVIE_DEMO_SECRETS_JSON="$MOVIE_DEMO_SECRETS_JSON" \
  node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const owned = new Set([
  'API_SERVER_ENABLED',
  'API_SERVER_KEY',
  'API_SERVER_HOST',
  'API_SERVER_PORT',
  'MOVIE_DEMO_ROOT',
  'MOVIE_DEMO_DB_PATH',
]);

function assignedKeys(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/.exec(line);
    return match ? [match[1]] : [];
  });
}

const profileEnv = path.join(process.env.MOVIE_DEMO_PROFILE, '.env');
const managedDir = process.env.MOVIE_DEMO_MANAGED_DIR.trim() || '/etc/hermes';
const managedEnv = path.join(managedDir, '.env');
for (const file of [profileEnv, managedEnv]) {
  const conflicts = assignedKeys(file).filter((key) => owned.has(key));
  if (conflicts.length) {
    throw new Error(`${file} owns demo variables: ${conflicts.join(', ')}`);
  }
}

const enabled = [];
function findEnabled(value, prefix = 'secrets') {
  if (!value || typeof value !== 'object') return;
  if (value.enabled === true) enabled.push(prefix);
  for (const [key, child] of Object.entries(value)) {
    findEnabled(child, `${prefix}.${key}`);
  }
}
findEnabled(JSON.parse(process.env.MOVIE_DEMO_SECRETS_JSON));
if (enabled.length) {
  throw new Error(`Disable external secret sources for this profile: ${enabled.join(', ')}`);
}
NODE

  cp "$MOVIE_DEMO_ROOT/hermes/SOUL.md" "$MOVIE_DEMO_PROFILE/SOUL.md"
  mkdir -p "$MOVIE_DEMO_PROFILE/skills"
  cp -R "$MOVIE_DEMO_ROOT/hermes/skills/movie-ticket-booking" "$MOVIE_DEMO_PROFILE/skills/"

  umask 077
  MOVIE_DEMO_KEY_TMP="$(mktemp "$MOVIE_DEMO_PROFILE/.movie-demo-api-key.tmp.XXXXXX")"
  trap '[ ! -e "$MOVIE_DEMO_KEY_TMP" ] || unlink "$MOVIE_DEMO_KEY_TMP"' 0 HUP INT TERM
  openssl rand -hex 32 > "$MOVIE_DEMO_KEY_TMP"
  chmod 600 "$MOVIE_DEMO_KEY_TMP"
  mv -f "$MOVIE_DEMO_KEY_TMP" "$MOVIE_DEMO_API_KEY_FILE"
  trap - 0 HUP INT TERM
)
```

The existence check runs before this section mutates anything. It will not
overwrite or delete an existing `movie-booking` profile. The fresh profile has
no inherited configuration: complete its interactive model setup before the
demo files are copied. If setup is cancelled, later commands stop and the new
profile remains for you to inspect; rerunning this block safely refuses to
modify it.

The read-only preflight rejects any of the six demo variables in the fresh
profile or machine-managed `.env`, and rejects enabled external secret sources.
Those are the built-in layers that can override launch values. The key is
written to a same-directory temporary file and atomically renamed only after
`openssl` succeeds; the subshell confines `umask 077`.

Ports 8642 for Hermes and 3000 for the app must be free. To change 8642, set
`API_SERVER_PORT` and `HERMES_API_URL` to the same new port. To change 3000,
set `PORT` and open that port in the browser.

## 3. Start Hermes

In terminal 1:

```bash
MOVIE_DEMO_ROOT="$(pwd -P)/examples/movie-ticket-booking"
MOVIE_DEMO_DB_PATH="$MOVIE_DEMO_ROOT/movie-demo.db"
MOVIE_DEMO_API_KEY_FILE="$HOME/.hermes/profiles/movie-booking/.movie-demo-api-key"

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
MOVIE_DEMO_ROOT="$(pwd -P)/examples/movie-ticket-booking"
MOVIE_DEMO_DB_PATH="$MOVIE_DEMO_ROOT/movie-demo.db"
MOVIE_DEMO_API_KEY_FILE="$HOME/.hermes/profiles/movie-booking/.movie-demo-api-key"

HERMES_API_URL="http://127.0.0.1:8642" \
API_SERVER_KEY="$(cat "$MOVIE_DEMO_API_KEY_FILE")" \
PORT=3000 \
MOVIE_DEMO_DB_PATH="$MOVIE_DEMO_DB_PATH" \
npm --prefix "$MOVIE_DEMO_ROOT" run dev
```

Open `http://127.0.0.1:3000`, register a local account, and start a chat.
The bearer key is scoped to each launch command; stopping the processes leaves
no `API_SERVER_KEY` in either shell environment.

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
(
  set -eu

  MOVIE_DEMO_API_KEY_FILE="$HOME/.hermes/profiles/movie-booking/.movie-demo-api-key"
  MOVIE_DEMO_PROFILE="${MOVIE_DEMO_API_KEY_FILE%/*}"
  umask 077
  MOVIE_DEMO_KEY_TMP="$(mktemp "$MOVIE_DEMO_PROFILE/.movie-demo-api-key.tmp.XXXXXX")"
  trap '[ ! -e "$MOVIE_DEMO_KEY_TMP" ] || unlink "$MOVIE_DEMO_KEY_TMP"' 0 HUP INT TERM
  openssl rand -hex 32 > "$MOVIE_DEMO_KEY_TMP"
  chmod 600 "$MOVIE_DEMO_KEY_TMP"
  mv -f "$MOVIE_DEMO_KEY_TMP" "$MOVIE_DEMO_API_KEY_FILE"
  trap - 0 HUP INT TERM
)
```

Both start commands read the new value on their next launch. To remove only
this demo's API key after stopping both processes, run this in the current
shell so it also clears any value exported by an older version of this guide:

```bash
MOVIE_DEMO_API_KEY_FILE="$HOME/.hermes/profiles/movie-booking/.movie-demo-api-key"
rm -f "$MOVIE_DEMO_API_KEY_FILE"
unset API_SERVER_KEY MOVIE_DEMO_API_KEY_FILE
```

## Verify the package

```bash
npm --prefix examples/movie-ticket-booking test
npm --prefix examples/movie-ticket-booking run typecheck
```

This is a single-process local demo. Its FIFO queues are in memory, and the
Hermes skill plus `moviectl` is a behavioral boundary rather than a production
sandbox.
