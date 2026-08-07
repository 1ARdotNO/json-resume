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

import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { render } from 'resumed';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const distDir = join(root, 'dist');

// Default source: the profile gist's raw URL. Without a commit SHA this always
// serves the latest revision, so the daily rebuild picks up gist edits, and it
// needs no GitHub API token.
const DEFAULT_RESUME_URL =
  'https://gist.githubusercontent.com/1ARdotNO/7224de9f9b8e9e9691520193b1782594/raw/resume.json';

const config = {
  user: process.env.RESUME_USER || '',
  gist: process.env.RESUME_GIST || '',
  url: process.env.RESUME_URL || '',
  theme: process.env.RESUME_THEME || '',
  domain: process.env.RESUME_DOMAIN ?? 'resume.1ar.no',
  token: process.env.GITHUB_TOKEN || '',
};

const ghHeaders = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'json-resume-registry',
  ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
};

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function fetchText(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  return res.text();
}

// Returns the raw resume.json text plus a human-readable description of where
// it came from.
async function loadResume() {
  // API paths are opt-in via RESUME_GIST / RESUME_USER. Otherwise fetch a raw
  // URL (explicit RESUME_URL, else the default gist raw URL) — no token needed.
  if (!config.gist && !config.user) {
    const url = config.url || DEFAULT_RESUME_URL;
    console.log(`Fetching resume from raw URL: ${url}`);
    return { text: await fetchText(url), source: url };
  }

  let gist;
  if (config.gist) {
    console.log(`Fetching gist ${config.gist} via the GitHub API`);
    gist = await fetchJson(`https://api.github.com/gists/${config.gist}`, ghHeaders);
  } else {
    console.log(`Searching gists of @${config.user} for a resume.json`);
    const gists = await fetchJson(
      `https://api.github.com/users/${config.user}/gists?per_page=100`,
      ghHeaders,
    );
    gist = gists.find((g) => g.files && g.files['resume.json']);
    if (!gist) {
      throw new Error(`No public gist named resume.json found for @${config.user}`);
    }
    // Re-fetch the full gist so file contents are populated.
    gist = await fetchJson(`https://api.github.com/gists/${gist.id}`, ghHeaders);
  }

  const file = gist.files && gist.files['resume.json'];
  if (!file) {
    throw new Error(`Gist ${gist.id} does not contain a resume.json file`);
  }

  // Gist file contents are inlined unless truncated, in which case fetch raw.
  const text = file.truncated ? await fetchText(file.raw_url, ghHeaders) : file.content;
  return {
    text,
    source: gist.html_url || `https://gist.github.com/${config.user}/${gist.id}`,
  };
}

async function loadTheme(name) {
  const pkg = `jsonresume-theme-${name}`;
  try {
    const mod = await import(pkg);
    return { name, theme: mod.default ?? mod };
  } catch (err) {
    if (name !== 'stackoverflow') {
      console.warn(
        `Theme "${pkg}" is not installed (${err.message}); falling back to stackoverflow.`,
      );
      const mod = await import('jsonresume-theme-stackoverflow');
      return { name: 'stackoverflow', theme: mod.default ?? mod };
    }
    throw err;
  }
}

async function main() {
  const { text, source } = await loadResume();

  let resume;
  try {
    resume = JSON.parse(text);
  } catch (err) {
    throw new Error(`resume.json is not valid JSON: ${err.message}`);
  }

  const themeName = config.theme || resume?.meta?.theme || 'stackoverflow';
  const { name: resolvedTheme, theme } = await loadTheme(themeName);
  console.log(`Rendering with theme: ${resolvedTheme}`);

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

  if (config.domain) {
    await writeFile(join(distDir, 'CNAME'), `${config.domain}\n`);
  }

  const name = resume?.basics?.name || 'resume';
  console.log('');
  console.log(`Built ${name}'s resume from ${source}`);
  console.log(`Output: dist/index.html (theme: ${resolvedTheme})`);
  if (config.domain) console.log(`Domain: ${config.domain}`);
}

main().catch((err) => {
  console.error(`Build failed: ${err.message}`);
  process.exit(1);
});
