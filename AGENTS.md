# Rules for this repo
- Read only the SPEC.md sections named in the prompt. Don't explore beyond them.
- Verify only with ./scripts/check.sh. Never edit flake.nix, tool settings in pyproject.toml, dependencies, tsconfig*.json, vite.config.ts, core/settings.py or scripts/check.sh.
- Commit after each step. If the same check fails twice, stop and report.
- Never create CSS files. Style with Tailwind classes only; the only stylesheet is src/index.css.
- No new dependencies without asking.
- Work only on the current branch. Never push, merge, rebase, or switch branches.
