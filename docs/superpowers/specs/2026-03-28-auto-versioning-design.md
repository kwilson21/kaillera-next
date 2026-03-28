# Auto-Versioning with Changelog Display

## Problem

No way to tell what version is deployed in production.

## Solution

Auto-bump semver on `feat:`/`fix:` commits. Show version in page footer. Click it to see changelog.

## How It Works

1. **Post-commit hook** reads the commit message via `git log -1 --format=%s`
2. `feat:` → minor bump, `fix:` → patch bump, anything else → skip
3. Updates `web/static/version.json`, generates `web/static/changelog.json` from git tags
4. Auto-commits both files: `chore(version): vX.Y.Z` (with `--no-verify` to prevent loop)
5. Creates lightweight git tag `vX.Y.Z`

## Files

| File | Purpose |
|------|---------|
| `web/static/version.json` | `{"version": "0.7.1", "commit": "cc1d283"}` |
| `web/static/changelog.json` | Array of `{version, date, changes: [{type, message}]}` |
| `scripts/bump-version.sh` | Bump + changelog generation logic |
| `web/static/version.js` | Footer badge + changelog modal (shared across pages) |

## Frontend

- Version badge appended to existing footer on `index.html` and `play.html`
- Click opens modal: latest version expanded, older versions collapsed
- `version.js` fetches both JSON files, injects into `<span id="kn-version">` placeholders

## Bootstrapping

One-time: tag existing versions (v0.1.0–v0.7.0) on the right commits, seed `changelog.json` from CHANGELOG.md content.
