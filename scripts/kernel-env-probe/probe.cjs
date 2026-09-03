// Loaded through NODE_OPTIONS=--require if the child honours it: leaves a marker naming the process.
const fs = require('node:fs');
fs.writeFileSync(process.env.GEOCODE_PROBE_MARKER, JSON.stringify({ pid: process.pid, type: process.type ?? null }));
