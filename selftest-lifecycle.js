'use strict';

// Offline unit test for the post-transfer lifecycle. Timeouts are overridden
// to milliseconds so all exit paths are checked in under a second.
const assert = require('assert');
const EventEmitter = require('events');
const { attachExitPolicy } = require('./keepalive');

const opts = { idleMs: 120, disconnectMs: 80, maxMs: 600 };

function scenario(name, drive) {
  return new Promise((resolve, reject) => {
    const node = new EventEmitter();
    const guard = setTimeout(() => reject(new Error(name + ': never exited')), 2000);
    const policy = attachExitPolicy(node, reason => {
      clearTimeout(guard);
      resolve(reason);
    }, opts);
    drive(node, policy);
  });
}

(async () => {
  let reason = await scenario('idle', (node, policy) => {
    policy.activity('send complete');
  });
  assert.strictEqual(reason, 'idle timeout');
  console.log('case 1: idle timeout OK');

  reason = await scenario('offline', (node, policy) => {
    policy.activity('send complete');
    node.emit('peer-offline');
  });
  assert.strictEqual(reason, 'peer stayed offline');
  console.log('case 2: disconnect grace OK');

  reason = await scenario('reconnect', (node, policy) => {
    policy.activity('send complete');
    node.emit('peer-offline');
    setTimeout(() => node.emit('peer-online'), 30);
  });
  assert.strictEqual(reason, 'idle timeout');
  console.log('case 3: reconnect cancels the grace timer OK');

  reason = await scenario('activity-reset', (node, policy) => {
    policy.activity('first');
    setTimeout(() => policy.activity('second'), 80);
  });
  assert.strictEqual(reason, 'idle timeout');
  console.log('case 4: new activity resets the idle timer OK');

  reason = await scenario('explicit', (node, policy) => {
    policy.activity('send complete');
    policy.exit('send failed');
  });
  assert.strictEqual(reason, 'send failed');
  console.log('case 5: explicit exit wins OK');

  reason = await scenario('suspend', (node, policy) => {
    policy.activity('request started');
    policy.suspend();              // daemon must not exit while a request hangs
    node.emit('peer-offline');      // ignored while suspended
    setTimeout(() => policy.resume('request complete'), 150);
  });
  assert.strictEqual(reason, 'idle timeout');
  console.log('case 6: suspend/resume (daemon pending request) OK');

  console.log('\nLIFECYCLE SELFTEST PASSED');
  process.exit(0);
})().catch(err => {
  console.error('LIFECYCLE SELFTEST FAILED: ' + err.message);
  process.exit(1);
});
