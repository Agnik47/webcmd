import { cli, Strategy } from '@agentrhq/webcmd/registry';

import { fetchPackageJson, summarizePackage } from './lib/api.js';

export async function packagePyPI(args, request = fetch) {
    const payload = await fetchPackageJson(args.name, request);
    return summarizePackage(payload);
}

cli({
    site: 'pypi',
    name: 'package',
    access: 'read',
    description: 'Inspect public PyPI package metadata',
    domain: 'pypi.org',
    strategy: Strategy.PUBLIC,
    browser: false,
    args: [
        { name: 'name', positional: true, required: true, type: 'string', help: 'Python package name, for example django' },
    ],
    columns: ['name', 'version', 'summary', 'author', 'license', 'requiresPython', 'uploadedAt', 'projectUrl', 'homepage', 'repository'],
    func: args => packagePyPI(args),
});
