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

Configure the API server and the absolute paths used by both Hermes and the
app:

```bash
export MOVIE_DEMO_ROOT="$(pwd -P)/examples/movie-ticket-booking"
export MOVIE_DEMO_DB_PATH="$MOVIE_DEMO_ROOT/movie-demo.db"

hermes -p movie-booking config set API_SERVER_ENABLED true
hermes -p movie-booking config set API_SERVER_KEY "$(openssl rand -hex 32)"
hermes -p movie-booking config set --force MOVIE_DEMO_ROOT "$MOVIE_DEMO_ROOT"
hermes -p movie-booking config set --force MOVIE_DEMO_DB_PATH "$MOVIE_DEMO_DB_PATH"
```

Hermes stores the generated bearer key in the profile's private `.env`; the
command does not print the key.

## 3. Start Hermes

In terminal 1:

```bash
hermes -p movie-booking gateway run
```

The profile gateway exposes its authenticated Sessions API at
`http://127.0.0.1:8642`. Keep this foreground process running.

## 4. Start the app

In terminal 2, from the repository root:

```bash
export MOVIE_DEMO_ROOT="$(pwd -P)/examples/movie-ticket-booking"
export MOVIE_DEMO_DB_PATH="$MOVIE_DEMO_ROOT/movie-demo.db"
export HERMES_API_URL="http://127.0.0.1:8642"
export API_SERVER_KEY="$(hermes -p movie-booking config get API_SERVER_KEY)"
export PORT=3000

npm --prefix "$MOVIE_DEMO_ROOT" run dev
```

Open `http://127.0.0.1:3000`, register a local account, and start a chat.

## Environment

| Variable | Used by | Purpose |
| --- | --- | --- |
| `API_SERVER_KEY` | Hermes and app | Backend-only bearer key; both processes must use the same value |
| `HERMES_API_URL` | App | Hermes API base URL |
| `MOVIE_DEMO_ROOT` | Hermes skill | Absolute example package path |
| `MOVIE_DEMO_DB_PATH` | Hermes and app | Shared absolute SQLite path |
| `PORT` | App | Local HTTP port |

Do not expose these values to browser code or commit local `.env` or database
files.

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

## Verify the package

```bash
npm --prefix examples/movie-ticket-booking test
npm --prefix examples/movie-ticket-booking run typecheck
```

This is a single-process local demo. Its FIFO queues are in memory, and the
Hermes skill plus `moviectl` is a behavioral boundary rather than a production
sandbox.
