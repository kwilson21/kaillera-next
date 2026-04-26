#!/usr/bin/env python3
"""
trace_generate.py — Turn raw_records.jsonl into training traces via Claude.

Reads records produced by trace_extract.py, then for each record generates
N reasoning traces (think mode) or direct answers (no_think mode) using
Claude Opus 4.7. The stable system prefix is prompt-cached so every call
after the first reads it at ~10% cost.

Resumable: on restart, skips records+variations already present in the
output file. Safe to Ctrl-C and re-run.

Usage:
  # Preview cost only, no API calls
  python tools/trace_generate.py --input data/raw_records.jsonl --preview

  # Generate 3 variations per record, resumable
  python tools/trace_generate.py \\
      --input data/raw_records.jsonl \\
      --output data/traces.jsonl \\
      --variations 3

  # Sonnet 4.6 instead of Opus 4.7 (5x cheaper)
  python tools/trace_generate.py \\
      --input data/raw_records.jsonl --output data/traces.jsonl \\
      --model claude-sonnet-4-6 --variations 3

  # Limit for a smoke test
  python tools/trace_generate.py --input data/raw_records.jsonl \\
      --output data/traces.jsonl --limit 5
"""

import argparse
import json
import os
import re
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Iterator, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    import anthropic

# ---- configuration -----------------------------------------------------------

DEFAULT_MODEL = "claude-opus-4-7"
DEFAULT_EFFORT = "high"
DEFAULT_MAX_TOKENS_THINK = 12000
DEFAULT_MAX_TOKENS_NO_THINK = 2500

# $/M tokens. "free" means zero — just use 0 across the board for preview.
PRICING = {
    # Anthropic
    "claude-opus-4-7":   {"in": 5.00, "out": 25.00, "cache_read": 0.50, "cache_write": 6.25},
    "claude-opus-4-6":   {"in": 5.00, "out": 25.00, "cache_read": 0.50, "cache_write": 6.25},
    "claude-sonnet-4-6": {"in": 3.00, "out": 15.00, "cache_read": 0.30, "cache_write": 3.75},
    "claude-haiku-4-5":  {"in": 1.00, "out":  5.00, "cache_read": 0.10, "cache_write": 1.25},
    # DeepSeek (paid but trivial)
    "deepseek-chat":     {"in": 0.14, "out":  0.28, "cache_read": 0.014, "cache_write": 0.14},
    "deepseek-reasoner": {"in": 0.55, "out":  2.19, "cache_read": 0.055, "cache_write": 0.55},
    # Free tiers — treat as zero for estimator
    "gemini-2.5-flash":     {"in": 0, "out": 0, "cache_read": 0, "cache_write": 0},
    "gemini-2.5-pro":       {"in": 0, "out": 0, "cache_read": 0, "cache_write": 0},
    "gemini-2.0-flash":     {"in": 0, "out": 0, "cache_read": 0, "cache_write": 0},
    "llama-3.3-70b-versatile": {"in": 0, "out": 0, "cache_read": 0, "cache_write": 0},
}

# Provider → (default base_url, default env var for API key, supports Anthropic-native caching?)
PROVIDERS = {
    "anthropic": {
        "base_url": None,  # SDK default
        "api_key_env": "ANTHROPIC_API_KEY",
        "native_cache": True,
    },
    "gemini": {
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
        "api_key_env": "GEMINI_API_KEY",
        "native_cache": False,
    },
    "deepseek": {
        "base_url": "https://api.deepseek.com",
        "api_key_env": "DEEPSEEK_API_KEY",
        "native_cache": False,  # DeepSeek does auto-cache server-side, not via param
    },
    "groq": {
        "base_url": "https://api.groq.com/openai/v1",
        "api_key_env": "GROQ_API_KEY",
        "native_cache": False,
    },
    "openai-compat": {
        "base_url": None,  # user must pass --base-url
        "api_key_env": "OPENAI_API_KEY",
        "native_cache": False,
    },
}

# ---- system prompts (stable → cacheable) -------------------------------------

