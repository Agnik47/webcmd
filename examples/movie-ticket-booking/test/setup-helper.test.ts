import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const demoRoot = join(import.meta.dirname, '..');
const helper = join(demoRoot, 'scripts', 'setup.sh');
const profileName = 'movie-booking';

type Fixture = ReturnType<typeof makeFixture>;

function installedHermesPython(): string | undefined {
  try {
    const lookup = spawnSync('/bin/sh', ['-c', 'command -v hermes'], { encoding: 'utf8' });
    const launcher = lookup.status === 0 ? lookup.stdout.trim() : '';
    if (!launcher) return undefined;
    const shebang = readFileSync(launcher, 'utf8').split(/\r?\n/, 1)[0];
    return /^#!(\S+)$/.exec(shebang)?.[1];
  } catch {
    return undefined;
  }
}

const preflightPython = installedHermesPython();

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
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    MOVIE_TEST_CALL_LOG: log,
    ...(preflightPython ? { MOVIE_DEMO_PREFLIGHT_PYTHON: preflightPython } : {}),
  };

  executable(join(bin, 'hermes'), `#!/bin/sh
printf 'hermes %s\\n' "$*" >> "$MOVIE_TEST_CALL_LOG"
case " $* " in
  *" profile create movie-booking "*)
    printf 'profile-home:%s\\n' "$HERMES_HOME" >> "$MOVIE_TEST_CALL_LOG"
    mkdir -p "$HOME/.hermes/profiles/movie-booking"
    : > "$HOME/.hermes/profiles/movie-booking/.env"
    exit "\${FAKE_PROFILE_CREATE_STATUS:-0}"
    ;;
  *" setup "*)
    exit "\${FAKE_SETUP_STATUS:-0}"
    ;;
  *" -z "*)
    test "\${FAKE_READY_STATUS:-0}" -eq 0 && printf '%s\\n' movie-booking-ready
    exit "\${FAKE_READY_STATUS:-0}"
    ;;
  *" gateway run "*)
    printf 'gateway-env:%s|%s|%s|%s|%s|%s\\n' \
      "$API_SERVER_ENABLED" "$API_SERVER_KEY" "$API_SERVER_HOST" \
      "$API_SERVER_PORT" "$MOVIE_DEMO_ROOT" "$MOVIE_DEMO_DB_PATH" \
      >> "$MOVIE_TEST_CALL_LOG"
    exit 0
    ;;
esac
exit 0
`);
executable(join(bin, 'npm'), `#!/bin/sh
printf 'npm %s\\n' "$*" >> "$MOVIE_TEST_CALL_LOG"
case " $* " in
  *" run dev "*)
    printf 'app-env:%s|%s|%s|%s\\n' \
      "$HERMES_API_URL" "$API_SERVER_KEY" "$PORT" "$MOVIE_DEMO_DB_PATH" \
      >> "$MOVIE_TEST_CALL_LOG"
    ;;
esac
exit "\${FAKE_NPM_STATUS:-0}"
`);
  executable(join(bin, 'openssl'), `#!/bin/sh
printf 'openssl %s\\n' "$*" >> "$MOVIE_TEST_CALL_LOG"
printf '%s\\n' "\${FAKE_KEY:-fixture-secret-key}"
`);

  return {
    root,
    home,
    bin,
    log,
    profile,
    owner,
    env,
  };
}

function run(fixture: Fixture, command = 'setup', extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync('/bin/bash', [helper, command], {
    cwd: fixture.root,
    env: { ...fixture.env, ...extraEnv },
    encoding: 'utf8',
  });
}

function calls(fixture: Fixture): string {
  return existsSync(fixture.log) ? readFileSync(fixture.log, 'utf8') : '';
}

