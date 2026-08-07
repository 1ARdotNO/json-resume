// Data + rendering tests for the resume fixture. These guard both the schema
// validity of the resume and that the rendered site contains the expected
// content, so a bad resume edit or a breaking theme update fails CI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { render, validate } from 'resumed';

import { loadTheme, resolveThemeName, parseResume } from '../scripts/build.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, 'fixtures', 'resume.json');

async function loadFixture() {
  return parseResume(await readFile(fixturePath, 'utf8'));
}

test('the resume fixture is valid against the JSON Resume schema', async () => {
  // resumed.validate reads the file and rejects on schema violations.
  await assert.doesNotReject(validate(fixturePath));
});

test('the fixture parses and exposes the expected top-level sections', async () => {
  const resume = await loadFixture();
  assert.equal(resume.basics.name, 'Einar Stenberg');
  assert.ok(Array.isArray(resume.work) && resume.work.length > 0);
  assert.ok(Array.isArray(resume.projects) && resume.projects.length > 0);
});

test('work entries are ordered most-recent first by startDate', async () => {
  const resume = await loadFixture();
  const dates = resume.work.map((w) => w.startDate);
  const sorted = [...dates].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  assert.deepEqual(dates, sorted, 'work[] should be sorted by startDate descending');
});

test('the current DevSecOps role is present and listed first', async () => {
  const resume = await loadFixture();
  assert.equal(resume.work[0].position, 'DevSecOps Engineer');
  assert.equal(resume.work[0].startDate, '2025-09-01');
});

test('the BCMS (ISO 22301) implementation project is present', async () => {
  const resume = await loadFixture();
  const names = resume.projects.map((p) => p.name);
  assert.ok(
    names.some((n) => /ISO ?22301/i.test(n)),
    `expected an ISO 22301 project, found: ${names.join(', ')}`,
  );
});

test('rendering the fixture produces HTML containing key resume content', async () => {
  const resume = await loadFixture();
  const { theme } = await loadTheme(resolveThemeName({}, resume));
  const html = await render(resume, theme);
  assert.match(html, /Einar Stenberg/);
  assert.match(html, /DevSecOps Engineer/);
  assert.match(html, /Business Continuity/);
});
