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
examples/movie-ticket-booking/scripts/setup.sh setup
```

The helper refuses an unrelated existing `movie-booking` profile. It records
ownership in a sibling marker, so an interrupted helper-owned setup can resume
safely; once complete, rerunning skips model setup and its provider request.

Before every Hermes setup or launch, the helper reads the target dotenv, YAML,
secret-source, and managed-scope configuration through Hermes' own parsing
rules. This raw preflight does not invoke the Hermes CLI or fetch an external
secret source. It rejects settings that could override this demo's key, host,
port, root, or database path.

After interactive `hermes setup`, the helper makes one minimal provider request
to prove that the configured model can answer. This may incur provider usage.
A cancelled setup or failed readiness request exits nonzero and leaves only a
marker-owned partial profile for the next run to resume; demo files and the API
key are installed only after readiness succeeds. Key creation is atomic and
signal-safe.

Ports 8642 for Hermes and 3000 for the app must be free.

## 3. Start Hermes

In terminal 1:

```bash
examples/movie-ticket-booking/scripts/setup.sh gateway
```

The profile gateway exposes its authenticated Sessions API at
`http://127.0.0.1:8642`. The helper pins every gateway value after its raw
preflight, so later Hermes loaders cannot replace them. Keep this foreground
process running.

## 4. Start the app

In terminal 2, from the repository root:

```bash
examples/movie-ticket-booking/scripts/setup.sh app
```

Open `http://127.0.0.1:3000`, register a local account, and start a chat.
The helper passes the bearer key only to each launched process; it never prints
the key or leaves `API_SERVER_KEY` in either shell environment.

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
examples/movie-ticket-booking/scripts/setup.sh rotate-key
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