PROJECT_CONTEXT = """\
# Project: kaillera-next

kaillera-next is a browser-based online netplay platform for retro games
(initially Super Smash Bros. 64 on the mupen64plus-next Nintendo 64 emulator).
Players visit a URL, drag-and-drop a ROM, and play with friends over WebRTC
— no emulator installation required.

## Architecture

Server (Python FastAPI + python-socketio + uvloop) handles room management
and WebRTC signaling only. Once peers connect, netplay is fully peer-to-peer.
Redis persists rooms across deploys. Frontend is vanilla JS (IIFE + window
globals — ES modules do not work with EmulatorJS interop).

Three netplay modes coexist:
- Lockstep: deterministic full-mesh WebRTC DataChannels; all players run
  their own emulator synchronized frame-by-frame with configurable input
  delay. Up to 4 players.
- Rollback: GGPO-style input prediction at the C level (kn_rollback.c),
  full-state save ring buffer (serialize every frame), amortized replay.
  Cross-platform determinism achieved via SoftFloat FPU (bit-exact IEEE
  754 on x86, ARM, and WASM). Host-authoritative resync is fallback only.
- Streaming: host runs the only emulator, streams canvas video via WebRTC
  MediaStream; guests send input back on DataChannel. Star topology.

## The WASM core

A forked mupen64plus-next compiled with deterministic-timing patches:
kn_set_deterministic, kn_set_frame_time, SoftFloat FPU substitution
for the entire FP pipeline, RNG seed capture, and rollback export
surface (kn_save_state_raw, kn_load_state_immediate, kn_sync_hash,
kn_gameplay_hash). Falls back to stock CDN core with a JS-level
timing shim when the patched core is unavailable.

## Codified invariants (docs/netplay-invariants.md)

I1 — No stall without a timeout: every tick-loop early-return that waits
     on an external event has a wall-clock deadline and a recovery action.
I2 — Reconnect starts clean: all per-peer cleanup routes through
     resetPeerState(slot, reason). Adding per-peer state without updating
     resetPeerState is a review-level violation.
R1–R6 — Rollback integrity: the C engine must produce bit-correct state
        or fail loudly. Dev throws; prod logs REPLAY-NORUN,
        RB-INVARIANT-VIOLATION, FATAL-RING-STALE, or RB-LIVE-MISMATCH.
        No mid-match auto-resync from these events — fix the root cause.

## Key files

- web/static/netplay-lockstep.js (~4000 lines) — lockstep engine, tick
  loop, mesh management, input relay, resetPeerState
- web/static/play.js (~3300 lines) — play page orchestrator, EmulatorJS
  lifecycle, UI, mode transitions
- web/static/shared.js — input encoding (N64 button-map), cheats, wire
  format; all modules import from here via window globals
- web/static/kn-state.js — cross-module state bus (KNState.*)
- build/kn_rollback/kn_rollback.c — C rollback engine, input prediction,
  save ring, amortized replay
- build/patches/ — all deterministic-timing patches to mupen64plus-next
- server/src/api/signaling.py — Socket.IO event handlers
- server/src/state.py — Redis-backed room persistence

## Conventions

- Netplay code is bit-exact sensitive. Anything touching simulation
  threads, FP, RNG, input timing, or tick scheduling MUST preserve
  determinism. Rendering changes are safe; simulation changes are not.
- Modern ES2023+ JavaScript (const/let, arrow, template literals,
  async/await, optional chaining), BUT no ES modules — use IIFE and
  window globals.
- Conventional commits drive auto-versioning: feat: → minor, fix: → patch.
- Determinism probes sample at game-frame checkpoints, not wall-clock.
- Fixed input delay like Kaillera/GGPO/Fightcade; no mid-match adjustment.
"""

