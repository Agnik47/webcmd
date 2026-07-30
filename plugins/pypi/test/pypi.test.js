import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(pluginRoot, '..', '..');
const peerScopeDir = path.join(pluginRoot, 'node_modules', '@agentrhq');
const peerLink = path.join(peerScopeDir, 'webcmd');

let createdPeerLink = false;
if (!fs.existsSync(peerLink)) {
    fs.mkdirSync(peerScopeDir, { recursive: true });
    fs.symlinkSync(repoRoot, peerLink, 'dir');
    createdPeerLink = true;
}

after(() => {
    if (!createdPeerLink) return;
    fs.rmSync(peerLink, { force: true, recursive: true });
    for (const dir of [peerScopeDir, path.dirname(peerScopeDir)]) {
        try {
            fs.rmdirSync(dir);
        } catch {
            // Directory is not empty; leave unrelated local state alone.
        }
    }
});

const [{ getRegistry }, { packagePyPI }, { releasesPyPI }] = await Promise.all([
    import('@agentrhq/webcmd/registry'),
    import('../package.js'),
    import('../releases.js'),
]);

const payload = {
    info: {
        name: 'pictovap',
        version: '0.7.14',
        summary: 'Visual finishing engine for publishers',
        author: 'Kemal Kaya',
        license: 'MIT',
        requires_python: '>=3.10',
        home_page: 'https://github.com/yoldaolmak/Pictovap',
        project_urls: {
            Homepage: 'https://github.com/yoldaolmak/Pictovap',
            Repository: 'https://github.com/yoldaolmak/Pictovap',
        },
    },
    releases: {
        '0.7.14': [
            {
                upload_time_iso_8601: '2026-07-26T06:12:00.000Z',
                python_version: 'py3',
                yanked: false,
            },
            {
                upload_time_iso_8601: '2026-07-26T06:13:00.000Z',
                python_version: 'source',
                yanked: false,
            },
        ],
        '0.7.13': [
            {
                upload_time_iso_8601: '2026-07-26T05:22:00.000Z',
                python_version: 'py3',
                yanked: false,
            },
        ],
    },
};

function fakeRequest(responsePayload = payload, { ok = true, status = 200 } = {}) {
    const request = async (url, options) => {
        request.calls.push({ url: String(url), options });
        return {
            ok,
            status,
            json: async () => responsePayload,
        };
    };
    request.calls = [];
    return request;
}

test('package returns public PyPI project metadata', async () => {
    const request = fakeRequest();

    const rows = await packagePyPI({ name: 'pictovap' }, request);

    assert.deepEqual(rows, [{
        name: 'pictovap',
        version: '0.7.14',
        summary: 'Visual finishing engine for publishers',
        author: 'Kemal Kaya',
        license: 'MIT',
        requiresPython: '>=3.10',
        uploadedAt: '2026-07-26T06:13:00.000Z',
        projectUrl: 'https://pypi.org/project/pictovap/',
        homepage: 'https://github.com/yoldaolmak/Pictovap',
        repository: 'https://github.com/yoldaolmak/Pictovap',
    }]);
    assert.equal(request.calls[0].url, 'https://pypi.org/pypi/pictovap/json');
    assert.match(request.calls[0].options.headers['User-Agent'], /^webcmd\//);
});

test('releases returns recent release rows newest first', async () => {
    const rows = await releasesPyPI({ name: 'pictovap', limit: 2 }, fakeRequest());

    assert.deepEqual(rows, [
        {
            version: '0.7.14',
            uploadedAt: '2026-07-26T06:13:00.000Z',
            fileCount: 2,
            pythonVersions: 'py3, source',
            yanked: false,
            url: 'https://pypi.org/project/pictovap/0.7.14/',
        },
        {
            version: '0.7.13',
            uploadedAt: '2026-07-26T05:22:00.000Z',
            fileCount: 1,
            pythonVersions: 'py3',
            yanked: false,
            url: 'https://pypi.org/project/pictovap/0.7.13/',
        },
    ]);
});

test('rejects invalid package names and limits', async () => {
    await assert.rejects(
        () => packagePyPI({ name: '../secret' }, fakeRequest()),
        /package name/,
    );
    await assert.rejects(
        () => releasesPyPI({ name: 'pictovap', limit: 51 }, fakeRequest()),
        /integer between 1 and 50/,
    );
});

test('reports missing packages as empty results', async () => {
    await assert.rejects(
        () => packagePyPI({ name: 'missing-package' }, fakeRequest({}, { ok: false, status: 404 })),
        error => error.code === 'EMPTY_RESULT'
            && /no project named/.test(error.hint),
    );
});

test('registered handlers do not require a browser', async () => {
    const originalFetch = globalThis.fetch;
    try {
        globalThis.fetch = fakeRequest();
        const registry = getRegistry();

        const packageCommand = registry.get('pypi/package');
        const releasesCommand = registry.get('pypi/releases');
        assert.ok(packageCommand?.func);
        assert.ok(releasesCommand?.func);
        assert.equal(packageCommand.browser, false);
        assert.equal(releasesCommand.browser, false);
        await packageCommand.func({ name: 'pictovap' }, false);
        await releasesCommand.func({ name: 'pictovap', limit: 1 }, false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
