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


def run_steps() -> tuple[dict[str, str], dict[str, str]]:
    doc = yaml.safe_load(WF.read_text(encoding="utf-8"))
    jobs = doc.get("jobs") or {}
    out: dict[str, str] = {}
    envs: dict[str, str] = {}
    for job in jobs.values():
        for step in job.get("steps") or []:
            if not isinstance(step, dict):
                continue
            name = step.get("name", "")
            if "run" in step:
                out[name] = step["run"]
            if "env" in step:
                envs[name] = yaml.safe_dump(step["env"], default_flow_style=True)
    return out, envs


def main() -> int:
    print(f"checking {WF}")
    steps, envs = run_steps()
    check(bool(steps), "workflow parses and exposes run: steps")
    if not steps:
        print("\nworkflow has no run steps; cannot continue")
        return 1

    copy_step = steps.get(COPY_STEP, "")
    push_step = steps.get(PUSH_STEP, "")
    # Some assertions must consider the step's env: block too -- secrets and the
    # pinned host key are declared there, not inside the run script.
    push_env = envs.get(PUSH_STEP, "")
    push_all = push_step + "\n" + push_env
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
    check("::error title=No deploy credential::" in push_step,
          "missing credential yields a titled, actionable error")
    check("contents: write" in push_all, "error states the required scope")

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

    print("\n#6 credential handling")
    # Two credential shapes are supported: an SSH deploy key (preferred) and a
    # token (fallback). Both are external because the workflow GITHUB_TOKEN is
    # scoped to github-social and cannot write to the Pages repo.
    check("PAGES_SSH_KEY" in push_all, "reads a GH_PAGES_SSH_KEY secret")
    check("PAGES_TOKEN" in push_all, "keeps GH_PAGES_TOKEN as a fallback")
    check("GH_TOKEN" not in push_step, "GH_TOKEN not relied on for git auth")
    ssh_at = push_step.find("PAGES_SSH_KEY:-")
    tok_at = push_step.find("PAGES_TOKEN:-")
    check(ssh_at != -1 and tok_at != -1 and ssh_at < tok_at,
          "SSH deploy key is preferred over the token")
    check("::error title=No deploy credential::" in push_step,
          "missing-credential error names both options")
    check("docs/DEPLOYMENT.md" in push_step,
          "missing-credential error points at the setup doc")

    print("\n#7 SSH transport hygiene")
    # Assert on the *private key* specifically. A bare `"chmod 600" in step`
    # would still pass if only the known_hosts file were chmod'd -- the key is
    # the thing that must never be group/world readable.
    check(re.search(r'chmod 600 "?\$\{?ssh_key', push_step) is not None,
          "private key specifically is chmod 600")
    check("mktemp" in push_step, "key written to a mktemp path, not a fixed one")
    check("StrictHostKeyChecking=yes" in push_step,
          "host key verification is strict (no blind accept)")
    check("ssh-keyscan" not in push_step,
          "host key is pinned, not trusted on first use")
    check("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqq" in push_all
          and "GITHUB_HOST_KEY" in push_all,
          "GitHub's published ed25519 host key is pinned (not keyscanned)")
    check("IdentitiesOnly=yes" in push_step,
          "only the deploy key is offered, not every key on the agent")
    check("BatchMode=yes" in push_step, "ssh cannot block on an interactive prompt")
    check("trap cleanup EXIT" in push_step,
          "key material is removed even if a step fails")
    check(re.search(r"rm -f \"?\$ssh_key", push_step) is not None,
          "cleanup actually deletes the private key")

    print("\n#8 shared target repo must be rebased before pushing")
    # frenzypenguin-media.github.io is written by other jobs ("FPM heartbeat",
    # "FPM FB feed sync") plus manual commits. Pushing straight from the checkout
    # races them and fails non-fast-forward, so the workflow must rebase first.
    check("git pull --rebase" in push_step,
          "rebases onto the target repo's current main before pushing")
    pull = push_step.index("git pull --rebase") if "git pull --rebase" in push_step else -1
    psh = push_step.index("git push") if "git push" in push_step else len(push_step)
    check(pull != -1 and pull < psh, "rebase happens before the push")
    check("remote=" in push_step, "remote URL is bound once to a variable")

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