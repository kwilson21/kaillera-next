#!/usr/bin/env bash
# Create one local version commit and tag for the changes since the last one.
# The release workflow supplies PLAYER_NOTES and publishes the commit and tag.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
if [[ "$(git branch --show-current)" != main ]]; then
  echo "bump-version: release must be prepared on main" >&2
  exit 1
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "bump-version: working tree is dirty" >&2
  exit 1
fi

previous=$(git log --first-parent --format=%H --grep='^chore(version):' -1)
if [[ -z "$previous" || "$previous" == "$(git rev-parse HEAD)" ]]; then
  echo "bump-version: expected unreleased commits after the previous version" >&2
  exit 1
fi

release_type=fix
subjects=$(git log --first-parent --format=%s "$previous..HEAD")
while IFS= read -r subject; do
  case "$subject" in
    feat:*|feat\(*) release_type=feat; break ;;
  esac
done <<< "$subjects"

new_version=$(node --input-type=module - "$release_type" "$(git rev-parse --short HEAD)" <<'JS'
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const [, , type, commit] = process.argv;
const versionPath = 'web/static/version.json';
const changelogPath = 'web/static/changelog.json';
const notes = (process.env.PLAYER_NOTES ?? '')
  .split(/\r?\n/)
  .map((line) => line.trim().replace(/^[-*]\s+/, '').trim())
  .filter(Boolean);
if (notes.length === 0) throw new Error('Supply at least one player-facing release note.');

const current = JSON.parse(readFileSync(versionPath, 'utf8'));
const changelog = JSON.parse(readFileSync(changelogPath, 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(current.version)) throw new Error('Invalid current release version.');
const [major, minor, patch] = current.version.split('.').map(Number);
const version = type === 'feat' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
if (execFileSync('git', ['tag', '--list', `v${version}`], { encoding: 'utf8' }).trim()) {
  throw new Error(`Tag v${version} already exists.`);
}
changelog.unshift({
  version,
  date: new Date().toISOString().slice(0, 10),
  changes: notes.map((message) => ({ type, message })),
});
writeFileSync(versionPath, JSON.stringify({ version, commit }, null, 2) + '\n');
writeFileSync(changelogPath, JSON.stringify(changelog, null, 2) + '\n');
process.stdout.write(version);
JS
)
git add web/static/version.json web/static/changelog.json
git commit --no-verify -m "chore(version): v${new_version}"
git tag -a "v${new_version}" -m "v${new_version}"
