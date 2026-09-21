#!/usr/bin/env node
// Test-only installed-client substitute; never contacts a real tailnet.
import fs from 'node:fs';
const state = process.env.HARNESS_TEST_TAILSCALE_STATE;
process.stdout.write(JSON.stringify({ BackendState: state ? fs.readFileSync(state, 'utf8').trim() : 'Running' }));
