#!/usr/bin/env python3
"""Static checks for .github/workflows/pwa-deploy.yml.

Each check pins a defect that was present and silently shipped:

1. `git push` ran bare while auth was passed as `GH_TOKEN`. GH_TOKEN is read
   only by the `gh` CLI, so git had no credentials and every deploy died with
   "could not read Username for 'https://github.com'". The push must carry an
   explicit credential, and must fail fast with actionable guidance when the
   secret is absent rather than with git's opaque error.
2. The site-root embed bundles were copied into the checkout but never passed to
   `git add`, so they never reached the deployed site.
3. embed.js (ES module) and embed.iife.js (IIFE) were both copied to
   github-social/embed.js, so the IIFE was overwritten by the ES module and any
   consumer loading that path with <script src> got "Unexpected token 'export'".
4. A root .nojekyll was created and committed. The target repo is a Jekyll site
   (jekyll-feed/seo-tag/sitemap plugins, a `tools` collection published to
   /tools/:name/, `layout: "tool"` defaults). .nojekyll only takes effect at the
   publishing root, so it would have switched Jekyll off for the entire site and
   dropped every /tools/*/ page, feed.xml and sitemap.xml. The justification
   comment ("workbox outputs to _nuxt/") was stale: `vite build` output contains
   no underscore-prefixed paths, so nothing needed protecting.

Run:  python scripts/check_deploy_workflow.py
Exit: 0 all checks passed, 1 otherwise.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover
    print("PyYAML is required: pip install pyyaml", file=sys.stderr)
    raise SystemExit(2)

WF = Path(__file__).resolve().parent.parent / ".github" / "workflows" / "pwa-deploy.yml"
COPY_STEP = "Copy PWA build to site"
PUSH_STEP = "Commit and push to GitHub Pages"

failures: list[str] = []


def check(cond: bool, label: str, extra: str = "") -> None:
    if cond:
        print(f"  OK   {label}")
    else:
        print(f"  FAIL {label} {extra}".rstrip())
        failures.append(label)


def run_steps() -> dict[str, str]:
    doc = yaml.safe_load(WF.read_text(encoding="utf-8"))
    jobs = doc.get("jobs") or {}
    out: dict[str, str] = {}
    for job in jobs.values():
        for step in job.get("steps") or []:
            if isinstance(step, dict) and "run" in step:
                out[step.get("name", "")] = step["run"]
    return out


def main() -> int:
    print(f"checking {WF}")
    steps = run_steps()
    check(bool(steps), "workflow parses and exposes run: steps")
    if not steps:
        print("\nworkflow has no run steps; cannot continue")
        return 1

    copy_step = steps.get(COPY_STEP, "")
    push_step = steps.get(PUSH_STEP, "")
    check(bool(copy_step), f"step {COPY_STEP!r} present")
    check(bool(push_step), f"step {PUSH_STEP!r} present")
    if not (copy_step and push_step):
        return 1

    print("\n#1 push must authenticate explicitly, not via GH_TOKEN")
    bare = re.findall(r"^\s*git push\s*$", push_step, re.M)
    check(not bare, "no bare `git push`", str(bare))
    check("GH_TOKEN" not in push_step, "GH_TOKEN not relied on for git auth")
    check("PAGES_TOKEN" in push_step, "token threaded via PAGES_TOKEN")
    check("x-access-token:" in push_step, "push URL carries x-access-token credential")
    check("set -euo pipefail" in push_step, "push step is fail-fast")
    check("::error title=Missing GH_PAGES_TOKEN::" in push_step,
          "missing secret yields a titled, actionable error")
    check("contents: write" in push_step, "error states the required scope")

    print("\n#2 site-root bundles must be staged")
    add = re.search(r"git add ([^\n]+)", push_step)
    check(add is not None, "git add present")
    if add:
        args = add.group(1)
        for want in ("embed.js", "embed.iife.js"):
            check(want in args, f"stages {want}", args)
        check(".nojekyll" not in args,
              "does not stage a root .nojekyll (would disable Jekyll site-wide)",
              args)

    print("\n#4 must not create a root .nojekyll")
    # `touch site-target/.nojekyll` would land at the publishing root and switch
    # Jekyll off for the whole shared site. A reference inside a comment is fine;
    # only actual shell is checked.
    shell_only = "\n".join(
        l for l in copy_step.splitlines() if not l.lstrip().startswith("#")
    )
    check(".nojekyll" not in shell_only,
          "no .nojekyll created outside comments")
    check("touch site-target/.nojekyll" not in copy_step,
          "site-root .nojekyll touch removed")

    print("\n#5 shared target repo must be rebased before pushing")
    # frenzypenguin-media.github.io is written by other jobs ("FPM heartbeat",
    # "FPM FB feed sync") plus manual commits. Pushing straight from the checkout
    # races them and fails non-fast-forward, so the workflow must rebase first.
    check("git pull --rebase" in push_step,
          "rebases onto the target repo's current main before pushing")
    pull = push_step.index("git pull --rebase") if "git pull --rebase" in push_step else -1
    psh = push_step.index("git push") if "git push" in push_step else len(push_step)
    check(pull != -1 and pull < psh, "rebase happens before the push")
    check("REMOTE=" in push_step, "remote URL is bound once to a variable")

    print("\n#3 no destination may be written twice")
    dests: dict[str, list[str]] = {}
    for line in copy_step.splitlines():
        parts = line.strip().split()
        if len(parts) >= 3 and parts[0] == "cp":
            dests.setdefault(parts[2], []).append(parts[1])
    dupes = {d: s for d, s in dests.items() if len(s) > 1}
    check(not dupes, "no destination overwritten", str(dupes))
    for want in ("site-target/embed.js", "site-target/embed.iife.js",
                 "site-target/github-social/embed.js",
                 "site-target/github-social/embed.iife.js"):
        check(want in dests, f"copy produces {want}")

    print()
    if failures:
        print(f"{len(failures)} check(s) FAILED")
        return 1
    print("all PWA Deploy workflow checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())