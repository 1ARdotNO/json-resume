# Security Policy

## Reporting a vulnerability

Please report security issues **privately** through GitHub's vulnerability
reporting feature rather than opening a public issue.

**Reporting method:** use GitHub's
**[Report a vulnerability](https://github.com/1ARdotNO/json-resume/security/advisories/new)**
(Security → Advisories → Report a vulnerability).

**Response timeline:** reports are acknowledged within a few days, after which
timelines for a fix and coordinated disclosure are agreed with the reporter.

**Required information:** include the affected commit or deployed URL, a clear
description, steps to reproduce, and the potential impact. Proof-of-concept
demonstrations are welcome, but only test against systems and data you own.

## Supported versions

This project has no tagged releases; only the latest `main` branch is
supported. The published site at <https://resume.1ar.no> is rebuilt from
`main` on every push (and daily), so fixes take effect as soon as they merge.

## Scope & handling notes

This repository is a static site generator with **no server-side component and
no authentication or secrets**. It fetches a **public** GitHub gist, renders it
with a JSON Resume theme, and publishes the result to GitHub Pages. A few things
worth knowing:

1. **Public data by design.** The resume content is intended to be public. The
   build pulls `resume.json` from a public gist and republishes it (including at
   `/resume.json`); it never handles private data or credentials. The optional
   `GITHUB_TOKEN` used in CI is only for GitHub API rate limits and is never
   written into the built site.

2. **Rendered output.** The site is static HTML produced from the resume by a
   third-party theme. The theme references a CDN stylesheet
   (Font Awesome) at view time; no analytics or tracking is added by this
   project.

3. **Dependency monitoring.** Dependencies and GitHub Actions are tracked by
   Renovate, with GitHub Action versions pinned by commit digest. Every update —
   automerged or not — must pass the CI test suite (`npm test` plus a full site
   build) before it can merge.

## What is not a vulnerability

The following are out of scope:

- Findings that require an already-compromised environment (e.g. a leaked
  GitHub account or a compromised CI runner).
- Issues in upstream dependencies, GitHub Pages, or the CDN that serves theme
  assets, rather than in this repository's own code or configuration.
- The resume data itself being publicly readable — that is intentional.
