#!/usr/bin/env bash
set -euo pipefail

LOCKFILE="/tmp/kn-bump.lock"
REPO_ROOT="$(git rev-parse --show-toplevel)"
VERSION_FILE="$REPO_ROOT/web/static/version.json"
CHANGELOG_FILE="$REPO_ROOT/web/static/changelog.json"

# Always clean up lockfile on exit
cleanup() { rm -f "$LOCKFILE"; }
trap cleanup EXIT

# Re-entry guard: lockfile
if [ -f "$LOCKFILE" ]; then
  exit 0
fi

# Only bump on main branch
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ]; then
  exit 0
fi

# Read last commit message
MSG=$(git log -1 --format=%s)

# Skip version bump commits (secondary guard)
case "$MSG" in
  chore\(version\):*) exit 0 ;;
esac

# Only bump on feat: or fix:
BUMP=""
case "$MSG" in
  feat:*|feat\(*) BUMP="minor" ;;
  fix:*|fix\(*)   BUMP="patch" ;;
  *)              exit 0 ;;
esac

# Create lockfile
touch "$LOCKFILE"

cd "$REPO_ROOT"

# Read current version
CURRENT=$(grep -o '"version": *"[^"]*"' "$VERSION_FILE" | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+')
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

# Bump
if [ "$BUMP" = "minor" ]; then
  MINOR=$((MINOR + 1))
  PATCH=0
else
  PATCH=$((PATCH + 1))
fi
NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"

# Check if tag already exists (e.g. amend)
if git tag -l "v${NEW_VERSION}" | grep -q .; then
  exit 0
fi

# Commit hash of the developer's commit
COMMIT_HASH=$(git rev-parse --short HEAD)

# Write version.json
cat > "$VERSION_FILE" << EOF
{
  "version": "${NEW_VERSION}",
  "commit": "${COMMIT_HASH}"
}
EOF

# Generate new changelog entry and prepend to existing changelog
# Uses node since it's available (prettier dependency) and JSON manipulation in bash is painful
node -e "
const fs = require('fs');
const { execSync } = require('child_process');

const changelogPath = '${CHANGELOG_FILE}';
const changelog = JSON.parse(fs.readFileSync(changelogPath, 'utf8'));

// Get commits since last tag
const lastTag = execSync('git describe --tags --abbrev=0 HEAD~1 2>/dev/null || echo \"\"').toString().trim();
const range = lastTag ? lastTag + '..HEAD' : 'HEAD';
const log = execSync('git log --oneline ' + range + ' --').toString().trim();

const changes = [];
for (const line of log.split('\n')) {
  if (!line) continue;
  const msg = line.replace(/^[a-f0-9]+ /, '');
  if (msg.startsWith('feat:') || msg.startsWith('feat(')) {
    changes.push({ type: 'feat', message: msg.replace(/^feat(\([^)]*\))?: /, '') });
  } else if (msg.startsWith('fix:') || msg.startsWith('fix(')) {
    changes.push({ type: 'fix', message: msg.replace(/^fix(\([^)]*\))?: /, '') });
  }
}

if (changes.length > 0) {
  const entry = {
    version: '${NEW_VERSION}',
    date: new Date().toISOString().split('T')[0],
    changes
  };
  changelog.unshift(entry);
}

// Keep last 20 versions
const trimmed = changelog.slice(0, 20);
fs.writeFileSync(changelogPath, JSON.stringify(trimmed, null, 2) + '\n');
"

# Stage and commit
git add "$VERSION_FILE" "$CHANGELOG_FILE"
git commit -m "chore(version): v${NEW_VERSION}"
git tag "v${NEW_VERSION}"

echo "Bumped to v${NEW_VERSION}"