THINK_MODE_INSTRUCTIONS = """\
# Output mode: `think`

You are generating a reasoning trace that shows how an engineer would
derive the given resolution from the given problem. The trace is training
data for a local Qwen3-32B that must learn to reason through problems
in this codebase.

## Required structure

Output MUST follow this exact shape (literal tags, no markdown fences):

<think>
{PROBLEM FRAMING — 1-3 sentences restating the problem in concrete terms,
citing specific files/symbols/invariants from the project}

{HYPOTHESES — 2-4 candidate explanations or approaches, each explicitly
numbered or bulleted, each with the evidence that supports it and the
evidence that weighs against it}

{ELIMINATION — prose reasoning showing which hypotheses fail and why,
grounded in code paths, invariants, or prior decisions}

{CHOSEN APPROACH — the surviving hypothesis, stated as a concrete change
or conclusion, referencing the specific files/lines that will change}

{VERIFICATION — what would falsify this? what test/invariant/log would
catch a regression?}
</think>

{FINAL ANSWER — the resolution itself, written as a normal response.
If the resolution is a code change, describe the change and why.
If the resolution is a decision, state the decision and its trigger.}

## Hard requirements

- The <think> block MUST be at least 500 tokens. Short reasoning doesn't
  transfer to the student model.
- Every file path cited in the trace MUST appear in the record's code_refs
  or be one of the Key files listed above. Do NOT invent paths.
- The FINAL ANSWER MUST be consistent with the ground-truth resolution
  provided in the user turn. You are rationalizing backward from a known
  answer; your job is producing VALID reasoning to that answer, not
  discovering it.
- Use this project's vocabulary: "invariant I1/I2", "resetPeerState",
  "rollback ring", "SoftFloat FPU", "desync", "taint", "gameplay hash",
  etc. If a term doesn't appear in the project context or user message,
  do not introduce it.
- No preamble before <think>. No postamble after the final answer.
  No "Here is a reasoning trace:" — go straight in.
"""

NO_THINK_MODE_INSTRUCTIONS = """\
# Output mode: `no_think`

You are generating a direct answer in the voice of a repo-fluent engineer.
This is training data for the `no_think` path of a hybrid-thinking model —
it must contain NO reasoning language.

## Required shape

{DIRECT ANSWER — the resolution, stated concisely, written as if you
already know the answer and are just reporting it. Code, commands,
or short prose as appropriate. Usually 50-400 tokens.}

## Hard requirements

- NO phrases that indicate reasoning: "let me think", "first", "because",
  "therefore", "we need to", "consider", "it seems", "likely", "the issue
  is", "to solve this", "we should".
- NO <think> tags.
- NO preamble ("Sure, here's the answer:"). NO sign-off.
- If the resolution is code, emit the code directly. If prose, state the
  fact. If a lookup, give the value.
- Voice: terse, declarative, engineer-to-engineer. Match the project's
  style (see Key files, IIFE + window globals).
"""

# ---- record handling ---------------------------------------------------------

@dataclass
class RawRecord:
    source_type: str
    source_ref: str
    problem_text: str
    resolution_text: str
    code_refs: list
    mode: str
    mode_reason: str
    difficulty: str

    @classmethod
    def from_line(cls, line: str) -> "RawRecord":
        d = json.loads(line)
        return cls(
            source_type=d["source_type"],
            source_ref=d["source_ref"],
            problem_text=d["problem_text"],
            resolution_text=d["resolution_text"],
            code_refs=d.get("code_refs", []),
            mode=d["mode"],
            mode_reason=d.get("mode_reason", ""),
            difficulty=d.get("difficulty", "recall"),
        )


@dataclass
class TraceOutput:
    prompt: str
    mode: str
    think_block: Optional[str]
    response: str
    source: dict
    code_refs: list
    difficulty: str
    generator_model: str
    variation_idx: int
    usage: dict = field(default_factory=dict)

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False)


# ---- prompt construction -----------------------------------------------------

def build_system_prompt(mode: str) -> str:
    """Stable across all calls for a given mode — prompt-cacheable."""
    mode_block = THINK_MODE_INSTRUCTIONS if mode == "think" else NO_THINK_MODE_INSTRUCTIONS
    return f"""{PROJECT_CONTEXT}

{mode_block}

You will receive source records from the project (memory entries,
commits, PRs, docs). Each record provides a problem statement, a
ground-truth resolution, and optionally referenced code paths.
Produce output matching the mode specification above.

Stay grounded in the code paths and project concepts listed in the
project context. Do not invent file names, APIs, or invariants that
aren't in the source material or project context."""


def build_user_prompt(record: RawRecord, variation_idx: int) -> str:
    refs = "\n".join(f"  - {r}" for r in record.code_refs[:30]) if record.code_refs else "  (none)"
    return f"""## Source record

**Type:** {record.source_type}
**Reference:** {record.source_ref}
**Classified mode:** {record.mode}
**Difficulty:** {record.difficulty}
**Classifier rationale:** {record.mode_reason}

**Referenced files:**
{refs}

## Problem statement

{record.problem_text}

## Ground-truth resolution

{record.resolution_text}

---

Generate the {record.mode}-mode training example. This is variation #{variation_idx + 1}; if prior variations exist they will differ in framing, emphasis, and which hypotheses were considered — but MUST land on the same resolution."""


