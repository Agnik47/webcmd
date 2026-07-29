import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const demoRoot = join(import.meta.dirname, '..');
const helper = join(demoRoot, 'scripts', 'setup.sh');
const profileName = 'movie-booking';
const ownerToken = 'a'.repeat(64);
const initialKey = 'b'.repeat(64);

type Fixture = ReturnType<typeof makeFixture>;

function executable(path: string, source: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'movie helper path with spaces '));
  const home = join(root, 'home path with spaces');
  const bin = join(root, 'fake bin');
  const log = join(root, 'calls.log');
  const profile = join(home, '.hermes', 'profiles', profileName);
  const owner = join(home, '.hermes', 'profiles', `.${profileName}.webcmd-demo`);
  const evilHome = join(root, 'redirected hermes home');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });

  executable(join(bin, 'hermes'), `#!/bin/sh
printf 'hermes-argv:%s\\n' "$*" >> "$MOVIE_TEST_CALL_LOG"
printf 'hermes-cwd:%s\\n' "$PWD" >> "$MOVIE_TEST_CALL_LOG"
printf 'hermes-launch-home:%s\\n' "\${HERMES_HOME-}" >> "$MOVIE_TEST_CALL_LOG"
printf 'hermes-managed:%s\\n' "\${HERMES_MANAGED_DIR-}" >> "$MOVIE_TEST_CALL_LOG"
printf 'hermes-safe:%s\\n' "\${HERMES_SAFE_MODE-}" >> "$MOVIE_TEST_CALL_LOG"
printf 'hermes-inherited:%s|%s|%s\\n' \\
  "\${HERMES_INFERENCE_PROVIDER-}" "\${HERMES_INFERENCE_MODEL-}" "\${HERMES_CWD-}" \\
  >> "$MOVIE_TEST_CALL_LOG"

# Reproduce the redirect a helper-owned clean CWD must prevent.
if [ -f .env ]; then
  while IFS= read -r line; do
    case "$line" in
      HERMES_HOME=*) HERMES_HOME=\${line#HERMES_HOME=} ;;
    esac
  done < .env
fi

root="$HOME/.hermes"
case "\${HERMES_HOME-}" in
  "$HOME/.hermes"|"$HOME/.hermes/profiles/"*) ;;
  ?*) root="$HERMES_HOME" ;;
esac
target="$root/profiles/movie-booking"
printf 'hermes-effective-home:%s\\n' "$target" >> "$MOVIE_TEST_CALL_LOG"

case " $* " in
  *" profile create movie-booking "*)
    mkdir -p "$target"
    printf '%s\\n' '# Per-profile secrets for this Hermes profile.' > "$target/.env"
    chmod 600 "$target/.env"
    printf '%s\\n' 'no bundled skills' > "$target/.no-bundled-skills"
    if [ "\${FAKE_DIRTY_AFTER_HERMES-}" = managed ]; then
      printf '%s\\n' injected > "$HERMES_MANAGED_DIR/injected.env"
    fi
    exit "\${FAKE_PROFILE_CREATE_STATUS:-0}"
    ;;
  *" setup "*)
    if [ "\${FAKE_SETUP_BLOCK:-0}" = 1 ]; then
      printf '%s\\n' "$$" > "$MOVIE_TEST_SETUP_PID"
      if [ "\${FAKE_RESIST_DESCENDANT:-0}" = 1 ]; then
        sh -c 'trap "" HUP INT TERM; while :; do sleep 1; done' &
      else
        sleep 300 &
      fi
      printf '%s\\n' "$!" > "$MOVIE_TEST_GRANDCHILD_PID"
      wait
    fi
    if [ -n "\${FAKE_CONFIG_CONTENT-}" ]; then
      printf '%s' "$FAKE_CONFIG_CONTENT" > "$target/config.yaml"
    else
      printf '%s\\n' 'model:' '  provider: fake' '  default: fake-model' > "$target/config.yaml"
    fi
    chmod 600 "$target/config.yaml"
    exit "\${FAKE_SETUP_STATUS:-0}"
    ;;
  *" -z "*)
    printf '%s\\n' "\${FAKE_READY_TEXT:-READY}"
    exit "\${FAKE_READY_STATUS:-0}"
    ;;
  *" gateway run "*)
    key_kind=invalid
    case "$API_SERVER_KEY" in
      *[!0-9a-f]*|'') ;;
      *) [ "\${#API_SERVER_KEY}" -eq 64 ] && key_kind=valid ;;
    esac
    printf 'gateway-env:%s|%s|%s|%s|%s|%s\\n' \\
      "$API_SERVER_ENABLED" "$key_kind" "$API_SERVER_HOST" \\
      "$API_SERVER_PORT" "$MOVIE_DEMO_ROOT" "$MOVIE_DEMO_DB_PATH" \\
      >> "$MOVIE_TEST_CALL_LOG"
    printf 'gateway-deployment:%s|%s|%s\\n' \\
      "\${HOST-unset}" "\${PORT-unset}" "\${COOKIE_SECURE-unset}" \\
      >> "$MOVIE_TEST_CALL_LOG"
    exit 0
    ;;
esac
exit 0
`);

  executable(join(bin, 'npm'), `#!/bin/sh
printf 'npm-argv:%s\\n' "$*" >> "$MOVIE_TEST_CALL_LOG"
case " $* " in
  *" run start "*)
    key_kind=invalid
    case "$API_SERVER_KEY" in
      *[!0-9a-f]*|'') ;;
      *) [ "\${#API_SERVER_KEY}" -eq 64 ] && key_kind=valid ;;
    esac
    printf 'app-env:%s|%s|%s|%s|%s|%s\\n' \\
      "$HERMES_API_URL" "$key_kind" "$HOST" "$PORT" "$COOKIE_SECURE" "$MOVIE_DEMO_DB_PATH" \\
      >> "$MOVIE_TEST_CALL_LOG"
    ;;
esac
exit "\${FAKE_NPM_STATUS:-0}"
`);

  executable(join(bin, 'openssl'), `#!/bin/sh
count=0
[ ! -f "$MOVIE_TEST_OPENSSL_COUNT" ] || count=$(sed -n '1p' "$MOVIE_TEST_OPENSSL_COUNT")
count=$((count + 1))
printf '%s\\n' "$count" > "$MOVIE_TEST_OPENSSL_COUNT"
case "$count" in
  1) printf '%s\\n' '${ownerToken}' ;;
  2) printf '%s\\n' '${initialKey}' ;;
  *) printf '%064x\\n' "$count" ;;
esac
`);

  executable(join(bin, 'env'), `#!/bin/sh
printf 'env-argv:%s\\n' "$*" >> "$MOVIE_TEST_CALL_LOG"
exec /usr/bin/env "$@"
`);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    HERMES_HOME: evilHome,
    HERMES_PROFILE: 'wrong-profile',
    HERMES_CONFIG: join(root, 'wrong-config.yaml'),
    HERMES_ENV: join(root, 'wrong.env'),
    HERMES_ENABLE_PROJECT_PLUGINS: '1',
    HERMES_INFERENCE_PROVIDER: 'wrong-provider',
    HERMES_INFERENCE_MODEL: 'wrong-model',
    HERMES_CWD: join(root, 'wrong-cwd'),
    MOVIE_TEST_CALL_LOG: log,
    MOVIE_TEST_OPENSSL_COUNT: join(root, 'openssl-count'),
    MOVIE_TEST_SETUP_PID: join(root, 'setup-child.pid'),
    MOVIE_TEST_GRANDCHILD_PID: join(root, 'setup-grandchild.pid'),
  };

  return {
    root,
    home,
    bin,
    log,
    profile,
    owner,
    evilHome,
    env,
  };
}

