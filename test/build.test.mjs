// Unit tests for the build pipeline. Network is injected, so these never touch
// the real network; buildSite is exercised against the real stackoverflow
// theme in a temporary directory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveConfig,
  resolveThemeName,
  parseResume,
  loadResume,
  loadTheme,
  buildSite,
  injectDownloadLink,
  DEFAULT_RESUME_URL,
  DEFAULT_DOMAIN,
  DEFAULT_THEME,
} from '../scripts/build.mjs';

// A minimal fake Response object.
function fakeResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    async json() {
      return typeof body === 'string' ? JSON.parse(body) : body;
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

// Build a fetch stub that maps URL substrings to responses and records calls.
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    for (const [needle, response] of routes) {
      if (url.includes(needle)) return response;
    }
    return fakeResponse('Not Found', { ok: false, status: 404 });
  };
  impl.calls = calls;
  return impl;
}

test('resolveConfig applies defaults for an empty environment', () => {
  const c = resolveConfig({});
  assert.equal(c.user, '');
  assert.equal(c.gist, '');
  assert.equal(c.url, '');
  assert.equal(c.theme, '');
  assert.equal(c.domain, DEFAULT_DOMAIN);
  assert.equal(c.pdf, true); // PDF generation is on by default
  assert.equal(c.token, '');
});

test('resolveConfig disables PDF when RESUME_PDF is a falsey string', () => {
  assert.equal(resolveConfig({ RESUME_PDF: '0' }).pdf, false);
  assert.equal(resolveConfig({ RESUME_PDF: 'false' }).pdf, false);
  assert.equal(resolveConfig({ RESUME_PDF: 'NO' }).pdf, false);
  assert.equal(resolveConfig({ RESUME_PDF: '1' }).pdf, true);
});

test('injectDownloadLink adds a single download button before </body>', () => {
  const out = injectDownloadLink('<html><body><h1>Hi</h1></body></html>');
  assert.match(out, /class="pdf-download"/);
  assert.match(out, /href="\.\/resume\.pdf"/);
  assert.match(out, /download/);
  // Anchor sits inside the body, before the closing tag.
  assert.ok(out.indexOf('pdf-download') < out.indexOf('</body>'));
  assert.equal(out.match(/pdf-download/g).length, 1);
});

test('injectDownloadLink appends when there is no </body>', () => {
  const out = injectDownloadLink('<h1>no body tag</h1>', './other.pdf');
  assert.match(out, /href="\.\/other\.pdf"/);
});

test('resolveConfig reads overrides and treats empty domain as opt-out', () => {
  const c = resolveConfig({
    RESUME_USER: 'octocat',
    RESUME_GIST: 'abc',
    RESUME_URL: 'https://example.com/resume.json',
    RESUME_THEME: 'elegant',
    RESUME_DOMAIN: '',
    GITHUB_TOKEN: 'tok',
  });
  assert.equal(c.user, 'octocat');
  assert.equal(c.gist, 'abc');
  assert.equal(c.url, 'https://example.com/resume.json');
  assert.equal(c.theme, 'elegant');
  assert.equal(c.domain, ''); // explicit empty string is preserved (skip CNAME)
  assert.equal(c.token, 'tok');
});

test('resolveThemeName prefers override, then resume.meta.theme, then default', () => {
  assert.equal(resolveThemeName({ theme: 'elegant' }, { meta: { theme: 'kendall' } }), 'elegant');
  assert.equal(resolveThemeName({ theme: '' }, { meta: { theme: 'kendall' } }), 'kendall');
  assert.equal(resolveThemeName({ theme: '' }, {}), DEFAULT_THEME);
  assert.equal(resolveThemeName({ theme: '' }, undefined), DEFAULT_THEME);
});

test('parseResume returns an object and throws a friendly error on bad JSON', () => {
  assert.deepEqual(parseResume('{"a":1}'), { a: 1 });
  assert.throws(() => parseResume('{nope}'), /resume\.json is not valid JSON/);
});

test('loadResume uses the default raw URL when no gist/user is configured', async () => {
  const fetchImpl = fakeFetch([['gist.githubusercontent.com', fakeResponse('{"basics":{}}')]]);
  const { text, source } = await loadResume(resolveConfig({}), { fetchImpl });
  assert.equal(source, DEFAULT_RESUME_URL);
  assert.equal(text, '{"basics":{}}');
  assert.equal(fetchImpl.calls[0], DEFAULT_RESUME_URL);
});

test('loadResume honours an explicit RESUME_URL', async () => {
  const url = 'https://example.com/r.json';
  const fetchImpl = fakeFetch([['example.com', fakeResponse('{"ok":true}')]]);
  const { source, text } = await loadResume(resolveConfig({ RESUME_URL: url }), { fetchImpl });
  assert.equal(source, url);
  assert.equal(text, '{"ok":true}');
});

