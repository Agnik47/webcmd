#!/bin/sh

set -eu
umask 077

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd -P)
MOVIE_DEMO_ROOT=$(CDPATH= cd "$SCRIPT_DIR/.." && pwd -P)
PROFILE_NAME=movie-booking
PROFILES_ROOT="$HOME/.hermes/profiles"
PROFILE_DIR="$PROFILES_ROOT/$PROFILE_NAME"
OWNER_DIR="$PROFILES_ROOT/.$PROFILE_NAME.webcmd-demo"
OWNER_STATE="$OWNER_DIR/owner"
PROFILE_STATE="$PROFILE_DIR/.movie-demo-owner"
COMPLETE_MARKER="$OWNER_DIR/complete"
SAFE_MANAGED_DIR="$OWNER_DIR/managed"
CLEAN_CWD="$OWNER_DIR/work"
OWNER_ENV="$OWNER_DIR/.env"
KEY_FILE="$PROFILE_DIR/.movie-demo-api-key"
DB_PATH=${MOVIE_DEMO_DB_PATH-"$MOVIE_DEMO_ROOT/movie-demo.db"}
APP_HOST=${HOST-127.0.0.1}
APP_PORT=${PORT-3000}
APP_COOKIE_SECURE=${COOKIE_SECURE-false}
case "$DB_PATH" in
  /*) ;;
  *)
    printf 'movie demo: database path must be absolute\n' >&2
    exit 1
    ;;
esac
STATE_VERSION='webcmd movie-ticket-booking setup v2'
TEMP_PATH=
READY_PATH=
CHILD_PID=
OWNER_TOKEN=

die() {
  printf 'movie demo: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  for cleanup_path in "$TEMP_PATH" "$READY_PATH"; do
    if [ -n "$cleanup_path" ] && { [ -e "$cleanup_path" ] || [ -L "$cleanup_path" ]; }; then
      unlink "$cleanup_path" 2>/dev/null || true
    fi
  done
}

forward_signal() {
  signal=$1
  signal_exit_code=$2
  if [ -n "$CHILD_PID" ]; then
    kill -"$signal" "$CHILD_PID" 2>/dev/null || true
    wait "$CHILD_PID" 2>/dev/null || true
    CHILD_PID=
  fi
  exit "$signal_exit_code"
}

trap cleanup EXIT
trap 'forward_signal HUP 129' HUP
trap 'forward_signal INT 130' INT
trap 'forward_signal TERM 143' TERM

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

file_mode() {
  case "$(uname -s)" in
    Darwin|*BSD) stat -f '%Lp' "$1" ;;
    *) stat -c '%a' "$1" ;;
  esac
}

is_private_file() {
  [ -f "$1" ] && [ ! -L "$1" ] && [ "$(file_mode "$1" 2>/dev/null)" = 600 ]
}

is_hex_64() {
  [ "${#1}" -eq 64 ] || return 1
  case "$1" in
    *[!0-9a-f]*) return 1 ;;
  esac
}

require_no_nul() {
  hex_bytes=$(LC_ALL=C od -An -v -t x1 "$1") \
    || die "could not inspect text encoding: $1"
  for hex_byte in $hex_bytes; do
    [ "$hex_byte" != 00 ] \
      || die "NUL-padded and UTF-16 files are not supported: $1"
  done
}

reject_pattern() {
  inspected_file=$1
  pattern=$2
  rejection=$3
  set +e
  LC_ALL=C grep -Eq "$pattern" "$inspected_file"
  grep_exit_code=$?
  set -e
  case "$grep_exit_code" in
    0) die "$rejection" ;;
    1) return ;;
    *) die "could not inspect configuration: $inspected_file" ;;
  esac
}

reject_symlinks() {
  for managed_path in "$HOME/.hermes" "$PROFILES_ROOT" "$OWNER_DIR" "$PROFILE_DIR"; do
    [ ! -L "$managed_path" ] || die "refusing symlink in managed path: $managed_path"
  done
  for root in "$OWNER_DIR" "$PROFILE_DIR"; do
    if [ -d "$root" ]; then
      symlink_found=$(find "$root" -type l -print -quit 2>/dev/null) \
        || die "could not inspect managed path: $root"
      [ -z "$symlink_found" ] || die "refusing symlink in managed path: $symlink_found"
    fi
  done
}

require_empty_dir() {
  [ -d "$1" ] && [ ! -L "$1" ] || die "invalid helper directory: $1"
  entry=$(find "$1" ! -path "$1" -print -quit 2>/dev/null) \
    || die "could not inspect helper directory: $1"
  [ -z "$entry" ] || die "helper directory is not empty: $1"
}

read_state_token() {
  state_file=$1
  is_private_file "$state_file" || return 1
  [ "$(LC_ALL=C wc -l <"$state_file" | tr -d ' ')" = 2 ] || return 1
  [ "$(sed -n '1p' "$state_file")" = "$STATE_VERSION" ] || return 1
  token=$(sed -n '2p' "$state_file")
  is_hex_64 "$token" || return 1
  printf '%s\n' "$token"
}

write_state() {
  state_file=$1
  token=$2
  is_hex_64 "$token" || die "invalid ownership token"
  [ ! -L "$state_file" ] || die "refusing symlink state file: $state_file"
  [ ! -e "$state_file" ] || [ -f "$state_file" ] || die "refusing non-file state path: $state_file"
  TEMP_PATH=$(mktemp "$(dirname "$state_file")/.movie-demo-state.tmp.XXXXXX")
  printf '%s\n%s\n' "$STATE_VERSION" "$token" >"$TEMP_PATH"
  chmod 600 "$TEMP_PATH"
  mv -f "$TEMP_PATH" "$state_file"
  TEMP_PATH=
}

new_hex_64() {
  value=$(openssl rand -hex 32) || return $?
  is_hex_64 "$value" || return 1
  printf '%s\n' "$value"
}

prepare_owner_dirs() {
  for dir in "$SAFE_MANAGED_DIR" "$CLEAN_CWD"; do
    [ ! -e "$dir" ] || require_empty_dir "$dir"
  done

  if [ -e "$OWNER_ENV" ]; then
    is_private_file "$OWNER_ENV" && [ ! -s "$OWNER_ENV" ] \
      || die "invalid helper dotenv: $OWNER_ENV"
  fi

  for dir in "$SAFE_MANAGED_DIR" "$CLEAN_CWD"; do
    [ -e "$dir" ] || mkdir "$dir"
    chmod 700 "$dir"
  done
  if [ ! -e "$OWNER_ENV" ]; then
    : >"$OWNER_ENV"
    chmod 600 "$OWNER_ENV"
  fi
}

claim_ownership() {
  reject_symlinks
  if [ -e "$PROFILE_DIR" ] && [ ! -d "$OWNER_DIR" ]; then
    die "profile is unrelated to this demo (not owned): $PROFILE_DIR"
  fi

  if [ ! -e "$OWNER_DIR" ]; then
    mkdir -p "$PROFILES_ROOT"
    reject_symlinks
    mkdir "$OWNER_DIR" || die "could not create ownership directory: $OWNER_DIR"
    chmod 700 "$OWNER_DIR"
    OWNER_TOKEN=$(new_hex_64) || die "could not create ownership token"
    write_state "$OWNER_STATE" "$OWNER_TOKEN"
    prepare_owner_dirs
    return
  fi

  [ -d "$OWNER_DIR" ] && [ ! -L "$OWNER_DIR" ] \
    || die "invalid ownership directory: $OWNER_DIR"
  OWNER_TOKEN=$(read_state_token "$OWNER_STATE") \
    || die "invalid ownership token: $OWNER_STATE"
  if require_owned_profile; then
    :
  fi
  prepare_owner_dirs
  chmod 700 "$OWNER_DIR"
}

require_owned_profile() {
  reject_symlinks
  [ -d "$OWNER_DIR" ] && [ ! -L "$OWNER_DIR" ] \
    || die "run '$0 setup' first"
  OWNER_TOKEN=$(read_state_token "$OWNER_STATE") \
    || die "invalid ownership token: $OWNER_STATE"

  if [ -e "$PROFILE_DIR" ] && [ ! -d "$PROFILE_DIR" ]; then
    die "refusing non-directory profile path: $PROFILE_DIR"
  fi
  if [ ! -d "$PROFILE_DIR" ]; then
    [ ! -e "$COMPLETE_MARKER" ] \
      || die "stale completion marker with missing profile: $COMPLETE_MARKER"
    return 1
  fi
  [ ! -L "$PROFILE_DIR" ] || die "refusing symlink profile: $PROFILE_DIR"

  profile_token=$(read_state_token "$PROFILE_STATE") \
    || die "missing or invalid profile ownership token: $PROFILE_STATE"
  [ "$profile_token" = "$OWNER_TOKEN" ] \
    || die "ownership token mismatch for $PROFILE_DIR"

  if [ -e "$COMPLETE_MARKER" ]; then
    complete_token=$(read_state_token "$COMPLETE_MARKER") \
      || die "invalid completion marker: $COMPLETE_MARKER"
    [ "$complete_token" = "$OWNER_TOKEN" ] \
      || die "completion token mismatch for $PROFILE_DIR"
  fi
  return 0
}

supervise_hermes() {
  safe_mode=$1
  shift
  reject_symlinks
  require_empty_dir "$SAFE_MANAGED_DIR"
  require_empty_dir "$CLEAN_CWD"
  is_private_file "$OWNER_ENV" && [ ! -s "$OWNER_ENV" ] \
    || die "invalid helper dotenv: $OWNER_ENV"
  MOVIE_SUPERVISE_CWD="$CLEAN_CWD" \
  MOVIE_SUPERVISE_HOME="$OWNER_DIR" \
  MOVIE_SUPERVISE_MANAGED="$SAFE_MANAGED_DIR" \
  MOVIE_SUPERVISE_SAFE="$safe_mode" \
    node -e '
const { spawn } = require("node:child_process");
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.startsWith("HERMES_") || key.startsWith("MOVIE_SUPERVISE_")) {
    delete env[key];
  }
}
env.HERMES_HOME = process.env.MOVIE_SUPERVISE_HOME;
env.HERMES_MANAGED_DIR = process.env.MOVIE_SUPERVISE_MANAGED;
if (process.env.MOVIE_SUPERVISE_SAFE === "1") env.HERMES_SAFE_MODE = "1";
const child = spawn("hermes", process.argv.slice(1), {
  cwd: process.env.MOVIE_SUPERVISE_CWD,
  env,
  stdio: "inherit",
  detached: true,
});
const statuses = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
let requested = 0;
function signalGroup(signal) {
  try { process.kill(-child.pid, signal); }
  catch { try { child.kill(signal); } catch {} }
}
for (const [signal, status] of Object.entries(statuses)) {
  process.on(signal, () => {
    if (requested) return;
    requested = status;
    signalGroup(signal);
    setTimeout(() => {
      signalGroup("SIGKILL");
      process.exit(requested);
    }, 2000);
  });
}
child.on("error", (error) => {
  process.stderr.write(`movie demo: could not launch hermes: ${error.message}\n`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (!requested) process.exit(code ?? statuses[signal] ?? 1);
});
' -- "$@" &
  CHILD_PID=$!
  set +e
  wait "$CHILD_PID"
  child_exit_code=$?
  set -e
  CHILD_PID=
  return "$child_exit_code"
}

validate_profile_config() {
  config_requirement=${1-required}
  reject_symlinks
  is_private_file "$PROFILE_DIR/.env" \
    || die "profile dotenv must be a mode-600 regular file: $PROFILE_DIR/.env"
  require_no_nul "$PROFILE_DIR/.env"
  reject_pattern "$PROFILE_DIR/.env" \
    '(HERMES_[A-Z0-9_]+|API_SERVER_(ENABLED|KEY|HOST|PORT)|MOVIE_DEMO_(ROOT|DB_PATH)|PORT)[^A-Z0-9_]*=' \
    "profile dotenv overrides helper-owned settings: $PROFILE_DIR/.env"
  [ ! -e "$PROFILE_DIR/.op.env" ] \
    || die "external-secret bootstrap is not supported: $PROFILE_DIR/.op.env"

  if [ ! -e "$PROFILE_DIR/config.yaml" ] && [ "$config_requirement" = optional ]; then
    return
  fi
  [ -f "$PROFILE_DIR/config.yaml" ] && [ ! -L "$PROFILE_DIR/config.yaml" ] \
    || die "missing regular Hermes config: $PROFILE_DIR/config.yaml"
  require_no_nul "$PROFILE_DIR/config.yaml"
  reject_pattern "$PROFILE_DIR/config.yaml" '\\' \
    "unsupported config syntax, external secret source, or custom context engine: $PROFILE_DIR/config.yaml"
  reject_pattern "$PROFILE_DIR/config.yaml" \
    '(^|[^[:alnum:]_])(secrets|context)([^[:alnum:]_]|$)' \
    "external secret sources and custom context engines are not supported"
}

key_is_valid() {
  is_private_file "$KEY_FILE" || return 1
  bytes=$(LC_ALL=C wc -c <"$KEY_FILE" | tr -d ' ')
  [ "$bytes" = 64 ] || [ "$bytes" = 65 ] || return 1
  key=$(sed -n '1p' "$KEY_FILE")
  is_hex_64 "$key"
}

read_key() {
  key_is_valid || die "API key must be exactly 64 lowercase hex characters in a mode-600 file: $KEY_FILE"
  sed -n '1p' "$KEY_FILE"
}

write_key() {
  [ ! -L "$KEY_FILE" ] || die "refusing symlink API key: $KEY_FILE"
  [ ! -e "$KEY_FILE" ] || [ -f "$KEY_FILE" ] \
    || die "refusing non-file API key path: $KEY_FILE"
  TEMP_PATH=$(mktemp "$PROFILE_DIR/.movie-demo-api-key.tmp.XXXXXX")
  set +e
  openssl rand -hex 32 >"$TEMP_PATH"
  key_exit_code=$?
  set -e
  if [ "$key_exit_code" -ne 0 ]; then
    cleanup
    TEMP_PATH=
    return "$key_exit_code"
  fi
  chmod 600 "$TEMP_PATH"
  bytes=$(LC_ALL=C wc -c <"$TEMP_PATH" | tr -d ' ')
  candidate=$(sed -n '1p' "$TEMP_PATH")
  if { [ "$bytes" != 64 ] && [ "$bytes" != 65 ]; } || ! is_hex_64 "$candidate"; then
    cleanup
    TEMP_PATH=
    die "openssl produced an invalid API key"
  fi
  mv -f "$TEMP_PATH" "$KEY_FILE"
  TEMP_PATH=
}

install_file() {
  source=$1
  target=$2
  mkdir -p "$(dirname "$target")"
  reject_symlinks
  TEMP_PATH=$(mktemp "$(dirname "$target")/.movie-demo-install.tmp.XXXXXX")
  cp "$source" "$TEMP_PATH"
  chmod 600 "$TEMP_PATH"
  mv -f "$TEMP_PATH" "$target"
  TEMP_PATH=
}

artifacts_valid() {
  [ -f "$PROFILE_DIR/.no-bundled-skills" ] \
    && [ ! -L "$PROFILE_DIR/.no-bundled-skills" ] \
    && [ -f "$PROFILE_DIR/SOUL.md" ] \
    && cmp -s "$MOVIE_DEMO_ROOT/hermes/SOUL.md" "$PROFILE_DIR/SOUL.md" \
    && [ -f "$PROFILE_DIR/skills/movie-ticket-booking/SKILL.md" ] \
    && cmp -s \
      "$MOVIE_DEMO_ROOT/hermes/skills/movie-ticket-booking/SKILL.md" \
      "$PROFILE_DIR/skills/movie-ticket-booking/SKILL.md" \
    && key_is_valid
}

run_readiness() {
  READY_PATH=$(mktemp "$OWNER_DIR/.movie-demo-ready.tmp.XXXXXX")
  if supervise_hermes 1 \
    -p "$PROFILE_NAME" \
    --ignore-rules \
    -t context_engine \
    -z 'Reply with exactly READY and nothing else.' >"$READY_PATH"; then
    :
  else
    readiness_exit_code=$?
    cleanup
    READY_PATH=
    return "$readiness_exit_code"
  fi

  bytes=$(LC_ALL=C wc -c <"$READY_PATH" | tr -d ' ')
  response=$(sed -n '1p' "$READY_PATH")
  if { [ "$bytes" != 5 ] && [ "$bytes" != 6 ]; } || [ "$response" != READY ]; then
    die "provider readiness must reply with exactly READY"
  fi
  unlink "$READY_PATH"
  READY_PATH=
}

setup_demo() {
  require_command hermes
  require_command node
  require_command npm
  require_command openssl
  claim_ownership

  if ! require_owned_profile; then
    supervise_hermes 0 profile create "$PROFILE_NAME" --no-alias --no-skills
    [ -d "$PROFILE_DIR" ] && [ ! -L "$PROFILE_DIR" ] \
      || die "Hermes did not create the expected profile: $PROFILE_DIR"
    write_state "$PROFILE_STATE" "$OWNER_TOKEN"
  fi
  require_owned_profile
  [ -f "$PROFILE_DIR/.no-bundled-skills" ] \
    || die "Hermes profile is missing its no-bundled-skills marker"

  npm --prefix "$MOVIE_DEMO_ROOT" ci

  if [ -e "$COMPLETE_MARKER" ]; then
    validate_profile_config
    if artifacts_valid; then
      printf 'Movie demo setup is ready at %s\n' "$PROFILE_DIR"
      return
    fi
  fi

  validate_profile_config optional
  supervise_hermes 0 -p "$PROFILE_NAME" setup
  validate_profile_config
  run_readiness

  install_file "$MOVIE_DEMO_ROOT/hermes/SOUL.md" "$PROFILE_DIR/SOUL.md"
  install_file \
    "$MOVIE_DEMO_ROOT/hermes/skills/movie-ticket-booking/SKILL.md" \
    "$PROFILE_DIR/skills/movie-ticket-booking/SKILL.md"
  key_is_valid || write_key
  artifacts_valid || die "setup artifacts failed validation"
  write_state "$COMPLETE_MARKER" "$OWNER_TOKEN"

  printf 'Movie demo setup is ready at %s\n' "$PROFILE_DIR"
}

require_complete_profile() {
  require_owned_profile || die "run '$0 setup' first"
  [ -e "$COMPLETE_MARKER" ] || die "run '$0 setup' first"
  validate_profile_config
  key_is_valid \
    || die "API key must be exactly 64 lowercase hex characters in a mode-600 file: $KEY_FILE"
  artifacts_valid || die "run '$0 setup' to restore the validated demo artifacts"
}

rotate_key() {
  require_command openssl
  require_owned_profile || die "run '$0 setup' first"
  [ -e "$COMPLETE_MARKER" ] || die "run '$0 setup' first"
  validate_profile_config
  write_key
  printf 'Movie demo API key rotated. Restart Hermes and the app.\n'
}

run_gateway() {
  require_command hermes
  require_command node
  require_complete_profile
  prepare_owner_dirs
  api_key=$(read_key)
  unset HOST PORT COOKIE_SECURE MOVIE_DEMO_DB_PATH
  export \
    API_SERVER_ENABLED=true \
    API_SERVER_KEY="$api_key" \
    API_SERVER_HOST=127.0.0.1 \
    API_SERVER_PORT=8642 \
    MOVIE_DEMO_ROOT \
    MOVIE_DEMO_DB_PATH="$DB_PATH"
  supervise_hermes 0 -p "$PROFILE_NAME" gateway run
}

run_app() {
  require_command npm
  require_complete_profile
  api_key=$(read_key)
  unset HERMES_API_URL API_SERVER_KEY HOST PORT COOKIE_SECURE MOVIE_DEMO_DB_PATH
  export \
    HERMES_API_URL=http://127.0.0.1:8642 \
    API_SERVER_KEY="$api_key" \
    HOST="$APP_HOST" \
    PORT="$APP_PORT" \
    COOKIE_SECURE="$APP_COOKIE_SECURE" \
    MOVIE_DEMO_ROOT="$MOVIE_DEMO_ROOT" \
    MOVIE_DEMO_DB_PATH="$DB_PATH"
  trap - EXIT HUP INT TERM
  exec npm --prefix "$MOVIE_DEMO_ROOT" run start
}

case "${1-setup}" in
  setup)
    [ "$#" -eq 1 ] || die "usage: $0 setup"
    setup_demo
    ;;
  rotate-key)
    [ "$#" -eq 1 ] || die "usage: $0 rotate-key"
    rotate_key
    ;;
  gateway)
    [ "$#" -eq 1 ] || die "usage: $0 gateway"
    run_gateway
    ;;
  app)
    [ "$#" -eq 1 ] || die "usage: $0 app"
    run_app
    ;;
  *)
    die "usage: $0 {setup|gateway|app|rotate-key}"
    ;;
esac