test('setup owns a fresh profile, proves provider readiness, and safely resumes', () => {
  const fixture = makeFixture();
  const first = run(fixture);

  assert.equal(first.status, 0, first.stderr);
  assert.match(calls(fixture), /hermes profile create movie-booking --no-alias --no-skills/);
  assert.match(calls(fixture), new RegExp(`profile-home:${fixture.owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(calls(fixture), /hermes -p movie-booking setup/);
  assert.match(
    calls(fixture),
    /hermes -p movie-booking --ignore-rules -t context_engine -z Reply with exactly: movie-booking-ready/,
  );
  assert.match(calls(fixture), new RegExp(`npm --prefix ${demoRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} install`));
  assert.equal(
    readFileSync(join(fixture.profile, 'SOUL.md'), 'utf8'),
    readFileSync(join(demoRoot, 'hermes', 'SOUL.md'), 'utf8'),
  );
  assert.equal(
    readFileSync(join(fixture.profile, 'skills', 'movie-ticket-booking', 'SKILL.md'), 'utf8'),
    readFileSync(join(demoRoot, 'hermes', 'skills', 'movie-ticket-booking', 'SKILL.md'), 'utf8'),
  );
  const keyPath = join(fixture.profile, '.movie-demo-api-key');
  assert.equal(readFileSync(keyPath, 'utf8').trim(), 'fixture-secret-key');
  assert.equal(statSync(keyPath).mode & 0o777, 0o600);
  assert.ok(existsSync(join(fixture.owner, 'complete')));
  assert.doesNotMatch(`${first.stdout}${first.stderr}`, /fixture-secret-key/);

  writeFileSync(fixture.log, '');
  const second = spawnSync('zsh', [helper, 'setup'], {
    cwd: fixture.root,
    env: fixture.env,
    encoding: 'utf8',
  });
  assert.equal(second.status, 0, second.stderr);
  assert.doesNotMatch(calls(fixture), /profile create| setup | -z /);
  assert.equal(readFileSync(keyPath, 'utf8').trim(), 'fixture-secret-key');
});

test('setup refuses an existing profile it does not own without mutation', () => {
  const fixture = makeFixture();
  mkdirSync(fixture.profile, { recursive: true });
  const soul = join(fixture.profile, 'SOUL.md');
  writeFileSync(soul, 'unrelated profile\n');

  const result = run(fixture);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not owned|unrelated/i);
  assert.equal(readFileSync(soul, 'utf8'), 'unrelated profile\n');
  assert.equal(calls(fixture), '');
  assert.equal(existsSync(fixture.owner), false);
});

test('a marker-owned partial profile resumes, while failed readiness stays partial', () => {
  const fixture = makeFixture();
  mkdirSync(fixture.profile, { recursive: true });
  mkdirSync(fixture.owner, { recursive: true });
  writeFileSync(join(fixture.profile, '.env'), '');

  const failed = run(fixture, 'setup', { FAKE_READY_STATUS: '9' });

  assert.equal(failed.status, 9, failed.stderr);
  assert.match(calls(fixture), /hermes -p movie-booking setup/);
  assert.match(calls(fixture), / -z /);
  assert.equal(existsSync(join(fixture.owner, 'complete')), false);
  assert.equal(existsSync(join(fixture.profile, 'SOUL.md')), false);
  assert.equal(existsSync(join(fixture.profile, '.movie-demo-api-key')), false);

  writeFileSync(fixture.log, '');
  const resumed = run(fixture);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.doesNotMatch(calls(fixture), /profile create/);
  assert.ok(existsSync(join(fixture.owner, 'complete')));
});

test('setup exit zero is not accepted when the configured provider cannot answer', () => {
  const fixture = makeFixture();
  const result = run(fixture, 'setup', { FAKE_SETUP_STATUS: '0', FAKE_READY_STATUS: '7' });

  assert.equal(result.status, 7, result.stderr);
  assert.match(calls(fixture), /hermes -p movie-booking setup/);
  assert.match(calls(fixture), / -z /);
  assert.equal(existsSync(join(fixture.owner, 'complete')), false);
  assert.equal(existsSync(join(fixture.profile, 'SOUL.md')), false);
  assert.equal(existsSync(join(fixture.profile, '.movie-demo-api-key')), false);
});

test('raw preflight rejects enabled secret sources without invoking Hermes or fetching', {
  skip: preflightPython ? false : 'Hermes is not installed',
}, () => {
  const fixture = makeFixture();
  mkdirSync(fixture.profile, { recursive: true });
  mkdirSync(fixture.owner, { recursive: true });
  writeFileSync(join(fixture.profile, 'config.yaml'), [
    'secrets:',
    '  onepassword:',
    '    enabled: "false"',
    '',
  ].join('\n'));

  const result = run(fixture);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /secret source.*enabled.*onepassword/i);
  assert.equal(calls(fixture), '');
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /fetch/i);

  writeFileSync(join(fixture.profile, 'config.yaml'), [
    'secrets:',
    '  onepassword:',
    '    enabled: false',
    '',
  ].join('\n'));
  const disabled = run(fixture, 'setup', { FAKE_READY_STATUS: '8' });
  assert.equal(disabled.status, 8, disabled.stderr);
  assert.match(calls(fixture), /hermes -p movie-booking setup/);
});

test('raw preflight rejects profile and managed dotenv authority conflicts', {
  skip: preflightPython ? false : 'Hermes is not installed',
}, () => {
  for (const [name, prepare, expected] of [
    [
      'profile',
      (fixture: Fixture) => {
        mkdirSync(fixture.profile, { recursive: true });
        mkdirSync(fixture.owner, { recursive: true });
        writeFileSync(join(fixture.profile, '.env'), 'API_SERVER_PORT=9999\n');
      },
      /API_SERVER_PORT/,
    ],
    [
      'managed',
      (fixture: Fixture) => {
        const managed = join(fixture.root, 'managed path');
        mkdirSync(managed, { recursive: true });
        writeFileSync(join(managed, '.env'), 'MOVIE_DEMO_DB_PATH=/tmp/wrong.db\n');
        fixture.env.HERMES_MANAGED_DIR = managed;
      },
      /MOVIE_DEMO_DB_PATH/,
    ],
  ] as const) {
    const fixture = makeFixture();
    prepare(fixture);
    const result = run(fixture);
    assert.notEqual(result.status, 0, `${name}: ${result.stderr}`);
    assert.match(result.stderr, expected, name);
    assert.equal(calls(fixture), '', name);
  }
});

test('rotation is atomic on generator failure and cleans temporary files on signals', () => {
  const fixture = makeFixture();
  mkdirSync(fixture.profile, { recursive: true });
  mkdirSync(fixture.owner, { recursive: true });
  writeFileSync(join(fixture.owner, 'complete'), '');
  writeFileSync(join(fixture.profile, '.env'), '', { mode: 0o600 });
  const keyPath = join(fixture.profile, '.movie-demo-api-key');
  writeFileSync(keyPath, 'old-key\n', { mode: 0o600 });

  executable(join(fixture.bin, 'openssl'), `#!/bin/sh
printf partial
exit 12
`);
  const failed = run(fixture, 'rotate-key');
  assert.equal(failed.status, 12, failed.stderr);
  assert.equal(readFileSync(keyPath, 'utf8'), 'old-key\n');
  assert.deepEqual(readdirSync(fixture.profile).filter((name) => name.includes('.tmp.')), []);

  executable(join(fixture.bin, 'openssl'), `#!/bin/sh
printf partial
kill -TERM "$PPID"
sleep 1
`);
  const signalled = run(fixture, 'rotate-key');
  assert.equal(signalled.status, 143, signalled.stderr);
  assert.equal(readFileSync(keyPath, 'utf8'), 'old-key\n');
  assert.deepEqual(readdirSync(fixture.profile).filter((name) => name.includes('.tmp.')), []);
});

test('gateway launch keeps the demo key, host, port, root, and database authoritative', () => {
  const fixture = makeFixture();
  mkdirSync(fixture.profile, { recursive: true });
  mkdirSync(fixture.owner, { recursive: true });
  mkdirSync(join(fixture.owner, 'managed'), { recursive: true });
  writeFileSync(join(fixture.owner, 'complete'), '');
  writeFileSync(join(fixture.profile, '.env'), '');
  writeFileSync(join(fixture.profile, '.movie-demo-api-key'), 'gateway-secret\n', { mode: 0o600 });

  const result = run(fixture, 'gateway', {
    API_SERVER_ENABLED: 'wrong',
    API_SERVER_KEY: 'wrong',
    API_SERVER_HOST: '0.0.0.0',
    API_SERVER_PORT: '9999',
    MOVIE_DEMO_ROOT: '/wrong',
    MOVIE_DEMO_DB_PATH: '/wrong.db',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    calls(fixture),
    new RegExp(
      `gateway-env:true\\|gateway-secret\\|127\\.0\\.0\\.1\\|8642\\|`
      + `${demoRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\|`
      + `${join(demoRoot, 'movie-demo.db').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
    ),
  );
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /gateway-secret/);

  const app = run(fixture, 'app', {
    HERMES_API_URL: 'http://wrong',
    API_SERVER_KEY: 'wrong',
    PORT: '9999',
    MOVIE_DEMO_DB_PATH: '/wrong.db',
  });
  assert.equal(app.status, 0, app.stderr);
  assert.match(
    calls(fixture),
    new RegExp(
      `app-env:http://127\\.0\\.0\\.1:8642\\|gateway-secret\\|3000\\|`
      + `${join(demoRoot, 'movie-demo.db').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
    ),
  );
  assert.doesNotMatch(`${app.stdout}${app.stderr}`, /gateway-secret/);
});

test('the README and guide delegate setup, launch, and rotation to the helper', () => {
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
    assert.doesNotMatch(content, /hermes config get secrets/);
    assert.doesNotMatch(content, /mktemp|openssl rand|node <<'NODE'/);
  }
});
