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

The helper refuses unrelated, mismatched, stale, or symlinked profile state. A
random versioned owner token is stored privately beside the profile and inside
it; only matching tokens allow an interrupted setup to resume. Completed setups
also revalidate the installed files, configuration, and private API key.

A narrow crash window remains: if the helper stops after Hermes creates the
profile but before its owner marker is written, the next run refuses that
unowned profile. Inspect and remove only that newly created `movie-booking`
profile before retrying setup.

Every Hermes command runs from a helper-owned empty directory with inherited
profile, project, and managed-directory settings cleared. External secret
sources, custom context-engine configuration, and dotenv overrides for this
demo's settings are unsupported.

After interactive `hermes setup`, the helper makes one provider request and
accepts only the exact response `READY`. Hermes has no explicit no-tools flag,
so the helper uses the narrowest empty built-in `context_engine` toolset with
plugin discovery disabled. Readiness proves only that the provider answered at
setup time and may incur provider usage; it does not promise future
availability. Cancellation and termination reach the supervised child process
group, and API-key creation and rotation are atomic and private.

Ports 8642 for Hermes and 3000 for the app must be free.

## 3. Start Hermes

In terminal 1:

```bash
examples/movie-ticket-booking/scripts/setup.sh gateway
```

The profile gateway exposes its authenticated Sessions API at
`http://127.0.0.1:8642`. The helper validates the owned profile and pins every
gateway value in its isolated launch environment. Keep this foreground process
running.

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
| `HOST` | App | HTTP bind address; defaults to `127.0.0.1`, use `0.0.0.0` behind the load balancer |
| `PORT` | App | HTTP port; defaults to `3000` |
| `COOKIE_SECURE` | App | Set to `true` when the browser reaches the app through HTTPS |

Do not expose these values to browser code or commit local key, `.env`, or
database files. The setup helper still owns and pins the private
`API_SERVER_*`, `HERMES_API_URL`, `MOVIE_DEMO_ROOT`, and generated bearer-key
settings; deployment environment files do not replace that boundary.

## Deploy on an Ubuntu 24.04 Compute Engine VM

Use one Ubuntu 24.04 VM with a persistent boot disk. Install the base packages,
Node.js 22 from NodeSource, and WebCMD:

```bash
sudo apt-get update
sudo apt-get install --yes ca-certificates curl git openssl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install --yes nodejs
sudo npm install --global @agentrhq/webcmd
```

### Provision the service account and checkout

Create a system user whose persistent home is `/var/lib/movie-booking`, then
install Hermes as that user. Its installer places the executable under the
user's home, so expose that fixed path to systemd:

```bash
sudo useradd --system --create-home \
  --home-dir /var/lib/movie-booking \
  --shell /usr/sbin/nologin \
  movie-booking
sudo -u movie-booking -H bash -lc \
  'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --skip-setup'
sudo ln -sfn /var/lib/movie-booking/.local/bin/hermes \
  /usr/local/bin/hermes
```

Set `WEBCMD_REF` to a reviewed branch, tag, or full commit that is already
available from the remote. This feature branch is not assumed to be published:

```bash
read -r -p 'Reviewed remote WebCMD branch, tag, or commit: ' WEBCMD_REF
test -n "$WEBCMD_REF"
sudo git clone --no-checkout https://github.com/agentrhq/webcmd.git /opt/webcmd
sudo git -C /opt/webcmd fetch origin "$WEBCMD_REF"
sudo git -C /opt/webcmd checkout --detach FETCH_HEAD
sudo git -C /opt/webcmd rev-parse HEAD
sudo chown -R movie-booking:movie-booking \
  /opt/webcmd /var/lib/movie-booking
```

Confirm that the printed commit is the reviewed revision before continuing.
Verify every runtime command through the same service-user context that
systemd will use:

```bash
sudo -u movie-booking -H bash -lc '
  node --version
  npm --version
  webcmd --version
  hermes --version
'
```

