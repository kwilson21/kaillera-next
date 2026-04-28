#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const HEADER_SIZE = 16;
const RDRAM_SIZE = 8 * 1024 * 1024;
const RDRAM_STATE_START = HEADER_SIZE;
const RDRAM_STATE_END = HEADER_SIZE + RDRAM_SIZE;
const DEFAULT_DIR = '/tmp';
const DEFAULT_BAND_GAP = 64;
const DEFAULT_TOP = 12;

function argValue(name, fallback = null) {
  const exact = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return fallback;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function hex(n) {
  return `0x${(n >>> 0).toString(16)}`;
}

function hex64(n) {
  return `0x${Number(n).toString(16)}`;
}

function segmentForOffset(offset) {
  if (offset < HEADER_SIZE) return 'header';
  if (offset < RDRAM_STATE_END) return 'rdram';
  return 'sidecar';
}

function rdramOffset(offset) {
  if (offset < RDRAM_STATE_START || offset >= RDRAM_STATE_END) return null;
  return offset - RDRAM_STATE_START;
}

function n64Address(offset) {
  const rel = rdramOffset(offset);
  if (rel === null) return null;
  return 0x80000000 + rel;
}

function formatOffset(offset) {
  const seg = segmentForOffset(offset);
  const rel = rdramOffset(offset);
  const n64 = n64Address(offset);
  return {
    offset,
    offsetHex: hex64(offset),
    segment: seg,
    rdramOffsetHex: rel === null ? null : hex64(rel),
    n64AddressHex: n64 === null ? null : hex64(n64),
  };
}

function spansFromOffsets(offsets, maxGap = 0) {
  const spans = [];
  let start = -1;
  let end = -1;
  let diffBytes = 0;

  for (const offset of offsets) {
    if (start < 0) {
      start = offset;
      end = offset;
      diffBytes = 1;
    } else if (offset <= end + maxGap + 1) {
      end = offset;
      diffBytes += 1;
    } else {
      spans.push({ start, end, width: end - start + 1, diffBytes });
      start = offset;
      end = offset;
      diffBytes = 1;
    }
  }

  if (start >= 0) spans.push({ start, end, width: end - start + 1, diffBytes });
  return spans;
}

function formatSpan(span) {
  const start = formatOffset(span.start);
  const end = formatOffset(span.end);
  return {
    ...span,
    startHex: start.offsetHex,
    endHex: end.offsetHex,
    segment: start.segment === end.segment ? start.segment : `${start.segment}->${end.segment}`,
    rdramStartHex: start.rdramOffsetHex,
    rdramEndHex: end.rdramOffsetHex,
    n64StartHex: start.n64AddressHex,
    n64EndHex: end.n64AddressHex,
  };
}

function summarizeDiff(a, b, { bandGap = DEFAULT_BAND_GAP, top = DEFAULT_TOP } = {}) {
  if (!a || !b) return null;
  const minLen = Math.min(a.length, b.length);
  const offsets = [];
  const bySegment = { header: 0, rdram: 0, sidecar: 0, lengthOnly: Math.abs(a.length - b.length) };

  for (let i = 0; i < minLen; i += 1) {
    if (a[i] === b[i]) continue;
    offsets.push(i);
    bySegment[segmentForOffset(i)] += 1;
  }

  const exactSpans = spansFromOffsets(offsets, 0);
  const bands = spansFromOffsets(offsets, bandGap);
  const topExactSpans = exactSpans
    .slice()
    .sort((x, y) => y.diffBytes - x.diffBytes || y.width - x.width)
    .slice(0, top)
    .map(formatSpan);
  const topBands = bands
    .slice()
    .sort((x, y) => y.diffBytes - x.diffBytes || y.width - x.width)
    .slice(0, top)
    .map(formatSpan);

  return {
    sizeA: a.length,
    sizeB: b.length,
    lengthDelta: b.length - a.length,
    diffBytes: offsets.length + Math.abs(a.length - b.length),
    diffRatio: minLen > 0 ? offsets.length / minLen : 0,
    firstDiff: offsets.length ? formatOffset(offsets[0]) : null,
    bySegment,
    exactSpanCount: exactSpans.length,
    bandGap,
    bandCount: bands.length,
    firstDiffs: offsets.slice(0, top).map((offset) => ({
      ...formatOffset(offset),
      a: a[offset],
      b: b[offset],
    })),
    topExactSpans,
    topBands,
    offsets,
  };
}

function printableSummary(summary) {
  const { offsets: _offsets, ...rest } = summary;
  return rest;
}

function discoverSamples(dir) {
  const roomMap = new Map();
  const fileRe = /^startup-state-(.+)-(host|guest)\.bin$/;
  for (const file of fs.readdirSync(dir)) {
    const match = file.match(fileRe);
    if (!match) continue;
    const [, room, side] = match;
    if (!roomMap.has(room)) roomMap.set(room, { room });
    roomMap.get(room)[side] = path.join(dir, file);
  }

  return Array.from(roomMap.values())
    .filter((entry) => entry.host && entry.guest)
    .sort((a, b) => a.room.localeCompare(b.room));
}

function loadProbeReport(dir, room) {
  const candidates = [path.join(dir, `startup-state-${room}-probe.json`), path.join(dir, 'startup-state-probe.json')];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (parsed?.room !== room) continue;
      return {
        path: candidate,
        verdict: parsed.verdict || null,
        hostFrame: parsed.host?.kn?.frame ?? null,
        guestFrame: parsed.guest?.kn?.frame ?? null,
        hostCoreFrame: parsed.host?.module?.coreFrame ?? null,
        guestCoreFrame: parsed.guest?.module?.coreFrame ?? null,
        coreFrameDelta:
          typeof parsed.host?.module?.coreFrame === 'number' && typeof parsed.guest?.module?.coreFrame === 'number'
            ? parsed.host.module.coreFrame - parsed.guest.module.coreFrame
            : null,
        setupDiffs: parsed.sidecars?.setup?.diffs?.length ?? null,
        hiddenDiffs: parsed.sidecars?.hiddenDiff?.diffCount ?? null,
        audioFifoDiffs: parsed.sidecars?.audioFifoDiff?.diffCount ?? null,
      };
    } catch (_) {
      // Ignore malformed reports; the raw bin files are enough to analyze.
    }
  }
  return null;
}

