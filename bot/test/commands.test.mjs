/**
 * /help against the handlers it describes.
 *
 * Checked in both directions: a command registered with no entry in the table
 * fails here, and an entry for a command nobody registers fails here too. That
 * is the whole reason the table exists, so it is the first thing tested.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMMANDS, commandLine, commandList, registeredNames, groupsInOrder } from '../dist/commands.js';

const SRC = readFileSync('src/bot.ts', 'utf8');

/** Every name passed to bot.command(), including the array form. */
const registered = (() => {
  const names = new Set();
  for (const m of SRC.matchAll(/bot\.command\(\s*(\[[^\]]*\]|'[a-z]+')/g)) {
    for (const n of m[1].matchAll(/'([a-z]+)'/g)) names.add(n[1]);
  }
  return names;
})();

test('the bot registers the commands this thinks it does', () => {
  assert.ok(registered.size >= 30, `only found ${registered.size} registrations`);
});

test('every registered command has a line in /help', () => {
  const described = new Set(registeredNames());
  const missing = [...registered].filter((n) => !described.has(n)).sort();
  assert.deepEqual(missing, [], `registered but absent from /help: ${missing.join(', ')}`);
});

test('every line in /help is a command the bot registers', () => {
  const extra = registeredNames().filter((n) => !registered.has(n)).sort();
  assert.deepEqual(extra, [], `in /help but not registered: ${extra.join(', ')}`);
});

test('no command is described twice', () => {
  const names = registeredNames();
  assert.equal(new Set(names).size, names.length, 'a command appears twice in the table');
});

// ----------------------------------------------------------- what it says