function run(
  fixture: Fixture,
  command = 'setup',
  extraEnv: NodeJS.ProcessEnv = {},
  shell = '/bin/bash',
) {
  return spawnSync(shell, [helper, command], {
    cwd: fixture.root,
    env: { ...fixture.env, ...extraEnv },
    encoding: 'utf8',
  });
}

function calls(fixture: Fixture): string {
  return existsSync(fixture.log) ? readFileSync(fixture.log, 'utf8') : '';
}

function clearCalls(fixture: Fixture): void {
  writeFileSync(fixture.log, '');
}

function tokenFrom(path: string): string {
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /v2/);
  assert.match(lines[1], /^[0-9a-f]{64}$/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  return lines[1];
}

function completeSetup(fixture: Fixture): void {
  const result = run(fixture);
  assert.equal(result.status, 0, result.stderr);
}

function processStopped(pid: number): boolean {
  const result = spawnSync('/bin/ps', ['-o', 'state=', '-p', String(pid)], {
    encoding: 'utf8',
  });
  return result.status !== 0 || result.stdout.trim().startsWith('Z');
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('a shell-shim Hermes install is isolated, token-owned, readiness-checked, and resumable', () => {
  const fixture = makeFixture();
  writeFileSync(join(fixture.root, '.env'), `HERMES_HOME=${fixture.evilHome}\n`);

  completeSetup(fixture);

  assert.ok(existsSync(fixture.profile));
  assert.equal(existsSync(join(fixture.evilHome, 'profiles', profileName)), false);
  assert.equal(tokenFrom(join(fixture.owner, 'owner')), ownerToken);
  assert.equal(tokenFrom(join(fixture.profile, '.movie-demo-owner')), ownerToken);
  assert.equal(tokenFrom(join(fixture.owner, 'complete')), ownerToken);
  assert.match(calls(fixture), /hermes-argv:profile create movie-booking --no-alias --no-skills/);
  assert.match(calls(fixture), /hermes-argv:-p movie-booking setup/);
  assert.match(
    calls(fixture),
    /hermes-argv:-p movie-booking --ignore-rules -t context_engine -z Reply with exactly READY and nothing else\./,
  );
  assert.match(calls(fixture), /hermes-safe:1/);
  assert.match(calls(fixture), /hermes-inherited:\|\|/);
  assert.doesNotMatch(calls(fixture), /hermes-inherited:(?!\|\|$)/m);
  assert.doesNotMatch(
    calls(fixture),
    new RegExp(`hermes-cwd:${fixture.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`),
  );
  assert.doesNotMatch(`${calls(fixture)}${readFileSync(join(fixture.profile, '.env'), 'utf8')}`, /wrong-profile|wrong-config|wrong\.env/);
  assert.equal(readFileSync(join(fixture.profile, '.movie-demo-api-key'), 'utf8').trim(), initialKey);
  assert.equal(statSync(join(fixture.profile, '.movie-demo-api-key')).mode & 0o777, 0o600);

  clearCalls(fixture);
  const resumed = run(fixture, 'setup', {}, 'zsh');
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.doesNotMatch(calls(fixture), /profile create| setup | -z /);
});

test('later launches refuse a nonempty helper working or managed directory', () => {
  for (const relativeDir of ['managed', 'work']) {
    const fixture = makeFixture();
    completeSetup(fixture);
    writeFileSync(join(fixture.owner, relativeDir, 'injected.env'), 'HERMES_HOME=/tmp/wrong\n');
    clearCalls(fixture);

    const result = run(fixture, 'gateway');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not empty/i);
    assert.equal(calls(fixture), '');
  }
});

