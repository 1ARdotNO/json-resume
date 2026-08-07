// Self-hosted JSON Resume registry build.
//
// Fetches a JSON Resume from a GitHub gist (the way registry.jsonresume.org
// does), renders it with a jsonresume theme, and writes a static site into
// ./dist ready for GitHub Pages.
//
// Everything is configurable through environment variables so the same script
// can serve any user/gist without code changes:
//
//   RESUME_URL    Raw resume.json URL to fetch. Defaults to the profile gist's
//                 raw URL, which always resolves to the latest revision and
//                 needs no API token. This is the default source.
//   RESUME_USER   GitHub username whose gists are searched (via the GitHub API)
//                 for a resume.json. Opt-in; overrides RESUME_URL when set.
//   RESUME_GIST   Pin a specific gist id and fetch it via the GitHub API.
//                 Opt-in; overrides RESUME_URL when set.
//   RESUME_THEME  Theme name without the "jsonresume-theme-" prefix. Defaults
//                 to resume.meta.theme, then "stackoverflow".
//   RESUME_DOMAIN Custom domain written to dist/CNAME (default: resume.1ar.no).
//                 Set to an empty string to skip the CNAME file.
//   GITHUB_TOKEN  Optional; used only to raise the GitHub API rate limit.
//
// The functions below are exported so they can be unit-tested in isolation
// (see test/). Network access is injected via a `fetchImpl` argument so the
// tests never touch the real network. main() only runs when this file is
// executed directly, not when it is imported.

import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { render } from 'resumed';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST_DIR = join(ROOT, 'dist');

// Default source: the profile gist's raw URL. Without a commit SHA this always
// serves the latest revision, so the daily rebuild picks up gist edits, and it
// needs no GitHub API token.
export const DEFAULT_RESUME_URL =
  'https://gist.githubusercontent.com/1ARdotNO/7224de9f9b8e9e9691520193b1782594/raw/resume.json';

export const DEFAULT_DOMAIN = 'resume.1ar.no';
export const DEFAULT_THEME = 'stackoverflow';

// Build the config object from an environment bag (defaults to process.env).
export function resolveConfig(env = process.env) {
  return {
    user: env.RESUME_USER || '',
    gist: env.RESUME_GIST || '',
    url: env.RESUME_URL || '',
    theme: env.RESUME_THEME || '',
    domain: env.RESUME_DOMAIN ?? DEFAULT_DOMAIN,
    token: env.GITHUB_TOKEN || '',
  };
}

function ghHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'json-resume-registry',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function fetchJson(fetchImpl, url, headers) {
  const res = await fetchImpl(url, { headers });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res.json();
}

async function fetchText(fetchImpl, url, headers) {
  const res = await fetchImpl(url, { headers });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res.text();
}

// Returns the raw resume.json text plus a human-readable description of where
// it came from. `fetchImpl` is injectable for testing.
export async function loadResume(config, { fetchImpl = fetch, log = () => {} } = {}) {
  const headers = ghHeaders(config.token);

  // API paths are opt-in via RESUME_GIST / RESUME_USER. Otherwise fetch a raw
  // URL (explicit RESUME_URL, else the default gist raw URL) — no token needed.
  if (!config.gist && !config.user) {
    const url = config.url || DEFAULT_RESUME_URL;
    log(`Fetching resume from raw URL: ${url}`);
    return { text: await fetchText(fetchImpl, url, headers), source: url };
  }

  let gist;
  if (config.gist) {
    log(`Fetching gist ${config.gist} via the GitHub API`);
    gist = await fetchJson(fetchImpl, `https://api.github.com/gists/${config.gist}`, headers);
  } else {
    log(`Searching gists of @${config.user} for a resume.json`);
    const gists = await fetchJson(
      fetchImpl,
      `https://api.github.com/users/${config.user}/gists?per_page=100`,
      headers,
    );
    gist = Array.isArray(gists) && gists.find((g) => g.files && g.files['resume.json']);
    if (!gist) throw new Error(`No public gist named resume.json found for @${config.user}`);
    // Re-fetch the full gist so file contents are populated.
    gist = await fetchJson(fetchImpl, `https://api.github.com/gists/${gist.id}`, headers);
  }

  const file = gist.files && gist.files['resume.json'];
  if (!file) throw new Error(`Gist ${gist.id} does not contain a resume.json file`);

  // Gist file contents are inlined unless truncated, in which case fetch raw.
  const text = file.truncated ? await fetchText(fetchImpl, file.raw_url, headers) : file.content;
  return {
    text,
    source: gist.html_url || `https://gist.github.com/${config.user}/${gist.id}`,
  };
}