# ---- response parsing --------------------------------------------------------

THINK_RE = re.compile(r"<think>(.*?)</think>\s*(.*)", re.DOTALL)

def parse_response(text: str, mode: str) -> tuple[Optional[str], str]:
    text = text.strip()
    if mode == "think":
        m = THINK_RE.search(text)
        if not m:
            return None, text
        return m.group(1).strip(), m.group(2).strip()
    return None, text


# ---- resumability ------------------------------------------------------------

def load_completed(output_path: Path) -> set[tuple[str, int]]:
    """Return {(source_ref, variation_idx)} for already-written traces."""
    if not output_path.exists():
        return set()
    done = set()
    with output_path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
                done.add((d["source"]["ref"], d["variation_idx"]))
            except (json.JSONDecodeError, KeyError):
                continue
    return done


# ---- generation loop ---------------------------------------------------------

def generate_trace_anthropic(
    client,
    record: RawRecord,
    variation_idx: int,
    model: str,
    effort: str,
    thinking_enabled: bool,
) -> TraceOutput:
    system_prompt = build_system_prompt(record.mode)
    user_prompt = build_user_prompt(record, variation_idx)
    max_tokens = DEFAULT_MAX_TOKENS_THINK if record.mode == "think" else DEFAULT_MAX_TOKENS_NO_THINK

    kwargs = {
        "model": model,
        "max_tokens": max_tokens,
        "system": [{
            "type": "text",
            "text": system_prompt,
            "cache_control": {"type": "ephemeral"},
        }],
        "output_config": {"effort": effort},
        "messages": [{"role": "user", "content": user_prompt}],
    }
    if thinking_enabled:
        kwargs["thinking"] = {"type": "adaptive"}

    with client.messages.stream(**kwargs) as stream:
        message = stream.get_final_message()

    text = "".join(b.text for b in message.content if b.type == "text")
    think_block, response = parse_response(text, record.mode)

    return TraceOutput(
        prompt=record.problem_text,
        mode=record.mode,
        think_block=think_block,
        response=response,
        source={"type": record.source_type, "ref": record.source_ref},
        code_refs=record.code_refs,
        difficulty=record.difficulty,
        generator_model=model,
        variation_idx=variation_idx,
        usage={
            "input": message.usage.input_tokens,
            "output": message.usage.output_tokens,
            "cache_read": getattr(message.usage, "cache_read_input_tokens", 0) or 0,
            "cache_write": getattr(message.usage, "cache_creation_input_tokens", 0) or 0,
        },
    )


def generate_trace_openai_compat(
    client,
    record: RawRecord,
    variation_idx: int,
    model: str,
) -> TraceOutput:
    """OpenAI-compatible path: Gemini, DeepSeek, Groq, local llama-server, etc."""
    system_prompt = build_system_prompt(record.mode)
    user_prompt = build_user_prompt(record, variation_idx)
    max_tokens = DEFAULT_MAX_TOKENS_THINK if record.mode == "think" else DEFAULT_MAX_TOKENS_NO_THINK

    resp = client.chat.completions.create(
        model=model,
        max_tokens=max_tokens,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    )
    text = resp.choices[0].message.content or ""
    think_block, response = parse_response(text, record.mode)

    usage = getattr(resp, "usage", None)
    return TraceOutput(
        prompt=record.problem_text,
        mode=record.mode,
        think_block=think_block,
        response=response,
        source={"type": record.source_type, "ref": record.source_ref},
        code_refs=record.code_refs,
        difficulty=record.difficulty,
        generator_model=model,
        variation_idx=variation_idx,
        usage={
            "input": getattr(usage, "prompt_tokens", 0) if usage else 0,
            "output": getattr(usage, "completion_tokens", 0) if usage else 0,
            "cache_read": 0,
            "cache_write": 0,
        },
    )


# ---- cost preview ------------------------------------------------------------