test('every Hermes call rechecks the empty managed directory', () => {
  const fixture = makeFixture();
  const result = run(fixture, 'setup', { FAKE_DIRTY_AFTER_HERMES: 'managed' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not empty/i);
  assert.match(calls(fixture), /profile create/);
  assert.doesNotMatch(calls(fixture), /hermes-argv:.* setup\n| -z /);
});

test('unowned, mismatched, deleted, and symlinked state aborts without mutation', () => {
  const unrelated = makeFixture();
  mkdirSync(unrelated.profile, { recursive: true });
  writeFileSync(join(unrelated.profile, 'SOUL.md'), 'unrelated\n');
  const refused = run(unrelated);
  assert.notEqual(refused.status, 0);
  assert.equal(readFileSync(join(unrelated.profile, 'SOUL.md'), 'utf8'), 'unrelated\n');
  assert.equal(existsSync(unrelated.owner), false);
  assert.equal(calls(unrelated), '');

  const mismatch = makeFixture();
  completeSetup(mismatch);
  writeFileSync(
    join(mismatch.profile, '.movie-demo-owner'),
    `webcmd movie-ticket-booking setup v2\n${'c'.repeat(64)}\n`,
    { mode: 0o600 },
  );
  rmSync(join(mismatch.owner, 'managed'), { recursive: true });
  rmSync(join(mismatch.owner, 'work'), { recursive: true });
  chmodSync(mismatch.owner, 0o755);
  clearCalls(mismatch);
  const mismatched = run(mismatch);
  assert.notEqual(mismatched.status, 0);
  assert.match(mismatched.stderr, /ownership|token|mismatch/i);
  assert.equal(calls(mismatch), '');
  assert.equal(statSync(mismatch.owner).mode & 0o777, 0o755);
  assert.equal(existsSync(join(mismatch.owner, 'managed')), false);
  assert.equal(existsSync(join(mismatch.owner, 'work')), false);

  const nonDirectory = makeFixture();
  completeSetup(nonDirectory);
  rmSync(nonDirectory.profile, { recursive: true });
  rmSync(join(nonDirectory.owner, 'complete'));
  rmSync(join(nonDirectory.owner, 'managed'), { recursive: true });
  rmSync(join(nonDirectory.owner, 'work'), { recursive: true });
  writeFileSync(nonDirectory.profile, 'not a directory\n');
  chmodSync(nonDirectory.owner, 0o755);
  clearCalls(nonDirectory);
  const invalidProfilePath = run(nonDirectory);
  assert.notEqual(invalidProfilePath.status, 0);
  assert.match(invalidProfilePath.stderr, /non-directory|profile path/i);
  assert.equal(calls(nonDirectory), '');
  assert.equal(statSync(nonDirectory.owner).mode & 0o777, 0o755);
  assert.equal(existsSync(join(nonDirectory.owner, 'managed')), false);
  assert.equal(existsSync(join(nonDirectory.owner, 'work')), false);

  const staleCompletion = makeFixture();
  completeSetup(staleCompletion);
  writeFileSync(
    join(staleCompletion.owner, 'complete'),
    `webcmd movie-ticket-booking setup v1\n${ownerToken}\n`,
    { mode: 0o600 },
  );
  clearCalls(staleCompletion);
  const invalidCompletion = run(staleCompletion, 'gateway');
  assert.notEqual(invalidCompletion.status, 0);
  assert.match(invalidCompletion.stderr, /completion marker/i);
  assert.equal(calls(staleCompletion), '');

  const deleted = makeFixture();
  completeSetup(deleted);
  rmSync(deleted.profile, { recursive: true });
  clearCalls(deleted);
  const stale = run(deleted);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /stale|missing profile/i);
  assert.equal(existsSync(deleted.profile), false);
  assert.equal(calls(deleted), '');

  const linked = makeFixture();
  completeSetup(linked);
  rmSync(join(linked.owner, 'managed'), { recursive: true });
  symlinkSync(linked.root, join(linked.owner, 'managed'));
  clearCalls(linked);
  const symlinked = run(linked, 'gateway');
  assert.notEqual(symlinked.status, 0);
  assert.match(symlinked.stderr, /symlink/i);
  assert.equal(calls(linked), '');
});