The service user's
`/var/lib/movie-booking/.hermes` and `/var/lib/movie-booking/.webcmd`
directories persist Hermes and hosted WebCMD configuration. The database,
`movie-demo.db-wal`, and `movie-demo.db-shm` also persist beside
`/var/lib/movie-booking/movie-demo.db`. Persistent disks survive process and
VM restarts, but still require regular Compute Engine disk snapshots.

Create the shared runtime file:

```bash
sudo install -o root -g movie-booking -m 0640 /dev/null \
  /etc/movie-booking.env
sudo tee /etc/movie-booking.env >/dev/null <<'EOF'
HOST=0.0.0.0
PORT=3000
COOKIE_SECURE=true
MOVIE_DEMO_DB_PATH=/var/lib/movie-booking/movie-demo.db
EOF
```

Create the Hermes-only environment file without printing secrets to the
terminal:

```bash
sudo install -o root -g movie-booking -m 0640 /dev/null \
  /etc/movie-booking-hermes.env
sudoedit /etc/movie-booking-hermes.env
```

Put only the variables required by the selected Hermes provider and hosted
WebCMD deployment in that file. For example, an API-key provider may require
`OPENAI_API_KEY=...`; a non-default WebCMD endpoint may require
`WEBCMD_CLOUD_API_URL=...`. Do not invent or duplicate credentials that the
interactive setup commands persist under `.hermes` and `.webcmd`. Reassert the
required access after editing:

```bash
sudo chown root:movie-booking \
  /etc/movie-booking.env /etc/movie-booking-hermes.env
sudo chmod 0640 \
  /etc/movie-booking.env /etc/movie-booking-hermes.env
```

Run both interactive setup commands as the service user. Loading the
Hermes-only file into this shell makes the selected provider and hosted WebCMD
overrides available without exposing them to the app service:

```bash
sudo -u movie-booking -H bash -lc '
  set -a
  . /etc/movie-booking.env
  . /etc/movie-booking-hermes.env
  set +a
  cd /opt/webcmd
  webcmd setup
  examples/movie-ticket-booking/scripts/setup.sh setup
'
```

Choose hosted mode in `webcmd setup`. The setup helper remains responsible for
the private Hermes API settings and generated bearer key.

### Install and operate the systemd units

Copy and verify the units on the Ubuntu VM:

```bash
sudo install -o root -g root -m 0644 \
  /opt/webcmd/examples/movie-ticket-booking/deploy/systemd/* \
  /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemd-analyze verify \
  /etc/systemd/system/movie-booking-hermes.service \
  /etc/systemd/system/movie-booking-app.service \
  /etc/systemd/system/movie-booking.target
sudo systemctl enable --now movie-booking.target
```

`movie-booking.target` is the single lifecycle interface:

```bash
sudo systemctl restart movie-booking.target
sudo systemctl stop movie-booking.target
sudo systemctl start movie-booking.target
sudo systemctl status \
  movie-booking.target \
  movie-booking-app.service \
  movie-booking-hermes.service
sudo journalctl -u movie-booking-app.service
sudo journalctl -u movie-booking-hermes.service
```

### Put the GCP HTTPS load balancer in front

Create a global external HTTPS Application Load Balancer with:

- the VM as the only member of one zonal unmanaged instance group;
- the instance group's named port `http:3000`;
- an HTTP health check on port `3000` and path `/healthz`;
- one global backend service and URL map sending all paths to that backend;
- a global static IP, target HTTPS proxy, and Google-managed certificate for
  the custom domain.

The corresponding resource setup is:

