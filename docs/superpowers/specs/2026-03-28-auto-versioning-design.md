# Auto-Versioning with Changelog Display

## Problem

Solo developer with no way to tell what version is deployed in production. Version bumps and changelog updates are manual and easily forgotten.

## Solution

Automatic semver bumping via conventional commit prefixes, with version displayed in the frontend footer and a clickable changelog modal generated from git history.

## Architecture

### Version Bump Flow

```
Developer commits with "feat: ..." or "fix: ..."
  → post-commit hook runs scripts/bump-version.sh
    → Reads the just-completed commit message via git log -1 --format=%s
    → If prefix is feat: → minor bump; fix: → patch bump
    → If prefix is anything else (docs:, chore:, refactor:, etc.) → skip, no bump
    → Reads current version from web/static/version.json
    → Bumps version, writes web/static/version.json
    → Generates web/static/changelog.json from git log + tags
    → Creates follow-up commit: git commit --no-verify -m "chore(version): vX.Y.Z"
    → Creates lightweight git tag: git tag vX.Y.Z
```

This produces two commits per qualifying change: the developer's commit, then an automatic version bump commit. Non-qualifying commits (docs, chore, etc.) produce a single commit with no bump.

### Files

| File | Purpose |
|------|---------|
| `web/static/version.json` | `{"version": "0.7.1", "commit": "abc1234"}` — single source of truth |
| `web/static/changelog.json` | `[{version, date, changes: [{type, message}]}]` |
| `scripts/bump-version.sh` | Bump logic + changelog generation |
| `.pre-commit-config.yaml` | New `post-commit` stage hook entry |
| `web/static/version.js` | Shared frontend: version badge + changelog modal |

### version.json Format

```json
{"version": "0.7.1", "commit": "cc1d283"}
```

The `commit` field is the short SHA of the developer's commit (not the version bump commit). This helps verify exact deployments.

### changelog.json Format

```json
[
  {
    "version": "0.7.1",
    "date": "2026-03-28",
    "changes": [
      {"type": "fix", "message": "prevent permanent freeze when a peer stops advancing in lockstep"}
    ]
  },
  {
    "version": "0.7.0",
    "date": "2026-03-27",
    "changes": [
      {"type": "feat", "message": "emulator hibernate between games"},
      {"type": "fix", "message": "guest black screen after streaming to lockstep"}
    ]
  }
]
```

Only `feat:` and `fix:` commits appear in the changelog. Other prefixes are excluded.

### bump-version.sh Logic

1. Read the last commit message: `git log -1 --format=%s`
2. Skip if message starts with `chore(version):` (prevents infinite loop)
3. Skip if prefix is not `feat:` or `fix:` (no bump for docs/chore/refactor/etc.)
4. Parse prefix: `feat:` → minor bump, `fix:` → patch bump
5. Read current version from `web/static/version.json`
6. Bump the appropriate component (minor resets patch to 0), write back
7. Include short commit SHA: `git rev-parse --short HEAD`
8. Generate `changelog.json` from git tags and log
9. Stage and commit: `git add web/static/version.json web/static/changelog.json && git commit --no-verify -m "chore(version): vX.Y.Z"`
10. Create lightweight tag: `git tag vX.Y.Z`

The `--no-verify` flag on the auto-commit is intentional — it prevents the post-commit hook from re-triggering on the version bump commit. The `chore(version):` prefix guard is a secondary safety net.

### Changelog Generation

Commits between consecutive version tags form each version's changelog entry:

- `git log v0.7.0..v0.7.1 --oneline` gives all commits in v0.7.1
- For the new version being created: commits from the last tag to HEAD (inclusive of the current commit)
- The tag for the new version is created AFTER the changelog is generated
- Parse commit messages, strip conventional commit prefix
- Categorize: `feat:` → "feat", `fix:` → "fix"
- Skip all other prefixes (docs, chore, refactor, style, test, etc.)
- Limit to last 20 versions to keep the file small
- Output prettier-compatible JSON (2-space indent) since prettier runs on JSON files in pre-commit

### Bootstrapping (One-Time Setup)

The repo currently has no git tags. A one-time bootstrap script (`scripts/seed-versions.sh`) will:

1. Read dates from CHANGELOG.md (e.g., `[0.7.0] - 2026-03-27`)
2. Find the nearest commit to each date: `git log --before="2026-03-28" --after="2026-03-26" -1 --format=%H`
3. Create lightweight tags: `git tag v0.7.0 <sha>`
4. Generate the initial `changelog.json` from the existing CHANGELOG.md content (richer descriptions than commit messages alone)
5. Create initial `version.json` with current version

After seeding, all future versions are auto-generated from git history.

### Frontend Display

Both `index.html` and `play.html` include `<script src="/static/version.js"></script>`.

**version.js** (IIFE, no dependencies):
1. Fetches `/static/version.json?_t={timestamp}` (cache bust via query param)
2. Fetches `/static/changelog.json?_t={timestamp}` on demand (first click only)
3. Finds and injects into `<span id="kn-version">` placeholder elements

**index.html** — version badge added to the existing `<p>` footer after the Ko-fi link:
```
by Kazon Wilson (Agent 21) · GitHub · Support · v0.7.1
```
The `<span id="kn-version">` is placed inside the footer `<p>`, styled as a clickable link matching `footer-link` class.

**play.html** — version badge added to the `<div class="overlay-footer">` after the Support link:
```
GitHub · Support · v0.7.1
```
Same `<span id="kn-version-play">` pattern, different container selector. The `version.js` script handles both by checking which element exists on the page.

**Changelog modal** — created dynamically on first click:
- Overlay backdrop with centered card (matches lobby-card aesthetic)
- Latest version expanded showing all changes
- Older versions collapsed, click to expand
- Close via X button, Escape key, or clicking backdrop
- Minimal inline styles injected by JS (no separate CSS file needed)

### pre-commit-config.yaml Addition

```yaml
  - repo: local
    hooks:
      - id: bump-version
        name: bump-version
        entry: scripts/bump-version.sh
        language: script
        stages: [post-commit]
        always_run: true
```

### Escape Hatch

To commit without triggering a version bump (e.g., fixing the bump script itself):
- Use any non-feat/fix prefix: `chore:`, `docs:`, `refactor:` — these are already skipped
- Or: `SKIP=bump-version git commit -m "..."` to bypass the hook entirely

### Edge Cases

- **Non-conventional commits** (no prefix): Skipped, no bump
- **Merge commits**: Skipped (no feat:/fix: prefix typically)
- **Amend**: The post-commit hook fires again; if the message hasn't changed and the tag already exists, the script detects the existing tag and skips
- **BREAKING CHANGE**: Not automated — manually tag v1.0.0 when ready
- **Tag already exists**: Script checks `git tag -l vX.Y.Z` before creating; skips if exists

### Not Included

- CI/CD integration (hook runs locally before push)
- npm/pypi publishing (not a library)
- CHANGELOG.md auto-update (version.json + changelog.json replace it as source of truth; CHANGELOG.md stays as historical reference)
- admin.html version display (low-traffic page, not worth the complexity)