test('incomplete state reruns readiness and exact READY is required', () => {
  const wrongToken = makeFixture();
  const wrong = run(wrongToken, 'setup', { FAKE_READY_TEXT: 'almost READY' });
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /exactly READY|readiness/i);
  assert.equal(existsSync(join(wrongToken.owner, 'complete')), false);
  assert.equal(existsSync(join(wrongToken.profile, 'SOUL.md')), false);
  assert.equal(existsSync(join(wrongToken.profile, '.movie-demo-api-key')), false);

  writeFileSync(
    join(wrongToken.owner, 'complete'),
    `webcmd movie-ticket-booking setup v2\n${ownerToken}\n`,
    { mode: 0o600 },
  );
  clearCalls(wrongToken);
  const resumed = run(wrongToken);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.doesNotMatch(calls(wrongToken), /profile create/);
  assert.match(calls(wrongToken), /hermes-argv:.* setup\n/);
  assert.match(calls(wrongToken), / -z /);
});

test('external-secret, custom-context, and dotenv authority config is rejected before readiness', () => {
  for (const config of [
    'model:\n  provider: fake\nsecrets:\n  onepassword:\n    enabled: true\n',
    'model:\n  provider: fake\nsecrets :\n  onepassword:\n    enabled: true\n',
    'model: {provider: fake}\n{"context": {"engine": "plugin-engine"}}\n',
    'model: {provider: fake}\n"secr\\x65ts": {onepassword: {enabled: true}}\n',
    'model: {provider: fake}\n"cont\\x65xt": {engine: plugin-engine}\n',
  ]) {
    const fixture = makeFixture();
    const result = run(fixture, 'setup', { FAKE_CONFIG_CONTENT: config });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /secret|context/i);
    assert.doesNotMatch(calls(fixture), / -z /);
    assert.equal(existsSync(join(fixture.owner, 'complete')), false);
  }

  const fixture = makeFixture();
  completeSetup(fixture);
  writeFileSync(join(fixture.profile, '.env'), "'HERMES_HOME'=/tmp/redirect\n", { mode: 0o600 });
  clearCalls(fixture);
  const result = run(fixture, 'gateway');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HERMES_HOME|dotenv|override/i);
  assert.equal(calls(fixture), '');

  const concatenated = makeFixture();
  completeSetup(concatenated);
  writeFileSync(
    join(concatenated.profile, '.env'),
    'OPENAI_API_KEY=AHERMES_HOME=/tmp/redirect\n',
    { mode: 0o600 },
  );
  clearCalls(concatenated);
  const concatenatedResult = run(concatenated, 'gateway');
  assert.notEqual(concatenatedResult.status, 0);
  assert.match(concatenatedResult.stderr, /dotenv|override/i);
  assert.equal(calls(concatenated), '');

  const nulPadded = makeFixture();
  completeSetup(nulPadded);
  const padded = Buffer.from(
    [...'HERMES_HOME=/tmp/redirect\n'].flatMap((character) => [character.charCodeAt(0), 0]),
  );
  writeFileSync(join(nulPadded.profile, '.env'), padded, { mode: 0o600 });
  chmodSync(join(nulPadded.profile, '.env'), 0o600);
  clearCalls(nulPadded);
  const nulResult = run(nulPadded, 'gateway');
  assert.notEqual(nulResult.status, 0);
  assert.match(nulResult.stderr, /dotenv|NUL|encoding/i);
  assert.equal(calls(nulPadded), '');

  const boundaryNul = makeFixture();
  completeSetup(boundaryNul);
  const boundaryPadded = Buffer.concat([
    Buffer.from('MOVIE_DEMO_DB_P'),
    Buffer.from([0]),
    Buffer.from('ATH=/tmp/redirect\n'),
  ]);
  writeFileSync(join(boundaryNul.profile, '.env'), boundaryPadded, { mode: 0o600 });
  chmodSync(join(boundaryNul.profile, '.env'), 0o600);
  clearCalls(boundaryNul);
  const boundaryResult = run(boundaryNul, 'gateway');
  assert.notEqual(boundaryResult.status, 0);
  assert.match(boundaryResult.stderr, /dotenv|NUL|encoding/i);
  assert.equal(calls(boundaryNul), '');
});

