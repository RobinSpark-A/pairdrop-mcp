'use strict';

// Shared auto-exit policy. Used by one-shot CLIs and by daemon.js.
// The connection stays alive after a successful transfer; the process exits
// when:
//   - no activity for idleMs
//   - the peer stays offline for disconnectMs
//   - maxMs is reached (hard cap, never leave an orphan process)
//
// suspend()/resume() let daemon.js guarantee it NEVER exits while an HTTP
// request is still hanging and waiting for its result.
// opts are overridable so the offline unit test runs in milliseconds.

const cfg = require('./config');
const { log } = require('./log');

function attachExitPolicy(node, onExit, opts = {}) {
  const idleMs = opts.idleMs || cfg.POST_TRANSFER_KEEPALIVE_MS;
  const disconnectMs = opts.disconnectMs || cfg.DISCONNECT_GRACE_MS;
  const maxMs = opts.maxMs || cfg.MAX_SESSION_MS;

  let armed = false;
  let exiting = false;
  let offline = false;
  let suspended = false;
  let idleTimer = null;
  let offlineTimer = null;
  let hardTimer = null;

  function clearAll() {
    if (idleTimer) clearTimeout(idleTimer);
    if (offlineTimer) clearTimeout(offlineTimer);
    if (hardTimer) clearTimeout(hardTimer);
    idleTimer = offlineTimer = hardTimer = null;
  }

  function armIdle() {
    if (exiting || !armed || suspended) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (offline) return; // the disconnect grace timer owns the countdown
    idleTimer = setTimeout(() => exit('idle timeout'), idleMs);
  }

  function exit(reason) {
    if (exiting) return;
    // onExit may veto (daemon still has a pending HTTP request).
    if (onExit(reason) === false) {
      log('auto-exit deferred: ' + reason);
      armIdle(); // no-op while suspended; resume() will re-arm
      return;
    }
    exiting = true;
    clearAll();
    log('auto-exit: ' + reason);
  }

  function activity(label) {
    if (exiting || suspended) return;
    armed = true;
    if (hardTimer) clearTimeout(hardTimer);
    hardTimer = setTimeout(() => exit('max session reached'), maxMs);
    log('activity: ' + label);
    armIdle();
  }

  function suspend() {
    if (exiting) return;
    suspended = true;
    clearAll(); // absolutely no exit while a caller waits for its result
  }

  function resume(label) {
    if (exiting) return;
    suspended = false;
    activity(label || 'resume');
  }

  node.on('peer-offline', () => {
    if (!armed || exiting || suspended) return;
    offline = true;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (offlineTimer) clearTimeout(offlineTimer);
    offlineTimer = setTimeout(() => exit('peer stayed offline'), disconnectMs);
    log('peer offline; grace period started');
  });

  node.on('peer-online', () => {
    if (!armed || exiting || suspended) return;
    offline = false;
    if (offlineTimer) clearTimeout(offlineTimer);
    offlineTimer = null;
    log('peer online again');
    armIdle();
  });

  // daemon starts armed so it also exits if nobody ever sends a request.
  if (opts.startArmed) activity('policy armed at start');

  return {
    activity: activity,
    exit: reason => exit(reason || 'explicit exit'),
    suspend: suspend,
    resume: resume,
    isArmed: () => armed,
    isSuspended: () => suspended
  };
}

module.exports = { attachExitPolicy };
