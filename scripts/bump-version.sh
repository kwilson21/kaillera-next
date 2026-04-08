#!/usr/bin/env bash
#
# bump-version.sh — invoked by `just deploy`, NOT by a git hook.
#
# Scans all unpushed commits on main since origin/main, infers a version
# bump from conventional commit prefixes, writes one chore(version)
# commit + tag containing one changelog bullet per substantive commit,
# and exits. The caller (`just deploy`) handles `git push --follow-tags`.
#
# Bump rule:
#   any feat:  → minor
#   any fix:   → patch
#   neither    → no bump (exit 0, no commit)
#
# Idempotent: re-running when there's nothing new to bump is a no-op.
#
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
VERSION_FILE="$REPO_ROOT/web/static/version.json"
CHANGELOG_FILE="$REPO_ROOT/web/static/changelog.json"

cd "$REPO_ROOT"

# ── Safety checks ────────────────────────────────────────────────────────
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ]; then
  echo "bump-version: refusing to bump on branch '$BRANCH' (must be main)"
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "bump-version: working tree is dirty — commit or stash first"
  exit 1
fi

# Need an up-to-date view of origin/main to compute the unpushed range.
git fetch --quiet origin main

UNPUSHED_RANGE="origin/main..HEAD"
TOTAL_UNPUSHED=$(git rev-list --count "$UNPUSHED_RANGE")
if [ "$TOTAL_UNPUSHED" -eq 0 ]; then
  echo "bump-version: nothing to bump (HEAD is at origin/main)"
  exit 0
fi

# Idempotency: if there's already an unpushed chore(version) commit, the
# user has already bumped this release. Only count feat/fix commits ADDED
# after that point — if there are none, no new bump is needed.
LAST_VERSION_COMMIT=$(git log --format=%H --grep='^chore(version):' "$UNPUSHED_RANGE" -1 || true)
if [ -n "$LAST_VERSION_COMMIT" ]; then
  RANGE="${LAST_VERSION_COMMIT}..HEAD"
else
  RANGE="$UNPUSHED_RANGE"
fi

# ── Detect bump level ────────────────────────────────────────────────────
MSGS=$(git log --format=%s "$RANGE")
BUMP=""
while IFS= read -r line; do
  case "$line" in
    feat:*|feat\(*) BUMP="minor"; break ;;  # minor wins, stop scanning
    fix:*|fix\(*)   BUMP="patch" ;;
  esac
done <<< "$MSGS"

if [ -z "$BUMP" ]; then
  echo "bump-version: no feat/fix commits in $RANGE — nothing to bump"
  exit 0
fi

# ── Compute new version ──────────────────────────────────────────────────
CURRENT=$(grep -o '"version": *"[^"]*"' "$VERSION_FILE" | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+')
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

if [ "$BUMP" = "minor" ]; then
  MINOR=$((MINOR + 1))
  PATCH=0
else
  PATCH=$((PATCH + 1))
fi
NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"

if git tag -l "v${NEW_VERSION}" | grep -q .; then
  echo "bump-version: tag v${NEW_VERSION} already exists — refusing to overwrite"
  exit 1
fi

# ── Write version.json (commit hash filled in after the commit lands) ────
# We use a placeholder, then rewrite-and-amend so the file accurately
# reports its own commit. Two-step is unavoidable: the hash is not known
# until after the commit is made.
cat > "$VERSION_FILE" << EOF
{
  "version": "${NEW_VERSION}",
  "commit": "pending"
}
EOF

# ── Build changelog entry ────────────────────────────────────────────────
node -e "
const fs = require('fs');
const { execSync } = require('child_process');

const changelogPath = '${CHANGELOG_FILE}';
const newVersion = '${NEW_VERSION}';
const range = '${RANGE}';

const changelog = JSON.parse(fs.readFileSync(changelogPath, 'utf8'));
const log = execSync('git log --format=%s ' + range).toString().trim();

const changes = [];
for (const msg of log.split('\n').reverse()) {
  if (!msg) continue;
  if (msg.startsWith('feat:') || msg.startsWith('feat(')) {
    changes.push({ type: 'feat', message: msg.replace(/^feat(\([^)]*\))?: /, '') });
  } else if (msg.startsWith('fix:') || msg.startsWith('fix(')) {
    changes.push({ type: 'fix', message: msg.replace(/^fix(\([^)]*\))?: /, '') });
  }
  // chore/docs/test/build/refactor are intentionally excluded from the
  // user-facing changelog.
}

if (changes.length === 0) {
  console.error('bump-version: no feat/fix bullets found in range — aborting');
  process.exit(1);
}

const entry = {
  version: newVersion,
  date: new Date().toISOString().split('T')[0],
  changes,
};
changelog.unshift(entry);
fs.writeFileSync(changelogPath, JSON.stringify(changelog, null, 2) + '\n');
console.log('bump-version: wrote ' + changes.length + ' changelog bullets for v' + newVersion);
"

# ── Commit + tag ─────────────────────────────────────────────────────────
git add "$VERSION_FILE" "$CHANGELOG_FILE"
git commit --no-verify -m "chore(version): v${NEW_VERSION}"

# Now backfill the actual commit hash into version.json and amend.
COMMIT_HASH=$(git rev-parse --short HEAD)
cat > "$VERSION_FILE" << EOF
{
  "version": "${NEW_VERSION}",
  "commit": "${COMMIT_HASH}"
}
EOF
git add "$VERSION_FILE"
git commit --amend --no-verify --no-edit > /dev/null

git tag "v${NEW_VERSION}"

echo ""
echo "✓ bumped to v${NEW_VERSION} (${COMMIT_COUNT} commits in range)"
echo "  next: git push origin main --follow-tags"