function commonDiffAnalysis(samples, summaries) {
  if (!samples.length) return null;
  const common = [];
  const first = summaries[0].pair.offsets;
  const sets = summaries.map((summary) => new Set(summary.pair.offsets));

  for (const offset of first) {
    if (sets.every((set) => set.has(offset))) common.push(offset);
  }

  const stableRoleOffsets = [];
  const volatileCommonOffsets = [];
  for (const offset of common) {
    const host0 = samples[0].hostBytes[offset];
    const guest0 = samples[0].guestBytes[offset];
    const stableRole = samples.every(
      (sample) => sample.hostBytes[offset] === host0 && sample.guestBytes[offset] === guest0 && host0 !== guest0,
    );
    if (stableRole) stableRoleOffsets.push(offset);
    else volatileCommonOffsets.push(offset);
  }

  return {
    commonDiffBytes: common.length,
    commonSpans: spansFromOffsets(common, 0).map(formatSpan),
    stableRoleBytes: stableRoleOffsets.length,
    stableRoleSpans: spansFromOffsets(stableRoleOffsets, 0).map(formatSpan),
    volatileCommonBytes: volatileCommonOffsets.length,
    volatileCommonSpans: spansFromOffsets(volatileCommonOffsets, 0).map(formatSpan),
    commonSamples: common.slice(0, 32).map((offset) => ({
      ...formatOffset(offset),
      values: Object.fromEntries(
        samples.map((sample) => [
          sample.room,
          {
            host: sample.hostBytes[offset],
            guest: sample.guestBytes[offset],
          },
        ]),
      ),
    })),
  };
}

function crossRunSummaries(samples, opts) {
  if (samples.length < 2) return [];
  const base = samples[0];
  const out = [];
  for (const sample of samples.slice(1)) {
    out.push({
      side: 'host',
      a: base.room,
      b: sample.room,
      diff: printableSummary(summarizeDiff(base.hostBytes, sample.hostBytes, opts)),
    });
    out.push({
      side: 'guest',
      a: base.room,
      b: sample.room,
      diff: printableSummary(summarizeDiff(base.guestBytes, sample.guestBytes, opts)),
    });
  }
  return out;
}

function pct(n) {
  return `${(n * 100).toFixed(4)}%`;
}

function shortSpan(span) {
  const where =
    span.segment === 'rdram' && span.n64StartHex
      ? `${span.startHex}-${span.endHex} ${span.n64StartHex}-${span.n64EndHex}`
      : `${span.startHex}-${span.endHex}`;
  return `${where} ${span.segment} bytes=${span.diffBytes} width=${span.width}`;
}

