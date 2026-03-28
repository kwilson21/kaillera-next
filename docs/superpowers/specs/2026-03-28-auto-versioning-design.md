# Auto-Versioning with Changelog Display

## Problem

Solo developer with no way to tell what version is deployed in production. Version bumps and changelog updates are manual and easily forgotten.

## Solution

Automatic semver bumping via conventional commit prefixes, with version displayed in the frontend footer and a clickable changelog modal generated from git history.

## Architecture

### Version Bump Flow

```
Developer commits with "feat: ..." or "fix: ..."
  → pre-commit hook (commit-msg stage) runs scripts/bump-version.sh
    → Reads current version from web/static/version.json
    → Parses commit message: feat: → minor, fix: → patch, else → patch
    → Bumps version, writes web/static/version.json
    → Generates web/static/changelog.json from git log + tags
    → Auto-stages both files into the commit
  → After commit: hook creates git tag (v0.7.1)
```

### Files

| File | Purpose |
|------|---------|
| `web/static/version.json` | `{"version": "0.7.1"}` — single source of truth |
| `web/static/changelog.json` | `[{version, date, changes: [{type, message}]}]` |
| `scripts/bump-version.sh` | Bump logic + changelog generation |
| `.pre-commit-config.yaml` | New `commit-msg` stage hook entry |

### version.json Format

```json
{"version": "0.7.1"}
```

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

### bump-version.sh Logic

1. Read `.git/COMMIT_EDITMSG` for the commit message
2. Skip if message starts with `chore(version):` (prevents self-trigger on version bump commits)
3. Parse prefix: `feat:` → minor bump, `fix:` → patch, everything else → patch
4. Read current version from `web/static/version.json`
5. Bump the appropriate component, write back
6. Generate `changelog.json` from `git log --oneline` grouped by tags
7. `git add web/static/version.json web/static/changelog.json`

### Changelog Generation

The script reads git tags (v0.1.0, v0.2.0, etc.) and groups commits between tags. For each version:
- Parse commit messages, strip conventional commit prefixes
- Categorize: `feat:` → "feat", `fix:` → "fix", `docs:` → "docs", else → "chore"
- Only include feat/fix in the displayed changelog (skip docs/chore/refactor)
- Limit to last 20 versions to keep the file small

### Frontend Display

Both `index.html` and `play.html` get:

1. **Version badge** — appended to existing footer, styled as a clickable link:
   ```
   by Kazon Wilson · GitHub · Support · v0.7.1
   ```

2. **Changelog modal** — simple overlay that appears on click:
   - Latest version expanded with full change list
   - Older versions collapsed (click to expand)
   - Close via X button, Escape key, or clicking backdrop
   - Styled consistently with existing lobby-card aesthetic

3. **Implementation** — a shared `web/static/version.js` script included on both pages:
   - Fetches `version.json` and `changelog.json` on load
   - Injects version text into a `<span id="kn-version">` placeholder in the footer
   - Creates the modal DOM on first click
   - No dependencies, vanilla JS, IIFE pattern (consistent with codebase)

### pre-commit-config.yaml Addition

```yaml
  - repo: local
    hooks:
      - id: bump-version
        name: bump-version
        entry: scripts/bump-version.sh
        language: script
        stages: [commit-msg]
        always_run: true
```

### Seeding

The current v0.7.0 changelog entries are seeded into the initial `changelog.json` from the existing CHANGELOG.md content. Going forward, the script generates from git history. A one-time `git tag` pass tags existing versions (v0.1.0 through v0.7.0) to establish the version boundary markers.

### Edge Cases

- **Merge commits**: Treated as patch (no prefix match)
- **Multiple feat: in one commit**: Still one minor bump per commit
- **Amend/rebase**: Tag is on the final commit SHA; old tags become orphaned (harmless)
- **BREAKING CHANGE**: Not automated (manual tag for v1.0.0 when ready)
- **No conventional prefix**: Defaults to patch bump

### Not Included

- CI/CD integration (not needed — hook runs locally before push)
- npm/pypi publishing (not a library)
- CHANGELOG.md auto-update (version.json + changelog.json are the source of truth now; CHANGELOG.md stays as historical reference but is no longer maintained)