test('completion validates artifacts and malformed or broad-mode keys never launch', () => {
  const fixture = makeFixture();
  completeSetup(fixture);
  const keyPath = join(fixture.profile, '.movie-demo-api-key');

  writeFileSync(keyPath, 'short\n', { mode: 0o600 });
  clearCalls(fixture);
  const malformedGateway = run(fixture, 'gateway');
  const malformedApp = run(fixture, 'app');
  assert.notEqual(malformedGateway.status, 0);
  assert.notEqual(malformedApp.status, 0);
  assert.equal(calls(fixture), '');

  writeFileSync(keyPath, `${'d'.repeat(64)}\n`, { mode: 0o644 });
  chmodSync(keyPath, 0o644);
  const broad = run(fixture, 'gateway');
  assert.notEqual(broad.status, 0);
  assert.match(broad.stderr, /mode|600|permission/i);
  assert.equal(calls(fixture), '');

  clearCalls(fixture);
  const repaired = run(fixture);
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.match(calls(fixture), /hermes-argv:.* setup\n/);
  assert.match(calls(fixture), / -z /);
  assert.match(readFileSync(keyPath, 'utf8'), /^[0-9a-f]{64}\n$/);
  assert.equal(statSync(keyPath).mode & 0o777, 0o600);
});

test('key rotation is atomic when generation fails', () => {
  const fixture = makeFixture();
  completeSetup(fixture);
  const keyPath = join(fixture.profile, '.movie-demo-api-key');
  const original = readFileSync(keyPath, 'utf8');

  executable(join(fixture.bin, 'openssl'), `#!/bin/sh
printf '%s' partial
exit 12
`);
  const failed = run(fixture, 'rotate-key');
  assert.equal(failed.status, 12, failed.stderr);
  assert.equal(readFileSync(keyPath, 'utf8'), original);
  assert.equal(
    readdirSync(fixture.profile).some((entry) => entry.startsWith('.movie-demo-api-key.tmp.')),
    false,
  );

  executable(join(fixture.bin, 'openssl'), `#!/bin/sh
printf '%s\\n' '${'c'.repeat(64)}'
`);
  const rotated = run(fixture, 'rotate-key');
  assert.equal(rotated.status, 0, rotated.stderr);
  assert.equal(readFileSync(keyPath, 'utf8'), `${'c'.repeat(64)}\n`);
  assert.equal(statSync(keyPath).mode & 0o777, 0o600);
});