function printReport(report) {
  console.log('Startup state diff analysis');
  console.log(`dir: ${report.dir}`);
  console.log(`rooms: ${report.rooms.join(', ')}`);

  for (const sample of report.samples) {
    const d = sample.hostVsGuest;
    console.log(
      `\n${sample.room} host-vs-guest: ${d.diffBytes}/${d.sizeA} bytes (${pct(d.diffRatio)}) ` +
        `exactSpans=${d.exactSpanCount} bands=${d.bandCount}`,
    );
    console.log(
      `  segments: header=${d.bySegment.header} rdram=${d.bySegment.rdram} ` +
        `sidecar=${d.bySegment.sidecar} lengthOnly=${d.bySegment.lengthOnly}`,
    );
    if (sample.probe) {
      console.log(
        `  probe: verdict=${sample.probe.verdict} frame=${sample.probe.hostFrame}/${sample.probe.guestFrame} ` +
          `coreFrame=${sample.probe.hostCoreFrame}/${sample.probe.guestCoreFrame} ` +
          `coreDelta=${sample.probe.coreFrameDelta}`,
      );
    }
    if (d.firstDiff) {
      console.log(
        `  first: ${d.firstDiff.offsetHex} ${d.firstDiff.segment}` +
          (d.firstDiff.n64AddressHex ? ` n64=${d.firstDiff.n64AddressHex}` : ''),
      );
    }
    for (const span of d.topBands.slice(0, 6)) {
      console.log(`  band: ${shortSpan(span)}`);
    }
  }

  if (report.common) {
    console.log(
      `\nCommon host/guest diff offsets across all rooms: ${report.common.commonDiffBytes} ` +
        `(stable role-specific: ${report.common.stableRoleBytes})`,
    );
    for (const span of report.common.commonSpans.slice(0, 12)) {
      console.log(`  common: ${shortSpan(span)}`);
    }
  }

  if (report.crossRun.length) {
    console.log('\nCross-run volatility against first room:');
    for (const item of report.crossRun) {
      console.log(
        `  ${item.side} ${item.a}->${item.b}: ${item.diff.diffBytes}/${item.diff.sizeA} ` +
          `(${pct(item.diff.diffRatio)}) bands=${item.diff.bandCount}`,
      );
    }
  }

  console.log('\nSignals:');
  for (const signal of report.signals) console.log(`  ${signal}`);
}

const dir = path.resolve(argValue('--dir', DEFAULT_DIR));
const jsonOut = argValue('--json', null);
const bandGap = Number(argValue('--band-gap', `${DEFAULT_BAND_GAP}`));
const top = Number(argValue('--top', `${DEFAULT_TOP}`));
const opts = { bandGap, top };

const discovered = discoverSamples(dir);
if (!discovered.length) {
  console.error(`No startup-state host/guest bin pairs found in ${dir}`);
  process.exit(1);
}

const samples = discovered.map((sample) => ({
  ...sample,
  hostBytes: fs.readFileSync(sample.host),
  guestBytes: fs.readFileSync(sample.guest),
  probe: loadProbeReport(dir, sample.room),
}));

const summaries = samples.map((sample) => ({
  room: sample.room,
  host: sample.host,
  guest: sample.guest,
  hostSize: sample.hostBytes.length,
  guestSize: sample.guestBytes.length,
  hostSha256: sha256(sample.hostBytes),
  guestSha256: sha256(sample.guestBytes),
  probe: sample.probe,
  pair: summarizeDiff(sample.hostBytes, sample.guestBytes, opts),
}));

const common = commonDiffAnalysis(samples, summaries);
const report = {
  dir,
  rooms: samples.map((sample) => sample.room),
  samples: summaries.map((summary) => ({
    room: summary.room,
    host: summary.host,
    guest: summary.guest,
    hostSize: summary.hostSize,
    guestSize: summary.guestSize,
    hostSha256: summary.hostSha256,
    guestSha256: summary.guestSha256,
    probe: summary.probe,
    hostVsGuest: printableSummary(summary.pair),
  })),
  common,
  crossRun: crossRunSummaries(samples, opts),
  signals: [],
};

const pairDiffs = summaries.map((summary) => summary.pair.diffBytes);
const minPairDiff = Math.min(...pairDiffs);
const maxPairDiff = Math.max(...pairDiffs);
if (common?.stableRoleBytes === 0) {
  report.signals.push('No stable role-specific host/guest byte pattern was found across these captures.');
}
if (minPairDiff > 0 && maxPairDiff / minPairDiff > 100) {
  report.signals.push(
    `Host/guest diff volume varies widely (${minPairDiff}..${maxPairDiff} bytes), which points at capture timing or volatile runtime state before C patching.`,
  );
}
if (summaries.some((summary) => summary.probe?.coreFrameDelta && summary.probe.coreFrameDelta !== 0)) {
  report.signals.push(
    'At least one probe captured peers at different coreFrame counts; align or classify this before trusting full-state byte diffs.',
  );
}
if (summaries.some((summary) => summary.pair.bySegment.rdram > 0)) {
  report.signals.push(
    'Most observed differences are inside RDRAM, so the next pass should map RDRAM offsets to gameplay/video/audio/OS regions.',
  );
}

printReport(report);

if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));
  console.log(`\nJSON report: ${jsonOut}`);
}
