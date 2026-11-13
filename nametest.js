'use strict';

// Short-lived check: connect, announce our display name, and print the phone's
// real custom name once it arrives over DataChannel. Sends no file.
const { PairDropNode } = require('./client');
const cfg = require('./config');

const node = new PairDropNode();
const result = {
  nodeDisplayName: cfg.DISPLAY_NAME,
  peerOnline: false,
  channelOpen: false,
  announced: false,
  peerCustomName: null,
  initName: null
};

node.on('peer-online', info => {
  result.peerOnline = true;
  result.initName = info.name; // server-generated random name
});
node.on('ready', () => {
  result.channelOpen = true;
  result.announced = true;
});
node.on('peer-name', name => { result.peerCustomName = name; });

node.connect();

setTimeout(() => {
  console.log('\nNAME TEST RESULT\n' + JSON.stringify(result, null, 2));
  node.close();
  process.exit(0);
}, 9000);
