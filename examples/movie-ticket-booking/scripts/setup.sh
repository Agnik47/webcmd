#!/bin/sh

set -eu
umask 077

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd -P)
MOVIE_DEMO_ROOT=$(CDPATH= cd "$SCRIPT_DIR/.." && pwd -P)
PROFILE_NAME=movie-booking
PROFILES_ROOT="$HOME/.hermes/profiles"
PROFILE_DIR="$PROFILES_ROOT/$PROFILE_NAME"
OWNER_DIR="$PROFILES_ROOT/.$PROFILE_NAME.webcmd-demo"
COMPLETE_MARKER="$OWNER_DIR/complete"
SAFE_MANAGED_DIR="$OWNER_DIR/managed"
KEY_FILE="$PROFILE_DIR/.movie-demo-api-key"
DB_PATH="$MOVIE_DEMO_ROOT/movie-demo.db"
TEMP_PATH=

die() {
  printf 'movie demo: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [ -n "$TEMP_PATH" ] && { [ -e "$TEMP_PATH" ] || [ -L "$TEMP_PATH" ]; }; then
    unlink "$TEMP_PATH" 2>/dev/null || true
  fi
}

on_hup() {
  exit 129
}

on_int() {
  exit 130
}

on_term() {
  exit 143
}

trap cleanup EXIT
trap on_hup HUP
trap on_int INT
trap on_term TERM

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

validate_owned_profile() {
  if [ -L "$OWNER_DIR" ] || { [ -e "$OWNER_DIR" ] && [ ! -d "$OWNER_DIR" ]; }; then
    die "invalid ownership marker: $OWNER_DIR"
  fi
  if [ -L "$PROFILE_DIR" ] || { [ -e "$PROFILE_DIR" ] && [ ! -d "$PROFILE_DIR" ]; }; then
    die "refusing non-directory profile path: $PROFILE_DIR"
  fi
  if { [ -e "$PROFILE_DIR" ] || [ -L "$PROFILE_DIR" ]; } && [ ! -d "$OWNER_DIR" ]; then
    die "profile is unrelated to this demo (not owned): $PROFILE_DIR"
  fi
}

claim_profile() {
  validate_owned_profile
  if [ ! -d "$OWNER_DIR" ]; then
    mkdir -p "$PROFILES_ROOT"
    if ! mkdir "$OWNER_DIR"; then
      validate_owned_profile
      [ -d "$OWNER_DIR" ] || die "could not create ownership marker: $OWNER_DIR"
    fi
  fi
  mkdir -p "$SAFE_MANAGED_DIR"
}

preflight_python() {
  if [ -n "${MOVIE_DEMO_PREFLIGHT_PYTHON-}" ]; then
    [ -x "$MOVIE_DEMO_PREFLIGHT_PYTHON" ] \
      || die "preflight Python is not executable: $MOVIE_DEMO_PREFLIGHT_PYTHON"
    printf '%s\n' "$MOVIE_DEMO_PREFLIGHT_PYTHON"
    return
  fi

  hermes_path=$(command -v hermes 2>/dev/null || true)
  [ -n "$hermes_path" ] || die "required command not found: hermes"
  shebang=$(LC_ALL=C sed -n '1p' "$hermes_path")
  case "$shebang" in
    '#!/usr/bin/env '*)
      interpreter=${shebang#\#!/usr/bin/env }
      interpreter=${interpreter%% *}
      command -v "$interpreter" 2>/dev/null \
        || die "could not resolve Hermes Python interpreter"
      ;;
    '#!'*)
      interpreter=${shebang#\#!}
      interpreter=${interpreter%% *}
      [ -x "$interpreter" ] || die "Hermes launcher does not expose an executable Python"
      printf '%s\n' "$interpreter"
      ;;
    *)
      die "Hermes launcher does not expose its Python interpreter"
      ;;
  esac
}

configured_managed_dir() {
  if [ -n "${HERMES_MANAGED_DIR-}" ]; then
    [ -d "$HERMES_MANAGED_DIR" ] && printf '%s\n' "$HERMES_MANAGED_DIR"
    return 0
  fi
  [ -d /etc/hermes ] && printf '%s\n' /etc/hermes
  return 0
}

