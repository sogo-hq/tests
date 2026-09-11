/**
 * The deploy entry point.
 *
 * A deploy came up, printed the CLI help and exited 0, because the platform's
 * default start command is `npm start` and that ran `node dist/index.js` with
 * no argument, which is the help branch. Nothing was broken and nothing said
 * so: the container simply exited successfully, forever.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

test('the platform start command runs the bot, not the help text', () => {
  const railway = JSON.parse(readFileSync('railway.json', 'utf8'));
  assert.equal(railway.deploy.startCommand, 'npm run bot');
  // And `npm start` too, so the same mistake cannot be made by any other
  // platform whose default is `npm start`.
  assert.equal(pkg.scripts.start, 'node dist/index.js bot');
});

test('node is pinned to 22', () => {
  // better-sqlite3 aborts at exit on Node 24 in this project. Unpinned, the
  // platform picks whatever is newest.
  assert.match(pkg.engines.node, /^22/);
  assert.match(process.version, /^v22\./, `running on ${process.version}`);
});

test('the argument-less CLI still prints help, and exits cleanly', () => {
  const out = execFileSync(process.execPath, ['dist/index.js'], { encoding: 'utf8' });
  assert.match(out, /pons v2 launch scanner/);
  assert.match(out, /npm run bot\s+start the Telegram bot/);
});