```bash
read -r -p 'Google Cloud project ID: ' PROJECT_ID
ZONE=us-central1-a
VM=movie-booking-vm
DOMAIN=demo.example.com

(
set -euo pipefail
: "${PROJECT_ID:?Google Cloud project ID is required}"
gcloud config set project "$PROJECT_ID"
test "$(gcloud config get-value project 2>/dev/null)" = "$PROJECT_ID"

gcloud compute instance-groups unmanaged create movie-booking-ig --zone="$ZONE"
gcloud compute instance-groups unmanaged add-instances movie-booking-ig \
  --zone="$ZONE" --instances="$VM"
gcloud compute instance-groups unmanaged set-named-ports movie-booking-ig \
  --zone="$ZONE" --named-ports=http:3000
gcloud compute health-checks create http movie-booking-health \
  --global --port=3000 --request-path=/healthz
gcloud compute backend-services create movie-booking-backend \
  --global --load-balancing-scheme=EXTERNAL_MANAGED \
  --protocol=HTTP --port-name=http --timeout=300s \
  --global-health-checks --health-checks=movie-booking-health
gcloud compute backend-services add-backend movie-booking-backend \
  --global --instance-group=movie-booking-ig \
  --instance-group-zone="$ZONE"
gcloud compute url-maps create movie-booking-map \
  --global --default-service=movie-booking-backend
gcloud compute addresses create movie-booking-ip \
  --global --ip-version=IPV4 --network-tier=PREMIUM
gcloud compute ssl-certificates create movie-booking-cert \
  --global --domains="$DOMAIN"
gcloud compute target-https-proxies create movie-booking-https-proxy \
  --global --global-url-map --url-map=movie-booking-map \
  --global-ssl-certificates --ssl-certificates=movie-booking-cert
gcloud compute forwarding-rules create movie-booking-https \
  --global --load-balancing-scheme=EXTERNAL_MANAGED \
  --network-tier=PREMIUM --address=movie-booking-ip \
  --target-https-proxy=movie-booking-https-proxy --ports=443
gcloud compute addresses describe movie-booking-ip \
  --global --format='value(address)'
)
```

Point the domain's A record at the printed IP and wait for the managed
certificate to become active. Do not create an HTTP frontend. If one is
required, configure its URL map to redirect every request to HTTPS; never
forward cleartext login or registration traffic.