raw_preflight() {
  configured_managed=$(configured_managed_dir)
  needs_python=false
  for candidate in \
    "$PROFILE_DIR/.env" \
    "$PROFILE_DIR/.op.env" \
    "$PROFILE_DIR/config.yaml" \
    "${configured_managed:+$configured_managed/.env}" \
    "$SAFE_MANAGED_DIR/.env"
  do
    if [ -n "$candidate" ] && [ -s "$candidate" ]; then
      needs_python=true
      break
    fi
  done
  [ "$needs_python" = true ] || return 0

  python=$(preflight_python)
  "$python" -I - \
    "$PROFILE_DIR" \
    "$configured_managed" \
    "$SAFE_MANAGED_DIR" <<'PY'
from __future__ import annotations

import codecs
import io
import sys
from pathlib import Path

AUTHORITY_KEYS = {
    "API_SERVER_ENABLED",
    "API_SERVER_KEY",
    "API_SERVER_HOST",
    "API_SERVER_PORT",
    "MOVIE_DEMO_ROOT",
    "MOVIE_DEMO_DB_PATH",
    "HERMES_HOME",
    "HERMES_PROFILE",
    "HERMES_MANAGED_DIR",
}


def fail(message: str) -> None:
    print(f"movie demo preflight: {message}", file=sys.stderr)
    raise SystemExit(1)


def dotenv_keys(path: Path) -> set[str]:
    if not path.is_file() or path.stat().st_size == 0:
        return set()
    try:
        raw = path.read_bytes()
        if raw.startswith(codecs.BOM_UTF32_LE) or raw.startswith(codecs.BOM_UTF32_BE):
            text = raw.decode("latin-1")
        elif raw.startswith(codecs.BOM_UTF16_LE) or raw.startswith(codecs.BOM_UTF16_BE):
            text = raw.decode("utf-16")
        else:
            text = raw.decode("utf-8-sig", errors="replace")
            if text.startswith("\ufffd"):
                text = raw.decode("latin-1")

        from dotenv import dotenv_values
        from hermes_cli.config import _sanitize_env_lines

        with io.StringIO(text, newline=None) as stream:
            lines = stream.readlines()
        sanitized = _sanitize_env_lines([line.replace("\x00", "") for line in lines])
        values = dotenv_values(stream=io.StringIO("".join(sanitized)))
        return {key for key in values if isinstance(key, str)}
    except Exception as exc:
        fail(f"could not inspect {path}: {type(exc).__name__}")


profile_dir = Path(sys.argv[1])
managed_dirs = [Path(value) for value in sys.argv[2:] if value]
for env_path in [
    profile_dir / ".env",
    profile_dir / ".op.env",
    *(directory / ".env" for directory in managed_dirs),
]:
    conflicts = sorted(dotenv_keys(env_path) & AUTHORITY_KEYS)
    if conflicts:
        fail(f"{env_path} overrides: {', '.join(conflicts)}")

config_path = profile_dir / "config.yaml"
if config_path.is_file() and config_path.stat().st_size:
    try:
        from agent.secret_sources.registry import list_sources
        from utils import fast_safe_load

        with config_path.open(encoding="utf-8") as stream:
            data = fast_safe_load(stream) or {}
        secrets = data.get("secrets") if isinstance(data, dict) else {}
        secrets = secrets if isinstance(secrets, dict) else {}
        enabled = []
        for source in list_sources():
            config = secrets.get(source.name)
            config = config if isinstance(config, dict) else {}
            try:
                is_enabled = source.is_enabled(config)
            except Exception as exc:
                fail(
                    f"could not evaluate secret source {source.name}: "
                    f"{type(exc).__name__}"
                )
            if is_enabled:
                enabled.append(source.name)
        if enabled:
            fail(f"secret source is enabled: {', '.join(enabled)}")
    except SystemExit:
        raise
    except Exception as exc:
        fail(f"could not inspect {config_path}: {type(exc).__name__}")
PY
}

write_key() {
  if [ -L "$KEY_FILE" ] || { [ -e "$KEY_FILE" ] && [ ! -f "$KEY_FILE" ]; }; then
    die "refusing non-regular API key path: $KEY_FILE"
  fi

  TEMP_PATH=$(mktemp "$PROFILE_DIR/.movie-demo-api-key.tmp.XXXXXX")
  set +e
  openssl rand -hex 32 >"$TEMP_PATH"
  key_status=$?
  set -e
  if [ "$key_status" -ne 0 ]; then
    cleanup
    TEMP_PATH=
    return "$key_status"
  fi
  chmod 600 "$TEMP_PATH"
  mv -f "$TEMP_PATH" "$KEY_FILE"
  TEMP_PATH=
}

ensure_key() {
  if [ -f "$KEY_FILE" ] && [ -s "$KEY_FILE" ] && [ ! -L "$KEY_FILE" ]; then
    chmod 600 "$KEY_FILE"
    return
  fi
  write_key
}

