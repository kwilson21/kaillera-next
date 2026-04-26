#!/usr/bin/env node
import fs from 'node:fs';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: patch-asyncify-counter.mjs <generated-js> [...]');
  process.exit(2);
}

const needle =
  'if(!reachedCallback){Asyncify.state=Asyncify.State.Unwinding;Asyncify.currData=Asyncify.allocateData();';
const replacement =
  'if(!reachedCallback){if(Module.__knAsyncifyCounter){try{Module.__knAsyncifyCounter({frame:Module.__knFrameNum|0,inStep:!!Module.__knInStep,stack:Asyncify.exportCallStack&&Asyncify.exportCallStack.slice?Asyncify.exportCallStack.slice(0):[]})}catch(_){}}Asyncify.state=Asyncify.State.Unwinding;Asyncify.currData=Asyncify.allocateData();';

let failed = false;
for (const file of files) {
  let js = fs.readFileSync(file, 'utf8');
  if (js.includes('Module.__knAsyncifyCounter')) {
    console.log(`    Asyncify counter already present: ${file}`);
    continue;
  }
  if (!js.includes(needle)) {
    console.error(`ERROR: Asyncify counter patch point not found in ${file}`);
    failed = true;
    continue;
  }
  js = js.replace(needle, replacement);
  fs.writeFileSync(file, js);
  console.log(`    Patched Asyncify yield counter: ${file}`);
}

if (failed) process.exit(1);