test('deployment settings reach only the app without putting the API key in argv', () => {
  const fixture = makeFixture();
  completeSetup(fixture);
  clearCalls(fixture);
  const deployment = {
    HOST: '0.0.0.0',
    PORT: '8080',
    COOKIE_SECURE: 'true',
    MOVIE_DEMO_DB_PATH: '/var/lib/movie-booking/movie-demo.db',
  };

  const gateway = run(fixture, 'gateway', {
    ...deployment,
    API_SERVER_ENABLED: 'wrong',
    API_SERVER_KEY: 'wrong',
    API_SERVER_HOST: '0.0.0.0',
    API_SERVER_PORT: '9999',
    MOVIE_DEMO_ROOT: '/wrong',
  });
  const app = run(fixture, 'app', {
    ...deployment,
    HERMES_API_URL: 'http://wrong',
    API_SERVER_KEY: 'wrong',
  });

  assert.equal(gateway.status, 0, gateway.stderr);
  assert.equal(app.status, 0, app.stderr);
  assert.match(
    calls(fixture),
    new RegExp(
      `gateway-env:true\\|valid\\|127\\.0\\.0\\.1\\|8642\\|`
      + `${demoRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\|`
      + '/var/lib/movie-booking/movie-demo\\.db',
    ),
  );
  assert.match(calls(fixture), /gateway-deployment:unset\\|unset\\|unset/);
  assert.match(
    calls(fixture),
    new RegExp(
      'app-env:http://127\\.0\\.0\\.1:8642\\|valid\\|0\\.0\\.0\\.0\\|8080\\|true\\|'
      + '/var/lib/movie-booking/movie-demo\\.db',
    ),
  );
  assert.match(calls(fixture), /npm-argv:--prefix .* run start/);
  assert.doesNotMatch(calls(fixture), /env-argv:/);
  assert.doesNotMatch(`${calls(fixture)}${gateway.stdout}${gateway.stderr}${app.stdout}${app.stderr}`, new RegExp(initialKey));
});

