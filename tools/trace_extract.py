#!/usr/bin/env python3
"""
trace_extract.py — Enumerate training-data source records from kaillera-next.

Walks four source types:
  - memory/*.md   (auto-memory at ~/.claude/projects/-Users-kazon-kaillera-next/memory)
  - git log       (feat:/fix:/perf:/refactor: commits with changed-file lists)
  - docs/**/*.md  (project docs)
  - merged PRs    (via `gh` if available; optional)

For each record, assigns:
  - mode:       "think" | "no_think"  (Qwen3 hybrid target)
  - difficulty: "recall" | "style" | "diagnose" | "design"
  - mode_reason: why the heuristic picked that mode (for audit)

Emits one JSON record per line to --output (or stdout), and a count report
to stderr showing the realistic SFT-corpus ceiling before trace generation.

Usage:
  python tools/trace_extract.py --output data/raw_records.jsonl
  python tools/trace_extract.py --count-only
  python tools/trace_extract.py --skip-prs --count-only
"""

import argparse
import json
import re
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Iterator

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MEMORY_DIR = (
    Path.home() / ".claude" / "projects" / "-Users-kazon-kaillera-next" / "memory"
)
DOCS_DIR = REPO_ROOT / "docs"

# ---- classification heuristics -------------------------------------------------

THINK_KEYWORDS = re.compile(
    r"\b(root cause|decided|decision|investigation|diagnos\w*|why|because|"
    r"tradeoff|architecture|design|invariant|determinism|rollback|desync|"
    r"race|deadlock|hypothesi\w*|considered|rejected|alternative)\b",
    re.IGNORECASE,
)

SENSITIVE_PATH_RE = re.compile(
    r"(rollback|netplay|sync|determinism|rng|rdram|softfloat|lockstep|rsp|"
    r"kn_|fpu|gameplay_hash|invariant)",
    re.IGNORECASE,
)

TRIVIAL_COMMIT_RE = re.compile(r"^(chore|style|ci|build|deps|release)[(:]", re.IGNORECASE)

ARTIFACT_PATH_RE = re.compile(
    r"^(web/static/ejs/cores/|build/build/|.*\.wasm$|.*\.data$|.*\.bak-)"
)


@dataclass
class Record:
    source_type: str
    source_ref: str
    problem_text: str
    resolution_text: str
    code_refs: list = field(default_factory=list)
    mode: str = "no_think"
    mode_reason: str = ""
    difficulty: str = "recall"

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False)


def classify_mode(text: str, source_type: str, source_ref: str) -> tuple[str, str, str]:
    """Return (mode, reason, difficulty)."""
    if source_type == "memory":
        name = Path(source_ref).name
        if name.startswith(("feedback_", "reference_", "user_")):
            prefix = name.split("_", 1)[0]
            return "no_think", f"{prefix} memory = rule/lookup", "recall"
        if THINK_KEYWORDS.search(text):
            return "think", "project memory contains reasoning language", "diagnose"
        return "no_think", "project memory appears procedural", "recall"

    if source_type == "commit":
        subject = text.split("\n", 1)[0].lower()
        if TRIVIAL_COMMIT_RE.match(subject):
            return "no_think", "trivial conventional-commit type", "style"
        touches_sensitive = bool(SENSITIVE_PATH_RE.search(text))
        is_fix = subject.startswith("fix")
        is_feat = subject.startswith("feat")
        is_perf_refactor = subject.startswith(("perf", "refactor"))
        if is_fix and touches_sensitive:
            return "think", "bug fix touching determinism-critical path", "diagnose"
        if is_feat and touches_sensitive:
            return "think", "feature touching determinism-critical path", "design"
        if is_perf_refactor and touches_sensitive:
            return "think", "perf/refactor on determinism path", "design"
        if is_fix:
            return "no_think", "generic bug fix", "style"
        if is_feat:
            return "no_think", "generic feature addition", "style"
        return "no_think", "uncategorized commit", "style"

    if source_type == "doc":
        ref_lower = source_ref.lower()
        if any(k in ref_lower for k in ("invariant", "research", "architecture", "design")):
            return "think", "architectural/research doc", "design"
        return "no_think", "procedural doc", "recall"

    if source_type == "pr":
        if len(text) > 500 and THINK_KEYWORDS.search(text):
            return "think", "substantial PR rationale", "design"
        return "no_think", "short or mechanical PR", "style"

    return "no_think", "default", "recall"


