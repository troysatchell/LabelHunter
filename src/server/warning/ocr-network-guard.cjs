"use strict";

/**
 * A Node `--require` preload that makes every outbound HTTP/HTTPS call
 * throw (LH-020 / TRO-468, CP-2 §4.3's "startup test asserting recognition
 * works with the network disabled").
 *
 * `ocr-startup.test.ts` spawns a fresh `node` process with
 * `NODE_OPTIONS="--require <this file>"` and runs `runWarningOcr`'s exact
 * configuration in it. Node re-applies `NODE_OPTIONS` inside a
 * `worker_threads` worker too (confirmed empirically against tesseract.js
 * v7.0.0 during this ticket — the worker thread that actually loads
 * language data runs this same preload), which is why this file, not an
 * in-process `vi.stubGlobal`, is what proves the claim: tesseract.js's
 * Node loader does its network-capable work inside that worker thread,
 * not the main thread (`worker-script/node/index.js`).
 *
 * Deliberately does NOT block `node:net` — only `fetch`/`http`/`https`,
 * the actual functions tesseract.js's own loader calls
 * (`worker-script/index.js`: `const fetch = global.fetch || require('node-fetch')`).
 * A broader `net.connect` block also catches unrelated local-loopback
 * tooling (observed with `tsx`'s own internal IPC during this ticket) and
 * would make this guard a false positive for a network call that never
 * happens.
 */
const http = require("node:http");
const https = require("node:https");

function block(name) {
  return () => {
    throw new Error(`ocr-network-guard: network access blocked (${name} was called)`);
  };
}

globalThis.fetch = block("fetch");
http.request = block("http.request");
http.get = block("http.get");
https.request = block("https.request");
https.get = block("https.get");
