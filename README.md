# json-resume-registry

A small, self-hosted replacement for [registry.jsonresume.org](https://registry.jsonresume.org).
It fetches a [JSON Resume](https://jsonresume.org/) from a GitHub gist, renders
it with a JSON Resume theme, and publishes the result as a static site on
GitHub Pages.

By default it targets the profile gist
[`1ARdotNO/7224de9f9b8e9e9691520193b1782594`](https://gist.github.com/1ARdotNO/7224de9f9b8e9e9691520193b1782594)
and deploys to **https://resume.1ar.no**.

## How it works

1. `scripts/build.mjs` fetches `resume.json` (from the gist's raw URL by
   default — always the latest revision, no API token required).
2. It renders the resume with [`resumed`](https://github.com/rbardini/resumed)
   using the theme named in `resume.meta.theme` (currently
   [`stackoverflow`](https://www.npmjs.com/package/jsonresume-theme-stackoverflow)).
3. The output is written to `dist/`:
   - `index.html` — the rendered resume
   - `resume.json` — the raw resume, served as a registry-style endpoint
   - `CNAME`, `.nojekyll`, `override.css` — GitHub Pages support files
4. The `Deploy resume to GitHub Pages` workflow builds and publishes `dist/` on
   every push to `main`, once a day (to pick up gist edits), and on demand.

## Local development

```bash
npm install
npm run build        # writes ./dist
npm run serve        # preview ./dist at http://localhost:3000
# or both at once:
npm run dev
```

## Configuration

All settings are environment variables (in Actions, set them as **repository
variables** under Settings → Secrets and variables → Actions → Variables):

| Variable        | Default                              | Purpose |
| --------------- | ------------------------------------ | ------- |
| `RESUME_URL`    | the profile gist's raw `resume.json` | Raw URL to fetch. The default source; needs no token. |
| `RESUME_GIST`   | _(unset)_                            | Pin a gist id and fetch it via the GitHub API instead. |
| `RESUME_USER`   | _(unset)_                            | GitHub username whose gists are searched for a `resume.json` (registry-style). |
| `RESUME_THEME`  | `resume.meta.theme` → `stackoverflow`| Theme name without the `jsonresume-theme-` prefix. |
| `RESUME_DOMAIN` | `resume.1ar.no`                      | Custom domain written to `dist/CNAME`. Empty string skips it. |

To use a different theme, add its npm package to `dependencies` (e.g.
`jsonresume-theme-elegant`) and set `RESUME_THEME` accordingly.

## First-time GitHub Pages setup

1. **Enable Pages with GitHub Actions**: repo → Settings → Pages → *Build and
   deployment* → **Source: GitHub Actions**.
2. **Merge to `main`** (or run the workflow manually from the Actions tab). The
   workflow builds and deploys automatically.
3. **Custom domain DNS** for `resume.1ar.no` — at your DNS provider add a
   `CNAME` record:

   | Type  | Name     | Value              |
   | ----- | -------- | ------------------ |
   | CNAME | `resume` | `1ardotno.github.io` |

   (Replace `1ardotno` with the repo owner if different.) The `CNAME` file in
   the build already tells Pages to serve `resume.1ar.no`; once DNS resolves,
   enable **Enforce HTTPS** in the Pages settings.

## Customizing the look

Edit `public/override.css`. It's copied to `dist/override.css` and loaded after
the theme's own stylesheet, so its rules win.