# ---- source walkers ------------------------------------------------------------

def walk_memory(memory_dir: Path) -> Iterator[Record]:
    if not memory_dir.exists():
        print(f"[warn] memory dir not found: {memory_dir}", file=sys.stderr)
        return
    for md in sorted(memory_dir.glob("*.md")):
        if md.name == "MEMORY.md":
            continue
        try:
            text = md.read_text(encoding="utf-8")
        except OSError as e:
            print(f"[warn] could not read {md}: {e}", file=sys.stderr)
            continue
        # Strip frontmatter if present
        body = text
        if text.startswith("---"):
            parts = text.split("---", 2)
            if len(parts) >= 3:
                body = parts[2].strip()
        problem = md.stem.replace("_", " ")
        mode, reason, diff = classify_mode(body, "memory", str(md))
        yield Record(
            source_type="memory",
            source_ref=str(md.relative_to(Path.home())),
            problem_text=problem,
            resolution_text=body,
            mode=mode,
            mode_reason=reason,
            difficulty=diff,
        )


def walk_commits(max_count: int) -> Iterator[Record]:
    try:
        log = subprocess.run(
            [
                "git", "-C", str(REPO_ROOT), "log",
                f"--max-count={max_count}",
                "--pretty=format:%H%x00%s%x00%b%x1e",
            ],
            capture_output=True, text=True, check=True,
        )
    except subprocess.CalledProcessError as e:
        print(f"[warn] git log failed: {e}", file=sys.stderr)
        return

    entries = [e for e in log.stdout.split("\x1e") if e.strip()]
    for entry in entries:
        parts = entry.split("\x00")
        if len(parts) < 2:
            continue
        sha = parts[0].strip()
        subject = parts[1] if len(parts) > 1 else ""
        body = parts[2].strip() if len(parts) > 2 else ""
        if not subject:
            continue
        subject_lower = subject.lower()

        # Skip trivial commits that aren't fix/feat
        if TRIVIAL_COMMIT_RE.match(subject_lower) and not subject_lower.startswith(("fix", "feat")):
            continue

        try:
            show = subprocess.run(
                ["git", "-C", str(REPO_ROOT), "show", "--name-only", "--pretty=format:", sha],
                capture_output=True, text=True, check=True,
            )
            diff_files = [
                f for f in show.stdout.strip().splitlines()
                if f and not ARTIFACT_PATH_RE.match(f)
            ]
        except subprocess.CalledProcessError:
            diff_files = []

        combined = subject + "\n" + body + "\n" + " ".join(diff_files)
        mode, reason, diff = classify_mode(combined, "commit", sha)
        yield Record(
            source_type="commit",
            source_ref=sha,
            problem_text=subject,
            resolution_text=body or subject,
            code_refs=diff_files[:50],
            mode=mode,
            mode_reason=reason,
            difficulty=diff,
        )


def walk_docs() -> Iterator[Record]:
    if not DOCS_DIR.exists():
        return
    for md in sorted(DOCS_DIR.rglob("*.md")):
        try:
            text = md.read_text(encoding="utf-8")
        except OSError:
            continue
        if len(text) < 200:
            continue
        rel = md.relative_to(REPO_ROOT)
        mode, reason, diff = classify_mode(text, "doc", str(rel))
        yield Record(
            source_type="doc",
            source_ref=str(rel),
            problem_text=md.stem.replace("-", " ").replace("_", " "),
            resolution_text=text,
            mode=mode,
            mode_reason=reason,
            difficulty=diff,
        )