test('loadResume fetches a pinned gist by id via the API', async () => {
  const gist = {
    id: 'deadbeef',
    html_url: 'https://gist.github.com/x/deadbeef',
    files: { 'resume.json': { content: '{"basics":{"name":"Ada"}}' } },
  };
  const fetchImpl = fakeFetch([['api.github.com/gists/deadbeef', fakeResponse(gist)]]);
  const { text, source } = await loadResume(resolveConfig({ RESUME_GIST: 'deadbeef' }), {
    fetchImpl,
  });
  assert.match(text, /Ada/);
  assert.equal(source, 'https://gist.github.com/x/deadbeef');
});

test('loadResume follows raw_url when the gist file is truncated', async () => {
  const gist = {
    id: 'big',
    files: { 'resume.json': { truncated: true, raw_url: 'https://raw/big/resume.json' } },
  };
  const fetchImpl = fakeFetch([
    ['api.github.com/gists/big', fakeResponse(gist)],
    ['raw/big/resume.json', fakeResponse('{"basics":{"name":"Grace"}}')],
  ]);
  const { text } = await loadResume(resolveConfig({ RESUME_GIST: 'big' }), { fetchImpl });
  assert.match(text, /Grace/);
});

test('loadResume searches a user\'s gists and re-fetches the match', async () => {
  const list = [
    { id: 'nope', files: { 'other.json': {} } },
    { id: 'match', files: { 'resume.json': {} } },
  ];
  const full = { id: 'match', files: { 'resume.json': { content: '{"basics":{"name":"Linus"}}' } } };
  const fetchImpl = fakeFetch([
    ['users/octocat/gists', fakeResponse(list)],
    ['api.github.com/gists/match', fakeResponse(full)],
  ]);
  const { text } = await loadResume(resolveConfig({ RESUME_USER: 'octocat' }), { fetchImpl });
  assert.match(text, /Linus/);
});

test('loadResume throws when a user has no resume.json gist', async () => {
  const fetchImpl = fakeFetch([['users/octocat/gists', fakeResponse([{ id: 'x', files: {} }])]]);
  await assert.rejects(
    loadResume(resolveConfig({ RESUME_USER: 'octocat' }), { fetchImpl }),
    /No public gist named resume\.json/,
  );
});

test('loadResume surfaces non-OK HTTP responses', async () => {
  const fetchImpl = fakeFetch([
    ['gist.githubusercontent.com', fakeResponse('nope', { ok: false, status: 500 })],
  ]);
  await assert.rejects(loadResume(resolveConfig({}), { fetchImpl }), /-> 500/);
});

test('loadTheme loads the requested theme', async () => {
  const { name, theme } = await loadTheme('stackoverflow');
  assert.equal(name, 'stackoverflow');
  assert.equal(typeof theme.render, 'function');
});

test('loadTheme falls back to the default when a theme is missing', async () => {
  const { name, theme } = await loadTheme('does-not-exist-xyz');
  assert.equal(name, DEFAULT_THEME);
  assert.equal(typeof theme.render, 'function');
});

test('buildSite writes a complete site into the dist directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jrr-'));
  try {
    const { theme } = await loadTheme('stackoverflow');
    const resume = { basics: { name: 'Test Person' }, work: [], meta: { theme: 'stackoverflow' } };
    const manifest = await buildSite({
      resume,
      theme,
      themeName: 'stackoverflow',
      distDir: dir,
      root: dir, // no public/override.css here -> default override is written
      domain: 'resume.example.com',
      pdf: false, // don't launch a browser in unit tests
    });

    // index.html contains the rendered name.
    const html = await readFile(join(dir, 'index.html'), 'utf8');
    assert.match(html, /Test Person/);
    // With PDF disabled, no download button and no resume.pdf.
    assert.doesNotMatch(html, /pdf-download/);
    assert.equal(manifest.pdf, false);
    assert.ok(!existsSync(join(dir, 'resume.pdf')));

    // resume.json is valid and round-trips.
    const raw = await readFile(join(dir, 'resume.json'), 'utf8');
    assert.deepEqual(JSON.parse(raw), resume);

    // Support files exist.
    assert.ok(existsSync(join(dir, '.nojekyll')));
    assert.ok(existsSync(join(dir, 'override.css')));

    // CNAME reflects the domain.
    const cname = await readFile(join(dir, 'CNAME'), 'utf8');
    assert.equal(cname.trim(), 'resume.example.com');

    assert.deepEqual(new Set(manifest.files), new Set([
      'index.html',
      'resume.json',
      'override.css',
      '.nojekyll',
      'CNAME',
    ]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildSite omits CNAME when the domain is empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jrr-'));
  try {
    const { theme } = await loadTheme('stackoverflow');
    const manifest = await buildSite({
      resume: { basics: { name: 'No Domain' }, work: [] },
      theme,
      themeName: 'stackoverflow',
      distDir: dir,
      root: dir,
      domain: '',
      pdf: false,
    });
    assert.ok(!existsSync(join(dir, 'CNAME')));
    assert.ok(!manifest.files.includes('CNAME'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
