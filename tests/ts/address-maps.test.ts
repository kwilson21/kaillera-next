import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { KNCore } from '../../web/src/index.ts';
import {
  ADDRESS_MAP_ORDER,
  addressMapFor,
  addressMapProblem,
  packAddressMap,
  ROM_ADDRESSES,
} from '../../web/src/address-maps.ts';

const SSB64_US = 'S15592e79d3c5295cef4371d4992f0bd25bec2102fc29644c93e682f7ea99ef3d';
const root = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

test('the pack order is the registry enum, entry for entry', () => {
  const header = read('build/kn_rollback/kn_hash_registry.h');
  const body = /enum \{\s*KN_MAP_STOCKS_BASE = 0,([\s\S]*?)KN_MAP_COUNT/.exec(header);
  assert.ok(body, 'KN_MAP_* enum not found in kn_hash_registry.h');
  const names = ['KN_MAP_STOCKS_BASE', ...[...(body[1] ?? '').matchAll(/KN_MAP_\w+/g)].map((m) => m[0])];
  const asEnum = (key: string) =>
    `KN_MAP_${key
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .toUpperCase()
      .replace('CSS_CHAR_ID', 'CSS_OFF_CHAR_ID')
      .replace('CSS_CURSOR_STATE', 'CSS_OFF_CURSOR_STATE')
      .replace('CSS_SELECTED_FLAG', 'CSS_OFF_SELECTED_FLAG')}`;
  assert.deepEqual(ADDRESS_MAP_ORDER.map(asEnum), names);
});

test("SSB64 US's map is the registry's built-in one", () => {
  // tests/hash-golden/test_hash_registry.py holds the same list and checks
  // it against the compiled registry and a RAM dump.
  const golden = read('tests/hash-golden/test_hash_registry.py');
  const list = /SSB64_MAP = \[([^\]]+)\]/.exec(golden);
  assert.ok(list, 'SSB64_MAP not found in the golden test');
  const builtIn = (list[1] ?? '').split(',').map((n) => Number(n.trim()));
  assert.deepEqual(addressMapFor(SSB64_US)?.values, builtIn);
  assert.equal(addressMapFor(SSB64_US)?.name, 'ssb64-us');
  assert.deepEqual(addressMapFor(SSB64_US)?.scenes, { characterSelect: 16, stageSelect: 21, battle: 22 });
});

test('a ROM with no map gets none', () => {
  assert.equal(addressMapFor('S7efec9e0983656bb0219a23c511cd1505a5f84d524e50ad4284dc1c7eb4d1403'), null);
  assert.equal(addressMapFor(null), null);
  assert.equal(addressMapFor(undefined), null);
  assert.equal(addressMapFor(''), null);
});

test('every map in the table is one the registry accepts', () => {
  for (const [hash, rom] of Object.entries(ROM_ADDRESSES)) {
    assert.match(hash, /^S[0-9a-f]{64}$/, `${rom.name}: key is not a ROM hash`);
    assert.equal(addressMapProblem(rom.map), null, rom.name);
    assert.equal(packAddressMap(rom.map).length, ADDRESS_MAP_ORDER.length);
  }
});

test('a map the registry would refuse is named', () => {
  const base = ROM_ADDRESSES[SSB64_US].map;
  assert.match(addressMapProblem({ ...base, sceneCurr: 0x800000 }) ?? '', /sceneCurr/);
  assert.match(addressMapProblem({ ...base, playerStride: 0x10000 }) ?? '', /playerStride/);
  assert.match(addressMapProblem({ ...base, vsBattleHeaderSize: 0 }) ?? '', /vsBattleHeaderSize/);
  assert.match(addressMapProblem({ ...base, rngSeed: 1.5 }) ?? '', /rngSeed/);
});

test('a map whose reads would run off the end of RDRAM is named', () => {
  const base = ROM_ADDRESSES[SSB64_US].map;
  // Each entry is in range on its own; the read it leads to is not.
  assert.match(addressMapProblem({ ...base, vsBattleHeader: 0x7ffff0 }) ?? '', /battle header/);
  assert.match(addressMapProblem({ ...base, cssBase: 0x7ffe00 }) ?? '', /cssCharId/);
  assert.match(addressMapProblem({ ...base, stocksBase: 0x7fff00 }) ?? '', /stock count/);
  assert.match(addressMapProblem({ ...base, rngSeed: 0x7ffffe }) ?? '', /rngSeed/);
  assert.equal(addressMapProblem({ ...base, rngSeed: 0x7ffffc }), null);
});

test('the plain-script pages reach it through KNCore', () => {
  assert.equal(KNCore.addressMapFor, addressMapFor);
});
