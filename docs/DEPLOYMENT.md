# Deployment

How `github-social` gets published, and what you must configure once.

## What deploys where

| Artifact | Source | Destination |
|---|---|---|
| PWA | `vite build` → `dist-pwa/` | `frenzypenguin-media.github.io/github-social/` |
| Embed bundles | `vite build --config vite.embed.config.ts` → `dist-embed/` | `…github.io/embed.js`, `…/embed.iife.js`, and copies under `github-social/` |
| Metrics SVGs | `journey-sync.yml` → `metrics/*.svg` | same Pages repo, committed hourly |

Two workflows write to the Pages repo:

- `.github/workflows/pwa-deploy.yml` — runs on pushes touching `src/**`,
  `package.json`, `vite.config.ts`, or the workflow itself.
- `.github/workflows/journey-sync.yml` — hourly; posts a snapshot comment to the
  rolling issue and commits `metrics/*.svg`.

## Required: a deploy credential

**The deploy does not work until one of these is configured.**

Artifacts are published to `frenzypenguin-media/frenzypenguin-media.github.io`,
which is a **different repository** from where the workflow runs. A GitHub
Actions `GITHUB_TOKEN` is always scoped to the repository containing the
workflow, so it cannot write to the Pages repo. This is architectural, not a
configuration mistake — cross-repository writes always require an external
credential.

The workflow accepts either form and prefers the first. With neither, it fails
immediately with an explicit error naming both options.

### Option A (preferred): SSH deploy key

Repo-scoped, revocable with one API call, and not tied to a user account.

1. **Enable deploy keys on the Pages repo.** This is a repository setting with
   **no API** — it must be toggled in the UI:
   <https://github.com/frenzypenguin-media/frenzypenguin-media.github.io/settings/keys>
   (the "Allow deploy keys" checkbox). Until this is on, `POST /repos/{owner}/{repo}/keys`
   returns `422 "Deploy keys are disabled for this repository"`.
2. Generate a key pair and add the **public** half as a deploy key on the Pages
   repo, leaving **read-only** unchecked:

   ```bash
   ssh-keygen -t ed25519 -C "gh-pages-deploy" -f gh_pages_deploy
   gh api -X POST repos/frenzypenguin-media/frenzypenguin-media.github.io/keys \
     -f title="github-social PWA deploy" -f key=@gh_pages_deploy.pub -F read_only=false
   ```

3. Store the **private** half as a repository secret named `GH_PAGES_SSH_KEY`
   on **`github-social`**:
   **Settings → Secrets and variables → Actions → New repository secret**.
   Pass the whole private key including the `-----BEGIN OPENSSH PRIVATE KEY-----`
   header and footer.

The workflow writes the key to a `mktemp` file with mode `600`, verifies the
host against GitHub's published ed25519 host key with
`StrictHostKeyChecking=yes`, and deletes it via an `EXIT` trap so key material
never survives the job.

### Option B: fine-grained personal access token

1. GitHub → **Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate new token**
2. **Resource owner:** `frenzypenguin-media`
3. **Repository access:** Only select repositories →
   `frenzypenguin-media.github.io` (the Pages repo, *not* `github-social`)
4. **Permissions → Repository permissions → Contents:** `Read and write`
5. Generate, then copy the token — it is shown only once
6. Store it on **`github-social`** (the source repo, not the Pages repo):
   **Settings → Secrets and variables → Actions → New repository secret**,
   name `GH_PAGES_TOKEN`

Scope it to that one repository and set an expiry. A GitHub App installation
token works too and avoids a user-scoped credential.

Until a credential exists, `PWA Deploy` fails at the push step with
`::error title=No deploy credential::` naming what is required.

## Two constraints that are easy to regress

Both are enforced by `scripts/check_deploy_workflow.py`, which runs in CI.

### Do not commit a root `.nojekyll`

The Pages repo is a **Jekyll site** — `_config.yml` declares `jekyll-feed`,
`jekyll-seo-tag` and `jekyll-sitemap`, a `tools` collection published to
`/tools/:name/`, and `layout: "tool"` defaults. `.nojekyll` is only honoured at
the publishing root, so adding one there switches Jekyll off for the **entire
site**, dropping every `/tools/*/` page plus `feed.xml` and `sitemap.xml`.

The workflow previously created one, justified by a comment claiming workbox
emits to `_nuxt/`. That is stale: no Vite config sets `assetsDir` to `_nuxt`, and
`vite build` output contains no underscore-prefixed paths, so nothing needs
protecting. The existing `github-social/.nojekyll` in the Pages repo is inert.

### Rebase before pushing

The Pages repo `main` is shared and written by several jobs (`FPM heartbeat`,
`FPM FB feed sync`, plus manual commits). `git push HEAD:main` from a fresh
checkout is only a fast-forward from that snapshot, so it fails non-fast-forward
whenever another job commits in between. The workflow therefore runs
`git pull --rebase` before pushing. A genuine conflict should still fail loudly
rather than silently discarding another job's work.

## Local verification

```bash
npm ci
npm run build:pwa                      # or: PWA_BASE=/github-social/ npx vite build
npx vite build --config vite.ext.config.ts
npx vite build --config vite.embed.config.ts
python scripts/check_deploy_workflow.py # deploy-workflow invariants
```

Note that `npm run build:pwa` uses POSIX `VAR=value cmd` syntax, which `cmd.exe`
cannot parse; set the variable in the shell instead when running on Windows.

`PWA Deploy` can only be fully exercised on a runner — it needs a credential for
a repository this workflow's token cannot reach.