def estimate_cost(n_calls: int, model: str) -> dict:
    """Rough estimate in USD. Assumes ~4k system prompt cached after call 1,
    ~1k user prompt uncached, ~5k output average."""
    if model not in PRICING:
        return {"total": None}
    p = PRICING[model]
    first_call_in = (4000 + 1000) / 1_000_000
    first_call_write_premium = 4000 / 1_000_000
    cached_in = 1000 / 1_000_000
    cached_read = 4000 / 1_000_000
    avg_out = 5000 / 1_000_000

    first_cost = (
        first_call_in * p["in"]
        + first_call_write_premium * (p["cache_write"] - p["in"])
        + avg_out * p["out"]
    )
    cached_cost = (
        cached_in * p["in"]
        + cached_read * p["cache_read"]
        + avg_out * p["out"]
    ) * max(n_calls - 1, 0)

    return {
        "per_call_avg_usd": (first_cost + cached_cost) / max(n_calls, 1),
        "total_usd": first_cost + cached_cost,
        "n_calls": n_calls,
    }


# ---- main --------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description="Generate reasoning traces from raw records.")
    ap.add_argument("--input", "-i", type=Path, required=True, help="raw_records.jsonl")
    ap.add_argument("--output", "-o", type=Path, help="traces.jsonl (required unless --preview)")
    ap.add_argument("--provider", default="anthropic",
                    choices=list(PROVIDERS.keys()),
                    help="Inference provider. 'gemini' = free tier via AI Studio.")
    ap.add_argument("--base-url", help="Override base URL for openai-compat providers")
    ap.add_argument("--api-key-env", help="Env var name holding the API key (overrides provider default)")
    ap.add_argument("--model", default=DEFAULT_MODEL,
                    help="Model id. For Anthropic: claude-opus-4-7 etc. For Gemini: gemini-2.5-flash. "
                         "For DeepSeek: deepseek-chat or deepseek-reasoner.")
    ap.add_argument("--effort", default=DEFAULT_EFFORT,
                    choices=["low", "medium", "high", "xhigh", "max"],
                    help="Anthropic only")
    ap.add_argument("--thinking", action="store_true",
                    help="Enable adaptive thinking (Anthropic only; default off since we're rationalizing)")
    ap.add_argument("--variations", type=int, default=1, help="Traces per source record")
    ap.add_argument("--limit", type=int, help="Only process first N records (smoke test)")
    ap.add_argument("--preview", action="store_true", help="Print cost estimate and exit")
    ap.add_argument("--yes", action="store_true", help="Skip cost-preview confirmation")
    ap.add_argument("--rpm", type=float, default=0,
                    help="Client-side rate limit (requests/minute). Useful for free-tier providers.")
    args = ap.parse_args()

    if not args.preview and not args.output:
        ap.error("--output required unless --preview")

    if not args.input.exists():
        print(f"[fatal] input not found: {args.input}", file=sys.stderr)
        return 2

    # Load and filter records
    records: list[RawRecord] = []
    with args.input.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            records.append(RawRecord.from_line(line))
    if args.limit:
        records = records[: args.limit]

    # Resumability
    completed = load_completed(args.output) if args.output else set()
    pending: list[tuple[RawRecord, int]] = []
    for rec in records:
        for v in range(args.variations):
            if (rec.source_ref, v) not in completed:
                pending.append((rec, v))

    # Cost preview
    est = estimate_cost(len(pending), args.model)
    print(f"\n=== Generation Plan ===", file=sys.stderr)
    print(f"  provider:       {args.provider}", file=sys.stderr)
    print(f"  model:          {args.model}", file=sys.stderr)
    if args.provider == "anthropic":
        print(f"  effort:         {args.effort}", file=sys.stderr)
        print(f"  thinking:       {'adaptive' if args.thinking else 'disabled'}", file=sys.stderr)
    print(f"  input records:  {len(records)}", file=sys.stderr)
    print(f"  variations:     {args.variations}", file=sys.stderr)
    print(f"  already done:   {len(completed)}", file=sys.stderr)
    print(f"  pending calls:  {len(pending)}", file=sys.stderr)
    if args.rpm:
        print(f"  rate limit:     {args.rpm} req/min "
              f"(~{len(pending) / args.rpm / 60:.1f} hours at full queue)", file=sys.stderr)
    if est.get("total_usd") is not None:
        if est["total_usd"] == 0:
            print(f"  est. cost:      $0.00 (free tier)", file=sys.stderr)
        else:
            print(f"  est. cost:      ${est['total_usd']:.2f} "
                  f"(${est['per_call_avg_usd']:.4f}/call avg)", file=sys.stderr)

    if args.preview:
        return 0
    if not pending:
        print("  nothing to do.", file=sys.stderr)
        return 0
    if not args.yes:
        print("\nProceed? [y/N] ", file=sys.stderr, end="", flush=True)
        if input().strip().lower() not in ("y", "yes"):
            print("aborted.", file=sys.stderr)
            return 1

    # Build client based on provider
    provider = PROVIDERS[args.provider]
    api_key_env = args.api_key_env or provider["api_key_env"]
    api_key = os.environ.get(api_key_env)
    if not api_key:
        print(f"[fatal] {api_key_env} not set in environment", file=sys.stderr)
        return 2

    if args.provider == "anthropic":
        try:
            import anthropic
        except ImportError:
            print("[fatal] anthropic SDK not installed. "
                  "Run with: uv run --with anthropic tools/trace_generate.py ...", file=sys.stderr)
            return 2
        client = anthropic.Anthropic(api_key=api_key)
    else:
        try:
            import openai
        except ImportError:
            print("[fatal] openai SDK not installed. "
                  "Run with: uv run --with openai tools/trace_generate.py ...", file=sys.stderr)
            return 2
        base_url = args.base_url or provider["base_url"]
        if base_url is None:
            print(f"[fatal] --base-url required for provider '{args.provider}'", file=sys.stderr)
            return 2
        client = openai.OpenAI(api_key=api_key, base_url=base_url)

    args.output.parent.mkdir(parents=True, exist_ok=True)

    # Rate limit
    min_interval = 60.0 / args.rpm if args.rpm > 0 else 0
    last_call_time = 0.0

    errors = 0
    totals = {"in": 0, "out": 0, "cache_read": 0, "cache_write": 0}
    t0 = time.time()

    with args.output.open("a", encoding="utf-8") as out:
        for i, (rec, v) in enumerate(pending, start=1):
            # Client-side rate limit
            if min_interval > 0:
                wait = min_interval - (time.time() - last_call_time)
                if wait > 0:
                    time.sleep(wait)
            last_call_time = time.time()

            try:
                if args.provider == "anthropic":
                    trace = generate_trace_anthropic(
                        client, rec, v,
                        model=args.model,
                        effort=args.effort,
                        thinking_enabled=args.thinking,
                    )
                else:
                    trace = generate_trace_openai_compat(
                        client, rec, v, model=args.model,
                    )
            except Exception as e:
                errors += 1
                print(f"  [{i}/{len(pending)}] ERROR ({rec.source_ref} v{v}): "
                      f"{type(e).__name__}: {e}", file=sys.stderr)
                if errors > 10:
                    print("[fatal] too many errors, aborting", file=sys.stderr)
                    return 3
                continue

            out.write(trace.to_json() + "\n")
            out.flush()
            for k in totals:
                totals[k] += trace.usage.get(k, 0)

            if i % 10 == 0 or i == len(pending):
                elapsed = time.time() - t0
                rate = i / elapsed if elapsed > 0 else 0
                eta_s = (len(pending) - i) / rate if rate > 0 else 0
                print(f"  [{i}/{len(pending)}] rate={rate:.1f}/s "
                      f"eta={eta_s/60:.1f}min "
                      f"in={totals['in']} out={totals['out']} "
                      f"cache_read={totals['cache_read']}",
                      file=sys.stderr)

    p = PRICING.get(args.model, {"in": 0, "out": 0, "cache_read": 0, "cache_write": 0})
    actual_cost = (
        totals["in"] / 1_000_000 * p["in"]
        + totals["out"] / 1_000_000 * p["out"]
        + totals["cache_read"] / 1_000_000 * p["cache_read"]
        + totals["cache_write"] / 1_000_000 * p["cache_write"]
    )
    print(f"\n=== Generation Summary ===", file=sys.stderr)
    print(f"  completed:  {len(pending) - errors}/{len(pending)}", file=sys.stderr)
    print(f"  errors:     {errors}", file=sys.stderr)
    print(f"  in tokens:  {totals['in']:,}", file=sys.stderr)
    print(f"  out tokens: {totals['out']:,}", file=sys.stderr)
    print(f"  cache hit:  {totals['cache_read']:,} tokens read from cache", file=sys.stderr)
    print(f"  actual $:   ${actual_cost:.2f}", file=sys.stderr)
    return 0 if errors == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
