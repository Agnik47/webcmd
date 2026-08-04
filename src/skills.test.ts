import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { ArgumentError } from './errors.js';
import { addWebcmdSkills, listWebcmdSkills, removeWebcmdSkills, updateWebcmdSkill } from './skills.js';

function makePackageRoot(label = 'current'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `webcmd-skills-${label}-`));
  fs.mkdirSync(path.join(root, 'skills', 'webcmd-browser'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills', 'webcmd-autofix'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills', 'smart-search'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"@agentrhq/webcmd"}\n');
  fs.writeFileSync(path.join(root, 'skills', 'webcmd-browser', 'SKILL.md'), [
    '---',
    'name: webcmd-browser',
    `description: Browser control skill ${label}`,
    'version: 1.2.3',
    '---',
    '',
    '# Browser',
    '',
    'Body.',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'skills', 'webcmd-autofix', 'SKILL.md'), [
    '---',
    'name: webcmd-autofix',
    'description: Fix adapters: keep scope narrow',
    '---',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'skills', 'smart-search', 'SKILL.md'), [
    '---',
    'name: smart-search',
    'description: Search skill',
    '---',
    '',
  ].join('\n'));
  return root;
}

function real(filePath: string): string {
  return fs.realpathSync(filePath);
}

function bundledSkill(name: string): string {
  return fs.readFileSync(path.join(process.cwd(), 'skills', name, 'SKILL.md'), 'utf8');
}