ensure_profile_env() {
  profile_env="$PROFILE_DIR/.env"
  if [ -L "$profile_env" ] || { [ -e "$profile_env" ] && [ ! -f "$profile_env" ]; }; then
    die "refusing non-regular profile dotenv: $profile_env"
  fi
  if [ ! -f "$profile_env" ]; then
    : >"$profile_env"
  fi
  chmod 600 "$profile_env"
}

mark_complete() {
  TEMP_PATH=$(mktemp "$OWNER_DIR/.complete.tmp.XXXXXX")
  printf '%s\n' 'webcmd movie-ticket-booking setup v1' >"$TEMP_PATH"
  chmod 600 "$TEMP_PATH"
  mv -f "$TEMP_PATH" "$COMPLETE_MARKER"
  TEMP_PATH=
}

require_complete_profile() {
  validate_owned_profile
  [ -d "$OWNER_DIR" ] && [ -d "$PROFILE_DIR" ] && [ -f "$COMPLETE_MARKER" ] \
    || die "run '$0 setup' first"
  [ -f "$PROFILE_DIR/.env" ] && [ ! -L "$PROFILE_DIR/.env" ] \
    || die "run '$0 setup' to restore the profile dotenv"
  [ -f "$KEY_FILE" ] && [ -s "$KEY_FILE" ] && [ ! -L "$KEY_FILE" ] \
    || die "missing regular API key: $KEY_FILE"
}

setup_demo() {
  require_command hermes
  require_command npm
  require_command openssl
  claim_profile
  raw_preflight

  if [ ! -d "$PROFILE_DIR" ]; then
    HERMES_HOME="$OWNER_DIR" \
    HERMES_MANAGED_DIR="$SAFE_MANAGED_DIR" \
      hermes profile create "$PROFILE_NAME" --no-alias --no-skills
    [ -d "$PROFILE_DIR" ] && [ ! -L "$PROFILE_DIR" ] \
      || die "Hermes did not create the expected profile: $PROFILE_DIR"
  fi

  ensure_profile_env
  raw_preflight
  npm --prefix "$MOVIE_DEMO_ROOT" install

  if [ ! -f "$COMPLETE_MARKER" ]; then
    HERMES_MANAGED_DIR="$SAFE_MANAGED_DIR" hermes -p "$PROFILE_NAME" setup
    raw_preflight
    HERMES_MANAGED_DIR="$SAFE_MANAGED_DIR" \
      hermes -p "$PROFILE_NAME" --ignore-rules -t context_engine \
        -z 'Reply with exactly: movie-booking-ready' >/dev/null
  fi

  cp "$MOVIE_DEMO_ROOT/hermes/SOUL.md" "$PROFILE_DIR/SOUL.md"
  mkdir -p "$PROFILE_DIR/skills/movie-ticket-booking"
  cp \
    "$MOVIE_DEMO_ROOT/hermes/skills/movie-ticket-booking/SKILL.md" \
    "$PROFILE_DIR/skills/movie-ticket-booking/SKILL.md"
  ensure_key
  [ -f "$COMPLETE_MARKER" ] || mark_complete

  printf 'Movie demo setup is ready at %s\n' "$PROFILE_DIR"
}

rotate_key() {
  require_command openssl
  require_complete_profile
  write_key
  printf 'Movie demo API key rotated. Restart Hermes and the app.\n'
}

run_gateway() {
  require_command hermes
  require_complete_profile
  raw_preflight
  chmod 600 "$KEY_FILE"
  api_key=$(sed -n '1p' "$KEY_FILE")
  [ -n "$api_key" ] || die "API key file is empty: $KEY_FILE"
  trap - EXIT HUP INT TERM
  exec env \
    HERMES_MANAGED_DIR="$SAFE_MANAGED_DIR" \
    API_SERVER_ENABLED=true \
    API_SERVER_KEY="$api_key" \
    API_SERVER_HOST=127.0.0.1 \
    API_SERVER_PORT=8642 \
    MOVIE_DEMO_ROOT="$MOVIE_DEMO_ROOT" \
    MOVIE_DEMO_DB_PATH="$DB_PATH" \
    hermes -p "$PROFILE_NAME" gateway run
}

run_app() {
  require_command npm
  require_complete_profile
  api_key=$(sed -n '1p' "$KEY_FILE")
  [ -n "$api_key" ] || die "API key file is empty: $KEY_FILE"
  trap - EXIT HUP INT TERM
  exec env \
    HERMES_API_URL=http://127.0.0.1:8642 \
    API_SERVER_KEY="$api_key" \
    PORT=3000 \
    MOVIE_DEMO_ROOT="$MOVIE_DEMO_ROOT" \
    MOVIE_DEMO_DB_PATH="$DB_PATH" \
    npm --prefix "$MOVIE_DEMO_ROOT" run dev
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
