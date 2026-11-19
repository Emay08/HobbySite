#!/usr/bin/env node
// Prompts for a password and prints a bcrypt hash for ADMIN_PASSWORD_HASH.
const bcrypt = require('bcryptjs');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
// Hide typed characters
rl._writeToOutput = function (s) {
  if (rl.stdoutMuted) rl.output.write('*');
  else rl.output.write(s);
};

rl.question('Password: ', async (pw) => {
  rl.close();
  process.stdout.write('\n');
  if (!pw || pw.length < 12) {
    console.error('Use at least 12 characters.');
    process.exit(1);
  }
  const hash = await bcrypt.hash(pw, 12);
  console.log('\nADMIN_PASSWORD_HASH=' + hash);
  console.log('\nTip: in a .env file, wrap it in single quotes so the $ signs survive.');
});
rl.stdoutMuted = true;
