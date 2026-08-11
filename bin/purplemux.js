#!/usr/bin/env node

// CLI 진입점에서는 부모 shell의 env를 이미 상속받은 상태라
// Electron의 login shell resolve 로직이 재동작할 필요가 없다.
process.env.PURPLEMUX_CLI = '1';

if (!process.env.__PMUX_PRISTINE_ENV) {
  process.env.__PMUX_PRISTINE_ENV = JSON.stringify(process.env);
}

const path = require('path');

const CLI_COMMANDS = new Set([
  'workspaces', 'tab', 'orchestration', 'standup', 'memory', 'mem', 'api-guide', 'help',
]);

import('update-notifier')
  .then(({ default: updateNotifier }) => {
    updateNotifier({ pkg: require('../package.json') }).notify();
  })
  .catch(() => {});

const cmd = process.argv[2];

if (cmd && CLI_COMMANDS.has(cmd)) {
  require('./cli.js');
} else if (!cmd || cmd === 'start') {
  process.env.NODE_ENV = process.env.NODE_ENV || 'production';
  process.env.__PMUX_APP_DIR = path.resolve(__dirname, '..');
  require('../dist/server.js');
} else {
  process.stderr.write(`unknown command: ${cmd}\nRun 'purplemux help' for usage.\n`);
  process.exit(1);
}
