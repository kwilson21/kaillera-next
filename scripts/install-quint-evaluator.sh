#!/usr/bin/env bash
# Install the Linux x64 evaluator matched to the locked Quint CLI. Download
# from its official release and verify the release asset's published SHA-256.
set -euo pipefail
cd "$(dirname "$0")/.."
version=v0.7.1
sha256=ce0502bdef65dc26c242a9e56379a9bb26de6f3db38f0e3989339d46a542f5eb
installed=$(node -p "require('./node_modules/@informalsystems/quint/dist/src/rust/binaryManager.js').QUINT_EVALUATOR_VERSION")
if [ "$installed" != "$version" ]; then
  echo "Quint needs evaluator $installed; update this pin and release checksum together" >&2
  exit 1
fi
if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
  echo 'This CI installer supports Linux x64; the Quint CLI downloads other platforms itself' >&2
  exit 1
fi
dir="${QUINT_HOME:-$HOME/.quint}/rust-evaluator-$version"
archive=$(mktemp)
trap 'rm -f "$archive"' EXIT
curl --fail --silent --show-error --location --retry 3 \
  "https://github.com/quint-co/quint/releases/download/evaluator/$version/quint_evaluator-x86_64-unknown-linux-gnu.tar.gz" \
  -o "$archive"
printf '%s  %s\n' "$sha256" "$archive" | sha256sum --check --status
mkdir -p "$dir"
tar -xzf "$archive" -C "$dir" quint_evaluator
chmod +x "$dir/quint_evaluator"