// Parse resume JSON, throwing a friendly error on malformed input.
export function parseResume(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`resume.json is not valid JSON: ${err.message}`);
  }
}

// Decide which theme name to use: explicit override > resume.meta.theme > default.
export function resolveThemeName(config, resume) {
  return config.theme || resume?.meta?.theme || DEFAULT_THEME;
}

// Import a theme package, falling back to the bundled default when the named
// theme is not installed.
export async function loadTheme(name, { log = () => {} } = {}) {
  const pkg = `jsonresume-theme-${name}`;
  try {
    const mod = await import(pkg);
    return { name, theme: mod.default ?? mod };
  } catch (err) {
    if (name !== DEFAULT_THEME) {
      log(`Theme "${pkg}" is not installed (${err.message}); falling back to ${DEFAULT_THEME}.`);
      const mod = await import(`jsonresume-theme-${DEFAULT_THEME}`);
      return { name: DEFAULT_THEME, theme: mod.default ?? mod };
    }
    throw err;
  }
}

// Render `resume` with `theme` and write the static site into `distDir`.
// Returns a manifest describing what was written.
export async function buildSite({
  resume,
  theme,
  themeName,
  distDir = DIST_DIR,
  root = ROOT,
  domain = DEFAULT_DOMAIN,
}) {
  const html = await render(resume, theme);

  await mkdir(distDir, { recursive: true });
  await writeFile(join(distDir, 'index.html'), html);
  // Expose the raw resume.json as a registry-style endpoint.
  await writeFile(join(distDir, 'resume.json'), JSON.stringify(resume, null, 2));

  // The stackoverflow theme links to ./override.css for user tweaks; ship it so
  // there is never a 404 (a project-level public/override.css wins if present).
  const overrideSrc = join(root, 'public', 'override.css');
  const overrideDest = join(distDir, 'override.css');
  if (existsSync(overrideSrc)) {
    await copyFile(overrideSrc, overrideDest);
  } else {
    await writeFile(overrideDest, '/* Add custom CSS overrides here. */\n');
  }

  // Disable Jekyll processing on GitHub Pages.
  await writeFile(join(distDir, '.nojekyll'), '');

  const files = ['index.html', 'resume.json', 'override.css', '.nojekyll'];
  if (domain) {
    await writeFile(join(distDir, 'CNAME'), `${domain}\n`);
    files.push('CNAME');
  }

  return { html, themeName, domain, distDir, files };
}

async function main() {
  const log = (...args) => console.log(...args);
  const config = resolveConfig();

  const { text, source } = await loadResume(config, { log });
  const resume = parseResume(text);

  const themeName = resolveThemeName(config, resume);
  const { name: resolvedTheme, theme } = await loadTheme(themeName, { log });
  log(`Rendering with theme: ${resolvedTheme}`);

  const manifest = await buildSite({
    resume,
    theme,
    themeName: resolvedTheme,
    domain: config.domain,
  });

  const name = resume?.basics?.name || 'resume';
  log('');
  log(`Built ${name}'s resume from ${source}`);
  log(`Output: dist/index.html (theme: ${resolvedTheme})`);
  if (manifest.domain) log(`Domain: ${manifest.domain}`);
}

// Only run when executed directly (`node scripts/build.mjs`), not when imported
// by the test suite.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`Build failed: ${err.message}`);
    process.exit(1);
  });
}
