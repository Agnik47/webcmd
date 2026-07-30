import { ArgumentError, CommandExecutionError, EmptyResultError } from '@agentrhq/webcmd/errors';

const PYPI_BASE_URL = 'https://pypi.org/pypi';
const PACKAGE_URL_BASE = 'https://pypi.org/project';
const MAX_RELEASE_LIMIT = 50;

export function normalizePackageName(raw) {
    const name = String(raw ?? '').trim();
    if (!name) {
        throw new ArgumentError('package name is required');
    }
    if (name.length > 214 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
        throw new ArgumentError('package name must contain only letters, numbers, dots, underscores, and hyphens');
    }
    return name;
}

export function parseLimit(raw, fallback = 10) {
    const value = raw === undefined || raw === null || raw === '' ? fallback : Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > MAX_RELEASE_LIMIT) {
        throw new ArgumentError(`--limit must be an integer between 1 and ${MAX_RELEASE_LIMIT}`);
    }
    return value;
}

export async function fetchPackageJson(name, request = fetch) {
    const packageName = normalizePackageName(name);
    const url = `${PYPI_BASE_URL}/${encodeURIComponent(packageName)}/json`;

    let response;
    try {
        response = await request(url, {
            headers: {
                Accept: 'application/json',
                'User-Agent': 'webcmd/0.4 (+https://github.com/agentrhq/webcmd)',
            },
        });
    } catch (error) {
        throw new CommandExecutionError(`PyPI request failed: ${error.message}`);
    }

    if (response.status === 404) {
        throw new EmptyResultError('pypi package', `PyPI has no project named "${packageName}".`);
    }
    if (!response.ok) {
        throw new CommandExecutionError(`PyPI request failed with HTTP ${response.status}`);
    }

    let payload;
    try {
        payload = await response.json();
    } catch (error) {
        throw new CommandExecutionError(`PyPI returned malformed JSON: ${error.message}`);
    }
    if (!payload || typeof payload !== 'object' || !payload.info) {
        throw new CommandExecutionError('PyPI returned an unexpected response.');
    }
    return payload;
}

function projectUrl(info, label) {
    const urls = info?.project_urls;
    if (!urls || typeof urls !== 'object') return null;
    const match = Object.entries(urls).find(([name]) => name.toLowerCase() === label);
    return match ? match[1] : null;
}

function releaseFiles(payload, version) {
    const releases = payload?.releases;
    const files = releases && typeof releases === 'object' ? releases[version] : [];
    return Array.isArray(files) ? files : [];
}

function latestUploadTime(files) {
    return files
        .map(file => file?.upload_time_iso_8601 || file?.upload_time || null)
        .filter(Boolean)
        .sort()
        .at(-1) || null;
}

export function summarizePackage(payload) {
    const info = payload.info || {};
    const name = String(info.name || '').trim();
    const version = String(info.version || '').trim();
    if (!name || !version) {
        throw new CommandExecutionError('PyPI package metadata is missing a name or version.');
    }

    const files = releaseFiles(payload, version);
    return [{
        name,
        version,
        summary: info.summary || null,
        author: info.author || null,
        license: info.license || null,
        requiresPython: info.requires_python || null,
        uploadedAt: latestUploadTime(files),
        projectUrl: `${PACKAGE_URL_BASE}/${encodeURIComponent(name)}/`,
        homepage: projectUrl(info, 'homepage') || info.home_page || null,
        repository: projectUrl(info, 'repository') || projectUrl(info, 'source') || null,
    }];
}

export function summarizeReleases(payload, limit) {
    const info = payload.info || {};
    const name = String(info.name || '').trim();
    const releases = payload.releases && typeof payload.releases === 'object' ? payload.releases : {};
    const rows = Object.entries(releases)
        .map(([version, files]) => {
            const releaseFiles = Array.isArray(files) ? files : [];
            return {
                version,
                uploadedAt: latestUploadTime(releaseFiles),
                fileCount: releaseFiles.length,
                pythonVersions: [...new Set(releaseFiles.map(file => file?.python_version).filter(Boolean))].join(', ') || null,
                yanked: releaseFiles.length > 0 && releaseFiles.every(file => file?.yanked === true),
                url: `${PACKAGE_URL_BASE}/${encodeURIComponent(name)}/${encodeURIComponent(version)}/`,
            };
        })
        .filter(row => row.uploadedAt)
        .sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)))
        .slice(0, limit);

    if (!rows.length) {
        throw new EmptyResultError('pypi releases', `PyPI returned no release files for "${name}".`);
    }
    return rows;
}
