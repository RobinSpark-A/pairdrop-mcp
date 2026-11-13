'use strict';

// One command does everything on a new machine:
//   node setup.js 123456 --name "书房电脑"
//   node setup.js --name "书房电脑"          (no code: node generates one)
//   node setup.js 123456                    (auto-generated display name)
//
// Dependencies, free port, inbox folder and secret.txt are all automatic.
// The 6-digit pairing code is the only human step.

const bootstrap = require('./bootstrap');
const cfg = require('./config');

const argv = process.argv.slice(2);
let code = null;
let displayName = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--name' || argv[i] === '-n') {
    displayName = argv[++i] || null;
  } else if (!argv[i].startsWith('-')) {
    code = argv[i];
  }
}

(async () => {
  const ready = await bootstrap.ensureReady({ displayName: displayName });
  console.log('自动配置完成: ' + JSON.stringify(ready));

  if (ready.paired) {
    console.log('检测到已有配对，跳过配对步骤。');
  } else if (code) {
    console.log('使用手机端配对码 ' + code + ' ...');
    const result = await bootstrap.runPairing({ code: code.trim() });
    console.log('配对完成 (' + result.mode + ')');
  } else {
    console.log('未传入手机端配对码，改由本程序生成：');
    const result = await bootstrap.runPairing({
      onCode: c => console.log('\n  >>> 在手机 PairDrop 点「配对设备」输入：' + c + ' <<<\n')
    });
    console.log('配对完成 (' + result.mode + ')');
  }

  const check = await bootstrap.selfCheck(3000);
  console.log('READY ' + JSON.stringify(Object.assign({
    displayName: cfg.DISPLAY_NAME,
    port: cfg.CONTROL_PORT,
    inbox: cfg.INBOX_DIR
  }, check)));
  process.exit(0);
})().catch(err => {
  console.error('SETUP FAILED ' + err.message);
  process.exit(1);
});