describe('webcmd skills content', () => {
  it('keeps smart search on live discovery and explicit fetch escalation', () => {
    const skill = bundledSkill('smart-search');
    expect(skill).toContain('webcmd list --tag search -f json');
    expect(skill).toContain('webcmd plugin search');
    expect(skill).toContain('webcmd plugin install');
    expect(skill).toContain('FETCH_BLOCKED');
    expect(skill).toContain('FETCH_REQUIRES_BROWSER');
    expect(skill).toContain('webcmd web fetch-browser');
    expect(skill).toContain('Search Summary');
    expect(skill).toMatch(/at most three.*plugin/i);
    expect(skill).toMatch(/up to five.*candidate/i);
    expect(skill).toMatch(/three.*URL.*default/i);
    expect(skill).toMatch(/two.*browser fetch/i);
    expect(skill).not.toContain('references/sources-');
    for (const name of ['ai', 'info', 'media', 'other', 'shopping', 'social', 'tech', 'travel']) {
      expect(fs.existsSync(path.join(process.cwd(), 'skills', 'smart-search', 'references', `sources-${name}.md`))).toBe(false);
    }
  });
  it('keeps bundled skill frontmatter valid yaml', () => {
    const skillsRoot = path.join(process.cwd(), 'skills');
    const skillNames = fs.readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    for (const name of skillNames) {
      const content = fs.readFileSync(path.join(skillsRoot, name, 'SKILL.md'), 'utf8');
      const end = content.indexOf('\n---', 4);
      expect(end, name).toBeGreaterThan(0);
      expect(() => yaml.load(content.slice(4, end)), name).not.toThrow();
    }
  });

  it('lists bundled skills', () => {
    const root = makePackageRoot();

    expect(listWebcmdSkills(root).map((skill) => skill.name)).toEqual([
      'smart-search',
      'webcmd-autofix',
      'webcmd-browser',
    ]);
    expect(listWebcmdSkills(root).find((skill) => skill.name === 'webcmd-autofix')?.description)
      .toBe('Fix adapters: keep scope narrow');
  });

  it('keeps the expected installable skill set', () => {
    const skills = fs.readdirSync(path.join(process.cwd(), 'skills'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(skills).toEqual([
      'smart-search',
      'webcmd-adapter-author',
      'webcmd-autofix',
      'webcmd-browser',
      'webcmd-browser-sitemap',
      'webcmd-sitemap-author',
      'webcmd-usage',
    ]);
  });

  it('enforces mode-neutral authentication and human handoff policy', () => {
    const browser = bundledSkill('webcmd-browser');
    const usage = bundledSkill('webcmd-usage');
    const autofix = bundledSkill('webcmd-autofix');
    const author = bundledSkill('webcmd-adapter-author');
    const skills = [browser, usage, autofix, author];
    const handoffSkills = [browser, usage, autofix];
    const autofixAuthRequired = autofix.match(/^- \*\*`AUTH_REQUIRED`\*\*[\s\S]*?(?=\n- \*\*)/m)?.[0] ?? '';
    const autofixAuthRequiredRow = autofix.split('\n')
      .find((line) => line.startsWith('| AUTH_REQUIRED |')) ?? '';

    expect(browser).toContain('webcmd <site> login');
    expect(browser).toContain('webcmd <site> whoami');
    expect(browser).toContain('CAPTCHA');
    expect(browser).toContain('fresh browser state');
    expect(browser).not.toContain('hunter2');
    expect(browser).not.toMatch(/browser login type/i);
    expect(usage).toContain('AUTH_REQUIRED');
    expect(usage).toContain('action_required');
    expect(autofix).toContain('webcmd <site> login');
    expect(author).toContain('registerSiteAuthCommands');
    for (const skill of handoffSkills) {
      expect(skill).toContain('handoff.status');
      expect(skill).toContain('handoff.viewUrl');
      expect(skill).toContain('handoff.verifyCommand');
      expect(skill).toContain('Webcmd browser:');
      expect(skill).not.toMatch(/\bhosted\b|\bKernel\b|\blocal mode\b|\blocally\b/i);
    }
    for (const skill of [browser, usage]) {
      expect(skill).toContain('already_logged_in');
      expect(skill).toContain('in_progress');
      expect(skill).toContain('action_url');
      expect(skill).toContain('view_url');
      expect(skill).toMatch(/in_progress[^\n]*(?:do not ask the user|do not wait for user confirmation)/i);
      expect(skill).toMatch(/(?:action_url|view_url|handoff\.viewUrl|Webcmd browser:)[\s\S]{0,300}user/i);
    }
    for (const skill of skills) {
      expect(skill).toContain('action_required');
      expect(skill).toContain('verify_command');
      expect(skill).toMatch(/verify_command[\s\S]{0,250}verification must succeed[\s\S]{0,250}retry/i);
      expect(skill).toMatch(/verify_command[\s\S]{0,250}user[\s\S]{0,250}(?:done|complet)/i);
      expect(skill).toMatch(/CAPTCHA[\s\S]{0,250}(?:human handoff|stop(?:s)? automation)/i);
      expect(skill).toMatch(/(?:must not|never).*?(?:password|secret|credential)/i);
    }
    for (const skill of [browser, usage, autofix]) {
      expect(skill).toMatch(/(?:no (?:site )?login command|without a verifier)[\s\S]{0,500}fresh browser state[\s\S]{0,500}(?:identity check|post-action state)[\s\S]{0,250}before (?:any )?retry/i);
    }
    expect(autofixAuthRequired).toMatch(/if (?:a|the) site login command exists[\s\S]*webcmd <site> login[\s\S]*returned `verify_command`[\s\S]*verification must succeed[\s\S]*retry/i);
    expect(autofixAuthRequired).toMatch(/no site login command[\s\S]*stop (?:browser )?writes[\s\S]*visible browser[\s\S]*fresh browser state[\s\S]*(?:identity check|post-action state)[\s\S]*before retry[\s\S]*report alone is not verification/i);
    expect(autofixAuthRequiredRow).toMatch(/conditional[^|]*Safety Boundaries|no site login command/i);
    expect(autofix).toMatch(/CAPTCHA[\s\S]{0,250}stop automation[\s\S]{0,250}verification must succeed/i);
  });

  it('teaches browser-run selection and preserves the adapter API boundary', () => {
    const browser = bundledSkill('webcmd-browser');
    const usage = bundledSkill('webcmd-usage');
    const author = bundledSkill('webcmd-adapter-author');
    const browserRunReference = fs.readFileSync(
      path.join(
        process.cwd(),
        'skills',
        'webcmd-browser',
        'references',
        'browser-run-playwright.md',
      ),
      'utf8',
    );
    const reconReferencePath = path.join(
      process.cwd(),
      'skills',
      'webcmd-adapter-author',
      'references',
      'recon-to-ipage.md',
    );
    const commandReferenceIndex = browser.indexOf('## Command reference');
    const runFirstIndex = browser.indexOf('## Run-first decision loop');
    const antiPatternIndex = browser.indexOf('### Do not alternate open and one-operation run');
    const customDropdown = browser.match(
      /### Pick from a custom React dropdown[\s\S]*?(?=\n### |\n---)/,
    )?.[0] ?? '';
    const nativeDropdown = browser.match(
      /### Pick from a long dropdown[\s\S]*?(?=\n### |\n---)/,
    )?.[0] ?? '';
    const selectCompound = browser.match(
      /### Select[\s\S]*?(?=\n### File)/,
    )?.[0] ?? '';
    const formExample = browser.match(
      /### Reconnaissance-to-run form example[\s\S]*?(?=\n---)/,
    )?.[0] ?? '';
    const paginationExamples = [
      browser.match(/### Known destination: start with run[\s\S]*?(?=\n### |\n---)/)?.[0] ?? '',
      browserRunReference.match(/## Program ownership[\s\S]*?(?=\n## )/)?.[0] ?? '',
    ];

    expect(usage).toContain('REQUIRED SUB-SKILL');
    expect(usage).toMatch(/before (?:the )?first raw `webcmd browser` command[\s\S]{0,160}`webcmd-browser`/i);
    expect(browser).toContain('Run-first decision loop');
    expect(runFirstIndex).toBeGreaterThan(-1);
    expect(antiPatternIndex).toBeGreaterThan(runFirstIndex);
    expect(commandReferenceIndex).toBeGreaterThan(antiPatternIndex);
    expect(browser).toContain('## Adapter fallback gate');
    expect(browser).toMatch(/Prefer site adapters before raw browser driving/i);
    expect(browser).toMatch(/state the next unknown whose answer requires agent reasoning/i);
    expect(browser).toMatch(
      /every known navigation[\s\S]{0,240}(?:interaction|loop|pagination)[\s\S]{0,240}one `browser run`/i,
    );
    expect(browser).toMatch(
      /`browser run` may be the first raw browser command[\s\S]{0,240}`page\.goto\(\)`/i,
    );
    expect(browser).toContain('open -> one-operation run');
    expect(browser).toMatch(
      /do not use `browser open`[\s\S]{0,240}run that only reads/i,
    );
    expect(browser).toMatch(
      /one `page\.evaluate\(\)`[\s\S]{0,240}(?:use|keep) (?:an|the) isolated primitive/i,
    );
    expect(browser).toMatch(
      /one run per[\s\S]{0,240}(?:pagination page|candidate|revision|search iteration)/i,
    );
    expect(browser).toMatch(/return only the compact result needed/i);
    expect(browser).toMatch(
      /safe screenshot[\s\S]{0,300}page\.screenshot\(\)[\s\S]{0,300}sandbox receipt/i,
    );
    expect(browser).toMatch(
      /browser screenshot primitive[\s\S]{0,240}(?:isolated screenshot|exact host path)/i,
    );
    expect(browser).toMatch(
      /unsupported-run-surface exception[\s\S]{0,300}host cache[\s\S]{0,300}genuine decision boundary[\s\S]{0,300}--detail/i,
    );
    expect(nativeDropdown).toMatch(
      /stable locator[\s\S]*selectOption\([\s\S]*inputValue\(\)/i,
    );
    expect(browser).toContain("run --stdin <<'JS'");
    expect(browser).toContain('await page.goto(');
    expect(browser).toContain('Recon-to-run locator translation');
    expect(browser).toContain('not the adapter `IPage` API');
    expect(browserRunReference).toContain('waitForResponse');
    expect(browserRunReference).toContain('Arm the waiter before');
    expect(browserRunReference).toContain('fresh QuickJS runtime');
    expect(browserRunReference).toContain('Program ownership');
    expect(browserRunReference).toContain('evaluateAll');
    expect(browserRunReference).toContain('filter');
    expect(browserRunReference).toContain('all()');
    expect(browserRunReference).toContain('getByAltText');
    expect(browserRunReference).toContain('getByTitle');
    expect(browserRunReference).toContain('waitForSelector');
    expect(browserRunReference).toContain('locator.screenshot');
    expect(browserRunReference).toContain('BROWSER_RUN_API_UNSUPPORTED');
    expect(browserRunReference).toMatch(
      /artifact receipt[\s\S]{0,300}actual (?:stored )?path[\s\S]{0,300}(?:does not|never)[\s\S]*?host write\s+authority/i,
    );
    expect(browserRunReference).toMatch(
      /one run owns[\s\S]{0,240}(?:navigation|pagination|loop)[\s\S]{0,240}next reasoning decision/i,
    );
    expect(browserRunReference).toContain('let pagesChecked = 0');
    expect(browserRunReference).toContain('await page.goto(');
    expect(browserRunReference).toMatch(/return \{[\s\S]{0,240}pagesChecked/i);
    for (const example of paginationExamples) {
      expect(example).toMatch(
        /const rows[\s\S]{0,240}pagesChecked \+= 1;[\s\S]{0,240}pagesChecked >= 10[\s\S]{0,240}next\.isVisible\(\)[\s\S]{0,240}break;[\s\S]{0,240}await next\.click\(\)/,
      );
      expect(example).toMatch(
        /next\.evaluate\([\s\S]{0,240}page\.waitForURL\([\s\S]{0,240}await next\.click\(\)[\s\S]{0,240}await navigation/,
      );
    }
    expect(customDropdown).toContain('one `browser run`');
    expect(customDropdown).toMatch(
      /await trigger\.click\(\)[\s\S]{0,300}await option\.click\(\)[\s\S]{0,300}return \{ selected \};/,
    );
    expect(customDropdown).not.toMatch(
      /browser mercury (?:state|click)[\s\S]{0,200}browser mercury click[\s\S]{0,200}browser mercury (?:state|click|get text)/,
    );
    expect(nativeDropdown).toMatch(
      /observed (?:option )?(?:value|label)[\s\S]{0,240}(?:do not|never) (?:invent|guess)[\s\S]{0,240}decision\s+boundary/i,
    );
    expect(selectCompound).toContain('options_total > options.length');
    expect(selectCompound).toContain('bounded `browser run`');
    expect(selectCompound).toMatch(/live `<option>` set/i);
    expect(nativeDropdown).toMatch(
      /page\.evaluate\([\s\S]{0,500}candidates[\s\S]{0,500}selectOption\(candidates\[0\]\.value\)/,
    );
    expect(browserRunReference).toMatch(
      /`check`[\s\S]{0,120}`uncheck`[\s\S]{0,200}`setChecked`/i,
    );
    expect(browser).toMatch(/`browser open` is only an isolated navigation exception/i);
    expect(browser).toMatch(/known navigation plus inspection belongs in `page\.goto\(\)` inside a run/i);
    expect(browser).toMatch(/known write chains plus verification belong in one run/i);
    expect(browser).toMatch(/`reidentified` result may remain a genuine reconnaissance boundary/i);
    expect(browser).toMatch(/user-supplied host path[\s\S]{0,180}`browser upload`/i);
    expect(browser).toMatch(/generated in-memory content[\s\S]{0,180}`setInputFiles\(\)` inside `browser run`/i);
    expect(browser).toMatch(/user\s+file choice without a path[\s\S]{0,180}visible human handoff/i);
    expect(formExample.match(/webcmd browser work state/g)).toHaveLength(1);
    expect(browser).toMatch(/inspect after a run only when its evidence is\s+unexpected or insufficient and changes the next plan/i);
    expect(author).toMatch(
      /Browser-run’s Playwright-style `page` and adapter `func\(page,args\)` are different contracts\.[\s\S]{0,240}Preserve evidence and behavior, not syntax\./,
    );
    expect(author).not.toContain('recon-to-ipage.md');
    expect(fs.existsSync(reconReferencePath)).toBe(false);
  });

  it('adds bundled skills once and refreshes them after package updates', () => {
    const firstRoot = makePackageRoot('first');
    const secondRoot = makePackageRoot('second');
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcmd-home-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'webcmd-project-'));

    const added = addWebcmdSkills({ packageRoot: firstRoot, homeDir, cwd, provider: 'codex', scope: 'project' });

    expect(added).toMatchObject({
      provider: 'codex',
      scope: 'project',
    });
    expect(added.skills.map((skill) => skill.name)).toEqual(['smart-search', 'webcmd-autofix', 'webcmd-browser']);
    for (const skill of added.skills) {
      expect(skill.source).toBe(path.join(firstRoot, 'skills', skill.name));
      expect(skill.stableLink).toBe(path.join(homeDir, '.webcmd', 'skills', skill.name));
      expect(skill.destination).toBe(path.join(cwd, '.codex', 'skills', skill.name));
      expect(real(skill.destination!)).toBe(real(skill.source));
    }

    const updated = updateWebcmdSkill({ packageRoot: secondRoot, homeDir });

    expect(updated.skills.every((skill) => skill.destination === undefined)).toBe(true);
    for (const skill of added.skills) {
      expect(real(skill.destination!)).toBe(real(path.join(secondRoot, 'skills', skill.name)));
    }
  });

  it('adds bundled skills into a custom skills directory', () => {
    const packageRoot = makePackageRoot();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcmd-home-'));
    const customPath = fs.mkdtempSync(path.join(os.tmpdir(), 'webcmd-custom-skills-'));

    const added = addWebcmdSkills({ packageRoot, homeDir, customPath });

    expect(added.provider).toBeUndefined();
    expect(added.skills.map((skill) => skill.destination)).toEqual([
      path.join(customPath, 'smart-search'),
      path.join(customPath, 'webcmd-autofix'),
      path.join(customPath, 'webcmd-browser'),
    ]);
    for (const skill of added.skills) {
      expect(real(skill.destination!)).toBe(real(skill.source));
    }
  });

  it('refuses to replace real files or directories', () => {
    const packageRoot = makePackageRoot();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcmd-home-'));
    const stablePath = path.join(homeDir, '.webcmd', 'skills', 'smart-search');
    fs.mkdirSync(stablePath, { recursive: true });

    expect(() => updateWebcmdSkill({ packageRoot, homeDir })).toThrow(ArgumentError);
  });

  it('removes bundled skill links from every supported location', () => {
    const packageRoot = makePackageRoot();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcmd-home-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'webcmd-project-'));
    const customPath = fs.mkdtempSync(path.join(os.tmpdir(), 'webcmd-custom-skills-'));

    for (const provider of ['agents', 'codex', 'claude']) {
      addWebcmdSkills({ packageRoot, homeDir, cwd, provider, scope: 'user' });
      addWebcmdSkills({ packageRoot, homeDir, cwd, provider, scope: 'project' });
    }
    addWebcmdSkills({ packageRoot, homeDir, cwd, customPath });

    const result = removeWebcmdSkills({ packageRoot, homeDir, cwd, customPath });

    expect(result.removed).toHaveLength(24);
    for (const linkPath of result.removed) {
      expect(() => fs.lstatSync(linkPath)).toThrow();
    }
    expect(removeWebcmdSkills({ packageRoot, homeDir, cwd, customPath })).toEqual({ removed: [] });
  });

  it('refuses removal before deleting any links when a destination is not a symlink', () => {
    const packageRoot = makePackageRoot();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcmd-home-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'webcmd-project-'));
    const added = addWebcmdSkills({ packageRoot, homeDir, cwd, provider: 'agents', scope: 'user' });
    const blocker = path.join(cwd, '.codex', 'skills', 'smart-search');
    fs.mkdirSync(blocker, { recursive: true });

    expect(() => removeWebcmdSkills({ packageRoot, homeDir, cwd })).toThrow(ArgumentError);
    expect(fs.lstatSync(added.skills[0].destination!).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(blocker).isDirectory()).toBe(true);
  });
});