Tag the VM and permit backend port 3000 only from the current documented IPv4
[Google Front End and health-check
ranges](https://cloud.google.com/load-balancing/docs/firewall-rules):

```bash
gcloud compute instances add-tags "$VM" \
  --zone="$ZONE" --tags=movie-booking-backend
NETWORK_URL=$(gcloud compute instances describe "$VM" \
  --zone="$ZONE" --format='value(networkInterfaces[0].network)')
NETWORK=${NETWORK_URL##*/}
test -n "$NETWORK"
gcloud compute firewall-rules create movie-booking-allow-gfe \
  --direction=INGRESS --action=ALLOW \
  --network="$NETWORK" \
  --target-tags=movie-booking-backend \
  --source-ranges=35.191.0.0/16,130.211.0.0/22 \
  --rules=tcp:3000
```

Do not add public VM ingress for 3000 or 8642, and do not run public listeners
on VM ports 80 or 443. The app listens on `0.0.0.0:3000`; Hermes must remain on
`127.0.0.1:8642`. The VM also needs outbound HTTPS access, through its external
IP or Cloud NAT.

Before publishing DNS, attach a [Cloud Armor rate-limit
policy](https://cloud.google.com/armor/docs/configure-rate-limiting) to
`movie-booking-backend` for an open demo. Start with a measured per-IP limit,
then tune it from load-balancer logs:

```bash
gcloud compute security-policies create movie-booking-demo
gcloud compute security-policies rules create 1000 \
  --security-policy=movie-booking-demo \
  --src-ip-ranges='*' \
  --action=throttle \
  --rate-limit-threshold-count=60 \
  --rate-limit-threshold-interval-sec=60 \
  --conform-action=allow \
  --exceed-action=deny-429 \
  --enforce-on-key=ip
gcloud compute backend-services update movie-booking-backend \
  --global --security-policy=movie-booking-demo
```

For a private demo, use approved identities or a source-range allowlist with a
default deny policy instead. The app does not add another in-process
abuse-control layer.

The deployment also depends on an external release gate: the WebCMD package
containing `district booking-status` must be published and WebCMD Cloud must
deploy it. Search and payment handoff may be demonstrated before that gate,
but provider-verified booking confirmation may not.

### Verify the deployment

Run the repository checks and unit validation on the Ubuntu VM:

```bash
sudo -u movie-booking -H bash -lc '
  cd /opt/webcmd
  npm --prefix examples/movie-ticket-booking test
  npm --prefix examples/movie-ticket-booking run typecheck
'
sudo systemd-analyze verify \
  /etc/systemd/system/movie-booking-hermes.service \
  /etc/systemd/system/movie-booking-app.service \
  /etc/systemd/system/movie-booking.target
```

Verify the running services, local health check, and sockets:

```bash
systemctl is-active movie-booking-hermes.service
systemctl is-active movie-booking-app.service
curl --fail --show-error http://127.0.0.1:3000/healthz
sudo ss -lntp
```

`ss` must show `0.0.0.0:3000` and `127.0.0.1:8642`, with no VM listeners on
ports 80 or 443. From a machine outside the VPC, verify HTTPS and confirm that
direct VM access is blocked:

```bash
curl --fail --show-error https://demo.example.com/healthz
curl --fail --show-error https://demo.example.com/
curl --connect-timeout 5 http://VM_EXTERNAL_IP:3000/healthz
```

The first two commands must succeed with a valid certificate. The direct VM
request must time out or be refused.

Prove the deployed product and its persistent state from an operator
workstation. This acceptance block requires Bash, `curl`, `jq`, and an
authenticated Google Cloud CLI. Keep `PROJECT_ID`, `ZONE`, `VM`, and `DOMAIN`
set to the values used above. It prompts for the new account password without
putting the password or session cookie in a process argument, and its trap
removes every temporary credential, header, and body file:

```bash
(
set -euo pipefail
: "${PROJECT_ID:?Set PROJECT_ID to the deployed Google Cloud project}"
: "${ZONE:?Set ZONE to the VM zone}"
: "${VM:?Set VM to the deployed instance name}"
: "${DOMAIN:?Set DOMAIN to the public HTTPS domain}"

ACCEPTANCE_DIR=$(mktemp -d)
trap 'rm -rf -- "$ACCEPTANCE_DIR"' EXIT HUP INT TERM
umask 077

BASE_URL="https://$DOMAIN"
COOKIE_JAR="$ACCEPTANCE_DIR/cookies"
EMAIL="movie-demo-$(date +%s)-$$@example.com"
MARKER="deployment-persistence-$(date +%s)-$$"

printf 'New demo password (at least 8 characters): ' >&2
IFS= read -r -s ACCOUNT_PASSWORD
printf '\n' >&2
test "${#ACCOUNT_PASSWORD}" -ge 8
printf '%s' "$ACCOUNT_PASSWORD" >"$ACCEPTANCE_DIR/password"
unset ACCOUNT_PASSWORD

jq -n \
  --arg email "$EMAIL" \
  --rawfile password "$ACCEPTANCE_DIR/password" \
  '{email: $email, password: $password}' \
  >"$ACCEPTANCE_DIR/register.json"
curl --fail --silent --show-error \
  --request POST \
  --header 'content-type: application/json' \
  --data-binary "@$ACCEPTANCE_DIR/register.json" \
  --dump-header "$ACCEPTANCE_DIR/register.headers" \
  --cookie-jar "$COOKIE_JAR" \
  "$BASE_URL/api/register" \
  >"$ACCEPTANCE_DIR/register.body"
jq -e --arg email "$EMAIL" '.user.email == $email' \
  "$ACCEPTANCE_DIR/register.body" >/dev/null

grep -i '^set-cookie: movie_demo_session=' \
  "$ACCEPTANCE_DIR/register.headers" \
  >"$ACCEPTANCE_DIR/session-cookie.headers"
test -s "$ACCEPTANCE_DIR/session-cookie.headers"
grep -Eiq '(^|;)[[:space:]]*Secure([;[:space:]]|$)' \
  "$ACCEPTANCE_DIR/session-cookie.headers"
grep -Eiq '(^|;)[[:space:]]*HttpOnly([;[:space:]]|$)' \
  "$ACCEPTANCE_DIR/session-cookie.headers"
grep -Eiq '(^|;)[[:space:]]*SameSite=Lax([;[:space:]]|$)' \
  "$ACCEPTANCE_DIR/session-cookie.headers"

jq -n --arg marker "$MARKER" '{
  city: "Mumbai",
  languages: ["English"],
  formats: ["2D"],
  seatPosition: $marker,
  budgetPaise: 150000
}' >"$ACCEPTANCE_DIR/preferences.json"
curl --fail --silent --show-error \
  --request PUT \
  --header 'content-type: application/json' \
  --data-binary "@$ACCEPTANCE_DIR/preferences.json" \
  --cookie "$COOKIE_JAR" \
  "$BASE_URL/api/preferences" \
  >"$ACCEPTANCE_DIR/preferences.body"
jq -e --arg marker "$MARKER" '.seatPosition == $marker' \
  "$ACCEPTANCE_DIR/preferences.body" >/dev/null

printf '{}\n' >"$ACCEPTANCE_DIR/conversation.json"
curl --fail --silent --show-error \
  --request POST \
  --header 'content-type: application/json' \
  --data-binary "@$ACCEPTANCE_DIR/conversation.json" \
  --cookie "$COOKIE_JAR" \
  "$BASE_URL/api/conversations" \
  >"$ACCEPTANCE_DIR/conversation.body"
CONVERSATION_ID=$(jq -er '.id | select(type == "string" and length > 0)' \
  "$ACCEPTANCE_DIR/conversation.body")

jq -n --arg marker "$MARKER" '{
  message: ("Deployment acceptance " + $marker
    + ": reply with one short confirmation and do not start a booking.")
}' >"$ACCEPTANCE_DIR/chat.json"
curl --fail --silent --show-error \
  --max-time 310 \
  --request POST \
  --header 'content-type: application/json' \
  --data-binary "@$ACCEPTANCE_DIR/chat.json" \
  --cookie "$COOKIE_JAR" \
  "$BASE_URL/api/conversations/$CONVERSATION_ID/chat" \
  >"$ACCEPTANCE_DIR/chat.body"
jq -e '.message.content | type == "string" and length > 0' \
  "$ACCEPTANCE_DIR/chat.body" >/dev/null

wait_for_https() {
  local attempt=0
  until curl --fail --silent --show-error \
    --connect-timeout 5 --max-time 10 \
    "$BASE_URL/healthz" >/dev/null; do
    attempt=$((attempt + 1))
    test "$attempt" -lt 60
    sleep 5
  done
}

verify_state() {
  local output=$1
  curl --fail --silent --show-error \
    --cookie "$COOKIE_JAR" \
    "$BASE_URL/api/bootstrap" >"$output"
  jq -e \
    --arg marker "$MARKER" \
    --arg conversation "$CONVERSATION_ID" \
    '.preferences.seatPosition == $marker
      and any(.conversations[]; .id == $conversation)' \
    "$output" >/dev/null
}

verify_state "$ACCEPTANCE_DIR/bootstrap-before-restart.json"

gcloud compute ssh "$VM" \
  --project="$PROJECT_ID" --zone="$ZONE" \
  --command='sudo systemctl restart movie-booking.target'
wait_for_https
verify_state "$ACCEPTANCE_DIR/bootstrap-after-service-restart.json"

gcloud compute instances reset "$VM" \
  --project="$PROJECT_ID" --zone="$ZONE" --quiet
wait_for_https
verify_state "$ACCEPTANCE_DIR/bootstrap-after-vm-reset.json"

printf 'Deployment acceptance passed for %s with marker %s\n' \
  "$EMAIL" "$MARKER"
)
```

Finally, run a read-only hosted WebCMD command as the service user. This proves
that hosted configuration survived without starting checkout or changing
District state:

```bash
sudo -u movie-booking -H bash -lc '
  set -a
  . /etc/movie-booking-hermes.env
  set +a
  webcmd district search movie --tab movies --limit 1 -f json
'
```

## Booking flow

1. Hermes reads saved preferences, then searches District for current
   screenings and seats.
2. `moviectl` records the selected movie, cinema, time, seats, and amount.
3. Hermes displays that exact summary and waits for an explicit yes.
4. Checkout runs once and returns a short-lived WebCMD-owned hosted browser
   link; the raw District checkout URL stays inside the hosted command, and the
   user completes payment on District through that viewer.
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
