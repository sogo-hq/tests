/**
 * The room's handle, in one place at a time.
 *
 * t.me/vitalsofficial is dead and the room is t.me/vitals_official. A dead
 * handle is worse than a missing one: it is registerable, and a link on a
 * token page or in a card footer that lands on somebody else's room is a
 * handover of everyone who follows it. So the old handle is not allowed to
 * survive anywhere in the tree, including in a file nobody thinks of as code.
 *
 * The walk is the filesystem rather than the git index on purpose. The launch
 * config is untracked, because its salt decides the token address, and it is
 * the one file that puts a handle into the calldata.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/** Build output, dependencies and the records a laptop writes. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'coverage']);

const DEAD_HANDLE = 'vitalsofficial';
const ROOM_HANDLE = 'vitals_official';

function* files(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* files(join(dir, e.name));
    } else if (e.isFile()) {
      yield join(dir, e.name);
    }
  }
}

/** A NUL in the first chunk means it is not a file anybody typed a handle into. */
function text(path) {
  if (statSync(path).size > 4_000_000) return null;
  const buf = readFileSync(path);
  return buf.subarray(0, 8192).includes(0) ? null : buf.toString('utf8');
}

test('the dead room handle appears nowhere in the tree', () => {
  const hits = [];
  for (const path of files(ROOT)) {
    if (path.endsWith('room-handle.test.mjs')) continue;
    const body = text(path);
    if (body === null) continue;
    // The live handle contains the dead one as a substring only if read
    // carelessly: vitals_official does not, so a plain search is enough.
    if (!body.includes(DEAD_HANDLE)) continue;
    const line = body.split('\n').findIndex((l) => l.includes(DEAD_HANDLE)) + 1;
    hits.push(`${relative(ROOT, path)}:${line}`);
  }
  assert.deepEqual(hits, [], `t.me/${DEAD_HANDLE} is dead and still linked from:\n  ${hits.join('\n  ')}`);
});

test('the live handle is the one the four named places carry', async () => {
  const { GROUP_HANDLE } = await import('../dist/card.js');
  const { EXPECTED_SOCIALS } = await import('../dist/launchcheck.js');
  assert.equal(GROUP_HANDLE, ROOM_HANDLE);
  assert.equal(EXPECTED_SOCIALS.telegram, `t.me/${ROOM_HANDLE}`);
  assert.match(readFileSync(join(ROOT, 'docs', 'vitals.md'), 'utf8'), new RegExp(`https://t\\.me/${ROOM_HANDLE}\\b`));
  // HELP is module state rather than an export, and what it renders is
  // asserted where /help is driven. Here it is the line itself.
  assert.match(
    readFileSync(join(ROOT, 'src', 'bot.ts'), 'utf8'),
    new RegExp(`'@${ROOM_HANDLE}: every change lands here first'`),
  );
});
