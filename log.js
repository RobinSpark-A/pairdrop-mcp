'use strict';

const fs = require('fs');
const cfg = require('./config');

function write(level, msg) {
  const line = '[' + new Date().toISOString() + '] ' + level + ' ' + msg + '\n';
  try {
    fs.appendFileSync(cfg.LOG_FILE, line);
  } catch (_) {
    // logging must never break the transfer
  }
  if (level === 'ERROR') console.error(line.trim());
  else console.log(line.trim());
}

module.exports = {
  log: m => write('INFO', m),
  warn: m => write('WARN', m),
  error: m => write('ERROR', m)
};