test('HUP, INT, and TERM reach signal-resistant descendants under bash and zsh', async () => {
  for (const shell of ['/bin/bash', 'zsh']) {
    for (const [signal, expectedCode] of [
      ['SIGHUP', 129],
      ['SIGINT', 130],
      ['SIGTERM', 143],
    ] as const) {
      const fixture = makeFixture();
      const child = spawn(shell, [helper, 'setup'], {
        cwd: fixture.root,
        env: {
          ...fixture.env,
          FAKE_SETUP_BLOCK: '1',
          FAKE_RESIST_DESCENDANT: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      await waitFor(
        () => existsSync(fixture.env.MOVIE_TEST_GRANDCHILD_PID as string),
        `${shell}/${signal}: setup child did not start`,
      );
      const setupPid = Number(readFileSync(fixture.env.MOVIE_TEST_SETUP_PID as string, 'utf8'));
      const grandchildPid = Number(readFileSync(fixture.env.MOVIE_TEST_GRANDCHILD_PID as string, 'utf8'));

      child.kill(signal);
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once('exit', (code, exitSignal) => resolve({ code, signal: exitSignal }));
      });

      try {
        assert.equal(result.code, expectedCode, `${shell}/${signal}: exit signal=${result.signal}`);
        await waitFor(
          () => processStopped(setupPid) && processStopped(grandchildPid),
          `${shell}: supervised child survived ${signal}`,
        );
      } finally {
        if (!processStopped(setupPid)) process.kill(setupPid, 'SIGKILL');
        if (!processStopped(grandchildPid)) process.kill(grandchildPid, 'SIGKILL');
      }
    }
  }
});

test('the real Hermes CLI resolves the isolated target profile; only readiness is faked', {
  skip: spawnSync('/bin/sh', ['-c', 'command -v hermes']).status === 0
    ? false
    : 'Hermes is not installed',
}, () => {
  const realHermes = spawnSync('/bin/sh', ['-c', 'command -v hermes'], {
    encoding: 'utf8',
  }).stdout.trim();
  const fixture = makeFixture();

  executable(join(fixture.bin, 'hermes'), `#!/bin/sh
case " $* " in
  *" -z "*) printf '%s\\n' READY; exit 0 ;;
  *" setup "*)
    "$REAL_HERMES" "$@" --non-interactive || exit $?
    exec "$REAL_HERMES" -p movie-booking config set model.provider openai
    ;;
  *) exec "$REAL_HERMES" "$@" ;;
esac
`);

  const result = run(fixture, 'setup', { REAL_HERMES: realHermes });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(fixture.profile));
  assert.equal(existsSync(join(fixture.evilHome, 'profiles', profileName)), false);
  assert.equal(tokenFrom(join(fixture.profile, '.movie-demo-owner')), ownerToken);
});

test('the README and guide describe the narrow helper contract without parser claims', () => {
  for (const path of [
    join(demoRoot, 'README.md'),
    join(demoRoot, '..', '..', 'docs', 'guides', 'movie-ticket-booking.mdx'),
  ]) {
    const content = readFileSync(path, 'utf8');
    assert.match(content, /scripts\/setup\.sh setup/);
    assert.match(content, /scripts\/setup\.sh gateway/);
    assert.match(content, /scripts\/setup\.sh app/);
    assert.match(content, /scripts\/setup\.sh rotate-key/);
    assert.match(content, /provider request|provider usage/i);
    assert.match(content, /resume/i);
    assert.match(content, /no explicit no-tools|narrowest.*toolset/i);
    assert.doesNotMatch(content, /raw preflight|Hermes' own parsing rules/i);
    assert.doesNotMatch(content, /mktemp|openssl rand|node <<'NODE'/);
  }
});
