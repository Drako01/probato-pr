// Preloaded into the measured CLI process by scripts/perf-real.mjs. Records the peak resident set size of the whole
// Node process (main thread and the analysis worker thread) when it exits. Git child processes are not included.
'use strict';
const { writeFileSync } = require('node:fs');

const target = process.env.PROBATO_RSS_FILE;
if (target) {
  process.on('exit', () => {
    writeFileSync(target, String(process.resourceUsage().maxRSS * 1024));
  });
}