test('every entry has a usage shape and exactly one line of what', () => {
  for (const c of COMMANDS) {
    assert.ok(c.what.trim().length > 0, `/${c.name} has no description`);
    assert.ok(!c.what.includes('\n'), `/${c.name} takes two lines`);
    assert.ok(c.what.length <= 100, `/${c.name} is ${c.what.length} characters`);
    // An argument is named in angle brackets or not at all: a usage string
    // like "address" tells nobody whether it is optional. A bare word is
    // allowed only when it is a literal subcommand the handler branches on,
    // which is checked against the source rather than taken on trust.
    if (c.usage && !/^\(/.test(c.usage) && !/[<[|]/.test(c.usage)) {
      assert.match(SRC, new RegExp(`(sub|lsub) === '${c.usage}'`),
        `/${c.name} usage "${c.usage}" is neither an argument shape nor a subcommand the handler reads`);
    }
  }
});

test('a line is the command, its usage, its marks, then what it does', () => {
  const scan = COMMANDS.find((c) => c.name === 'scan');
  assert.equal(commandLine(scan), '/scan <token address>\n    the card: what the chain shows about one launch');
});

test('admin commands are marked, and shown rather than hidden', () => {
  const help = commandList();
  for (const c of COMMANDS.filter((x) => x.scope === 'admin')) {
    assert.ok(help.includes(`/${c.name}`), `/${c.name} is hidden from /help`);
    assert.match(commandLine(c), /· admin/, `/${c.name} is not marked`);
  }
  // And a command anyone can run is not marked as one they cannot.
  for (const c of COMMANDS.filter((x) => x.scope === 'all')) {
    assert.doesNotMatch(commandLine(c), /· admin/, `/${c.name} is marked admin and is not`);
  }
});

test('the commands that only answer in a DM say so', () => {
  for (const name of ['holder', 'premium', 'export', 'declare', 'status', 'scout', 'feed']) {
    const c = COMMANDS.find((x) => x.name === name);
    assert.equal(c.where, 'dm', `/${name} answers in a DM only and does not say so`);
    assert.match(commandLine(c), /· DM/);
  }
});

test('the admin list matches the handlers that check isAdmin', () => {
  // Every handler whose first lines refuse a non-admin, read out of the source.
  const gated = new Set();
  for (const m of SRC.matchAll(/bot\.command\(\s*'([a-z]+)',[^\n]*\n(?:[^\n]*\n){0,2}?[^\n]*!isAdmin/g)) {
    gated.add(m[1]);
  }
  assert.ok(gated.size >= 10, `only found ${gated.size} admin-gated handlers`);
  const table = new Set(COMMANDS.filter((c) => c.scope === 'admin').map((c) => c.name));
  const unmarked = [...gated].filter((n) => !table.has(n)).sort();
  assert.deepEqual(unmarked, [], `gated on isAdmin but not marked admin in /help: ${unmarked.join(', ')}`);
});

// -------------------------------------------------------------- the render

test('the list groups the commands and keeps the table order', () => {
  const help = commandList();
  const headings = groupsInOrder();
  assert.ok(headings.length >= 5);
  let at = -1;
  for (const g of headings) {
    const i = help.indexOf(`${g}:`);
    assert.ok(i > at, `${g} is out of order`);
    at = i;
  }
});

test('it is plain text: no markup, no entities, no em dash', () => {
  const help = commandList();
  assert.doesNotMatch(help, /<\/?(b|i|u|s|a|em|strong|code|pre|span)\b[^>]*>/i);
  assert.doesNotMatch(help, /&(amp|lt|gt|quot);/);
  assert.doesNotMatch(help, /!/);
  assert.ok(!help.includes(String.fromCharCode(0x2014)));
  // The angle brackets in a usage string are the ones people type.
  assert.ok(help.includes('/scan <token address>'));
});

test('it says nothing a card is not allowed to say', () => {
  const help = commandList();
  assert.doesNotMatch(help, /\bclean\b|\bsafe\b|looks good|\bscore\b|\bgrade\b|price target/i);
});

test('the whole message fits in one Telegram message', async () => {
  const { TELEGRAM_MAX_MESSAGE } = await import('../dist/text.js');
  assert.ok(commandList().length < TELEGRAM_MAX_MESSAGE * 0.8,
    `the command list alone is ${commandList().length} of ${TELEGRAM_MAX_MESSAGE}`);
});

test('the commands added this month are in it', () => {
  // The three that existed before anybody wrote them down, which is what the
  // table is for.
  for (const name of ['position', 'status', 'premium']) {
    assert.ok(registeredNames().includes(name), `/${name} is missing from /help`);
  }
  assert.match(COMMANDS.find((c) => c.name === 'premium').usage, /status/);
});

// --------------------------------------------------- the rendered message

/**
 * /help as a user actually receives it, notice and all.
 *
 * A fresh database every time: the launch notice is claimed once per user, so
 * a database left over from the last run would drop it from the measurement
 * and hide exactly the case this is measuring.
 */
const renderHelp = async () => {
  const { freshDb } = await import('./tmpdb.mjs');
  process.env.DB_PATH = freshDb('help-render');
  process.env.LAUNCH_NOTICE = '$VITALS, the first declared launch on pons: 24 Sep · t.me/vitalsofficial';
  const { createBot } = await import('../dist/bot.js');
  const bot = createBot('1:FAKE');
  bot.botInfo = {
    id: 42, is_bot: true, first_name: 'V', username: 'vitalscheck_bot',
    can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true,
  };
  const sent = [];
  bot.api.config.use(async (_p, m, pl) => {
    if (m === 'sendMessage') sent.push(pl.text);
    return { ok: true, result: { message_id: 1, chat: { id: 1 }, date: 0 } };
  });
  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 1, date: 0, chat: { id: 5, type: 'private', first_name: 'A' },
      from: { id: 5, is_bot: false, first_name: 'A' }, text: '/help',
      entities: [{ type: 'bot_command', offset: 0, length: 5 }],
    },
  });
  return sent[0];
};

test('the whole of /help reaches the user in one message', async () => {
  const { TELEGRAM_MAX_MESSAGE } = await import('../dist/text.js');
  const help = await renderHelp();
  // With the launch notice appended, which is the longest it ever is. A
  // message one character over the limit is not a truncated /help, it is no
  // /help at all, and the list grows every time a command is added.
  assert.ok(help.length <= TELEGRAM_MAX_MESSAGE,
    `/help is ${help.length} of ${TELEGRAM_MAX_MESSAGE}`);
  assert.ok(help.includes('24 Sep'), 'the notice is in the measurement');
  assert.ok(!help.endsWith('…'), '/help was clamped, so something was cut');
  assert.ok(help.length <= TELEGRAM_MAX_MESSAGE - 100,
    `only ${TELEGRAM_MAX_MESSAGE - help.length} characters of headroom: trim the prose, not the table`);
});

test('every command in the table appears in the message a user gets', async () => {
  const help = await renderHelp();
  for (const c of COMMANDS) {
    assert.ok(help.includes(`/${c.name}`), `/${c.name} never reached the user`);
  }
});