def walk_prs(max_count: int) -> Iterator[Record]:
    try:
        result = subprocess.run(
            ["gh", "pr", "list", "--state", "merged", "--limit", str(max_count),
             "--json", "number,title,body"],
            capture_output=True, text=True, check=True, cwd=str(REPO_ROOT),
        )
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        print(f"[warn] gh pr list skipped ({type(e).__name__})", file=sys.stderr)
        return
    try:
        prs = json.loads(result.stdout)
    except json.JSONDecodeError:
        return
    for pr in prs:
        body = (pr.get("body") or "").strip()
        title = pr.get("title") or ""
        if not body and not title:
            continue
        text = title + "\n" + body
        mode, reason, diff = classify_mode(text, "pr", f"PR#{pr.get('number')}")
        yield Record(
            source_type="pr",
            source_ref=f"PR#{pr.get('number')}",
            problem_text=title,
            resolution_text=body,
            mode=mode,
            mode_reason=reason,
            difficulty=diff,
        )


# ---- main ----------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description="Extract training-data source records.")
    ap.add_argument("--output", "-o", type=Path, default=None,
                    help="Write JSONL to this file. Default: stdout.")
    ap.add_argument("--count-only", action="store_true",
                    help="Skip record output, just print counts.")
    ap.add_argument("--memory-dir", type=Path, default=DEFAULT_MEMORY_DIR)
    ap.add_argument("--max-commits", type=int, default=2000)
    ap.add_argument("--max-prs", type=int, default=300)
    ap.add_argument("--skip-prs", action="store_true")
    args = ap.parse_args()

    sources: list[tuple[str, Iterator[Record]]] = [
        ("memory", walk_memory(args.memory_dir)),
        ("commit", walk_commits(args.max_commits)),
        ("doc", walk_docs()),
    ]
    if not args.skip_prs:
        sources.append(("pr", walk_prs(args.max_prs)))

    counts: dict[str, dict[str, int]] = {}
    difficulty_counts: dict[str, int] = {}

    out_stream = None
    if args.output and not args.count_only:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        out_stream = args.output.open("w", encoding="utf-8")

    try:
        for stype, gen in sources:
            counts.setdefault(stype, {"think": 0, "no_think": 0, "total": 0})
            for rec in gen:
                counts[stype]["total"] += 1
                counts[stype][rec.mode] += 1
                difficulty_counts[rec.difficulty] = difficulty_counts.get(rec.difficulty, 0) + 1
                if args.count_only:
                    continue
                line = rec.to_json()
                if out_stream:
                    out_stream.write(line + "\n")
                else:
                    print(line)
    finally:
        if out_stream:
            out_stream.close()

    total = sum(c["total"] for c in counts.values())
    total_think = sum(c["think"] for c in counts.values())
    total_no_think = sum(c["no_think"] for c in counts.values())
    denom = max(total, 1)

    lines = [
        "",
        "=== Extraction Summary ===",
        f"  repo:     {REPO_ROOT}",
        f"  memory:   {args.memory_dir}",
        "",
        "  By source:",
    ]
    for stype in ("memory", "commit", "doc", "pr"):
        c = counts.get(stype)
        if not c:
            continue
        lines.append(
            f"    {stype:10s} total={c['total']:5d}  "
            f"think={c['think']:5d}  no_think={c['no_think']:5d}"
        )
    lines += [
        "",
        f"  Totals:   {total} records",
        f"    think:     {total_think:5d} ({100 * total_think // denom}%)",
        f"    no_think:  {total_no_think:5d} ({100 * total_no_think // denom}%)",
        "",
        "  By difficulty:",
    ]
    for d in ("recall", "style", "diagnose", "design"):
        lines.append(f"    {d:10s} {difficulty_counts.get(d, 0)}")
    lines += [
        "",
        "  Projected in-domain SFT corpus (dual-generate think/no_think + N=3 variations):",
        f"    source records:                {total}",
        f"    after 2x dual-generate:         {total * 2}",
        f"    after N=3 trace variations:     {total * 6}",
        "",
        "  Compare to recommended target: ~5,000 in-domain (think+no_think combined).",
        "",
    ]
    print("\n".join(lines), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
