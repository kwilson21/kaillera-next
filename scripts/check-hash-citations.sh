#!/bin/bash
# Verify every kn_hash_* declaration in kn_hash_registry.h has a citation
# block immediately preceding it. Citation block must contain:
#   "Source:" "decomp:" "Address:" "Sampling:"
#
# Exits 0 if all declarations are cited; exits 1 with a list of offending
# declarations otherwise.
set -euo pipefail

HEADER="${1:-build/kn_rollback/kn_hash_registry.h}"

if [ ! -f "$HEADER" ]; then
    echo "Header file not found: $HEADER" >&2
    exit 2
fi

awk '
BEGIN { bad = 0; block = ""; in_block = 0 }

# Comment block start
/^\/\*/ { in_block = 1; block = $0 "\n"; next }

# Comment block continuation
in_block && /\*\// { in_block = 0; block = block $0 "\n"; next }
in_block { block = block $0 "\n"; next }

# Declaration line — only primary kn_hash_<field> exports.
# Skip kn_hash_history_<field> sister exports (cited under the primary)
# and kn_hash_fnv1a (algorithm helper, not a field).
/(uint32_t|size_t)[[:space:]]+kn_hash_/ {
    if ($0 ~ /kn_hash_history_/ || $0 ~ /kn_hash_fnv1a/) {
        block = ""
        next
    }
    decl = $0
    missing = ""
    if (block !~ /Source:/)   missing = missing " Source:"
    if (block !~ /decomp:/)   missing = missing " decomp:"
    if (block !~ /Address:/)  missing = missing " Address:"
    if (block !~ /Sampling:/) missing = missing " Sampling:"
    if (missing != "") {
        print "MISSING_CITATION:" decl ":" missing
        bad = 1
    }
    block = ""
    next
}

# Reset block on blank line (only the comment immediately preceding the
# declaration counts as the citation). BEGIN-init makes this portable
# across BSD awk (macOS) and gawk (Linux CI).
/^[[:space:]]*$/ { block = "" }

END { exit bad }
' "$HEADER"
