import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import crypto from 'node:crypto';
const source = await fs.readFile('server/index.js', 'utf8');
const start = source.indexOf('function authorized(');
const end = source.indexOf('/** A short label', start);
const context = { cluster: null, TOKEN: 'local-test-token', crypto, Buffer };
vm.createContext(context);
vm.runInContext(source.slice(start, end), context);
const allowed = (ip, headers = {}) => context.authorized({ socket: { remoteAddress: ip }, headers }, new URL('http://localhost/'));
for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
  assert.equal(allowed(ip, { 'tailscale-user-login': 'phone@example.test' }), true);
  assert.equal(allowed(ip), false);
}
for (const ip of ['192.168.1.3', '100.100.1.2', '203.0.113.3']) {
  assert.equal(allowed(ip, { 'tailscale-user-login': 'forged', 'x-forwarded-for': '127.0.0.1' }), false);
  assert.equal(allowed(ip, { 'x-harness-token': 'local-test-token' }), true);
}
console.log('PASS private Serve phone access needs no token; remote spoofing is rejected and existing tokens still work');
