/**
 * Every command, once.
 *
 * /help used to be a prose block maintained by hand beside thirty-five
 * handlers, which meant it was wrong the moment anybody added one: /position,
 * /status and /premium status all existed before they were written down, and
 * three of the lines in it described arguments that had changed.
 *
 * This is the table. /help renders it, and a test checks it against the
 * registrations in bot.ts in both directions: a command with no entry fails
 * the build, and an entry for a command nobody registers fails it too. The
 * help cannot drift from the bot because there is nowhere for it to drift to.
 */

export type CommandScope = 'all' | 'admin';
export type CommandWhere = 'any' | 'dm' | 'group';

export interface CommandSpec {
  /** The name as registered, without the slash. */
  name: string;
  /** Other names the same handler answers to. */
  aliases?: string[];
  /** The arguments, in the angle brackets people actually type. */
  usage: string;
  /** One line. Not two. */
  what: string;
  scope: CommandScope;
  where: CommandWhere;
  /** The heading it appears under. */
  group: string;
}

/**
 * In the order a person meets them, not alphabetically.
 *
 * `usage` is the whole line after the name, so a command with subcommands
 * states the one that matters and the rest live behind the command itself.
 */
export const COMMANDS: CommandSpec[] = [
  // ------------------------------------------------------------- scanning
  { name: 'scan', usage: '<token address>', group: 'Scanning', scope: 'all', where: 'any',
    what: 'the card: what the chain shows about one launch' },
  { name: 'full', usage: '<token address>', group: 'Scanning', scope: 'all', where: 'any',
    what: 'the same launch with the technical detail behind every line' },
  { name: 'image', usage: '<token address>', group: 'Scanning', scope: 'all', where: 'any',
    what: 'the card as a picture, for sharing outside Telegram' },
  { name: 'position', usage: '<wallet> <token address>', group: 'Scanning', scope: 'all', where: 'any',
    what: 'where one wallet stood in one launch: what number buyer, who was exempt ahead of it' },
  { name: 'legend', usage: '', group: 'Scanning', scope: 'all', where: 'any',
    what: 'what the markers on a card mean, and what a missing one does not mean' },
  { name: 'stats', usage: '', group: 'Scanning', scope: 'all', where: 'any',
    what: 'what has been indexed, as counters' },

  // --------------------------------------------------------------- alerts
  { name: 'watch', usage: '<deployer|wallet|filter> <address or name>', group: 'Alerts, delivered in DM and never into a group', scope: 'all', where: 'dm',
    what: 'tell me when that address launches again, is pre-exempted, or a launch matches a filter' },
  { name: 'watching', usage: '', group: 'Alerts, delivered in DM and never into a group', scope: 'all', where: 'dm',
    what: 'your subscriptions' },
  { name: 'unwatch', usage: '<address|filter>', group: 'Alerts, delivered in DM and never into a group', scope: 'all', where: 'dm',
    what: 'remove one' },
  { name: 'filters', usage: '', group: 'Alerts, delivered in DM and never into a group', scope: 'all', where: 'any',
    what: 'the filters you can watch, and how often each one fires' },
  { name: 'feed', usage: '', group: 'Alerts, delivered in DM and never into a group', scope: 'all', where: 'dm',
    what: 'every launch as it lands, on or off' },

  // ------------------------------------------------------------- in a group
  { name: 'autoscan', usage: 'on|off', group: 'In a group', scope: 'all', where: 'group',
    what: 'group admins only: whether an address posted here gets a card. off by default' },
  { name: 'leaderboard', usage: '', group: 'In a group', scope: 'all', where: 'group',
    what: 'who called what here, by how far it ran afterwards' },
  { name: 'card', usage: '(as a reply to a call)', group: 'In a group', scope: 'all', where: 'group',
    what: 'that call as a picture' },
  { name: 'ready', usage: '', group: 'In a group', scope: 'all', where: 'any',
    what: 'the launch totals, and only the totals' },
  { name: 'tge', usage: '', group: 'In a group', scope: 'all', where: 'any',
    what: 'the same, with the countdown once a time is set' },

  // ------------------------------------------------------------ your access
  { name: 'holder', usage: 'link|unlink', group: 'Your account', scope: 'all', where: 'dm',
    what: 'link the wallet you hold with, by signature or by transaction hash' },
  { name: 'tiers', usage: '', group: 'Your account', scope: 'all', where: 'any',
    what: 'what each tier costs in $VITALS, and which one you are' },
  { name: 'premium', usage: 'status', group: 'Your account', scope: 'all', where: 'dm',
    what: 'how your access stands and how long it lasts. /premium <tx hash> credits a payment' },
  { name: 'license', usage: 'status', group: 'Your account', scope: 'all', where: 'any',
    what: 'whether this group is licensed, and by what' },
  { name: 'export', usage: '', group: 'Your account', scope: 'all', where: 'dm',
    what: 'your scans as a file' },
  { name: 'sponsor', usage: '', group: 'Your account', scope: 'all', where: 'any',
    what: 'what the one paid line at the bottom of a card costs, and what it may never say' },

  // -------------------------------------------------------------- declaring
  { name: 'declare', usage: '', group: 'Declared launches', scope: 'all', where: 'dm',
    what: 'state what your launch will do and sign it with the wallet that will deploy' },
  { name: 'declared', usage: '', group: 'Declared launches', scope: 'all', where: 'any',
    what: 'the declarations, newest first, with what each launch did afterwards' },

  // ----------------------------------------------------------------- admin
  { name: 'status', usage: '', group: 'Admin', scope: 'admin', where: 'dm',
    what: 'indexer head against chain head, the lag, the armed launch, uptime' },
  { name: 'scout', usage: '[serial]', group: 'Admin', scope: 'admin', where: 'dm',
    what: 'graduated launches worth a look, as a csv' },
  { name: 'numbers', usage: '', group: 'Admin', scope: 'admin', where: 'any',
    what: 'the daily figures as a picture' },
  { name: 'launch', usage: 'watch|name|set|cancel', group: 'Admin', scope: 'admin', where: 'any',
    what: 'arm the room: watch the deployer, name it, set the time' },
  { name: 'seat', usage: 'add|remove|tier|list|history', group: 'Admin', scope: 'admin', where: 'dm',
    what: 'the roster. every view that shows a wallet refuses to answer in a group' },
  { name: 'roster', usage: '', group: 'Admin', scope: 'admin', where: 'any',
    what: 'the room version: seat and tier, no wallet' },
  { name: 'ledger', usage: 'preview|csv|send|tx|post|sweep|history', group: 'Admin', scope: 'admin', where: 'any',
    what: 'the payout run. the bot holds no key and sends nothing' },
  { name: 'grant', usage: '<telegram user id> <days>d', group: 'Admin', scope: 'admin', where: 'any',
    what: 'premium for an account, by id' },
  { name: 'revoke', usage: '<telegram user id>', group: 'Admin', scope: 'admin', where: 'any',
    what: 'take that back' },
  { name: 'token', usage: 'set <address>', group: 'Admin', scope: 'admin', where: 'any',
    what: 'the $VITALS contract the tiers are read against' },
  { name: 'gate', usage: 'on|off', group: 'Admin', scope: 'admin', where: 'any',
    what: 'whether a channel membership is required' },
  { name: 'kols', usage: '', group: 'Admin', scope: 'admin', where: 'any',
    what: 'the callers table' },
  { name: 'start', aliases: ['help'], usage: '', group: 'Admin', scope: 'all', where: 'any',
    what: 'this list' },
];

/** Every name the bot answers to, aliases included. */
export function registeredNames(): string[] {
  return COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
}

const WHERE: Record<CommandWhere, string> = { any: '', dm: ' · DM', group: ' · in a group' };

/** One line for one command, the same shape everywhere. */
export function commandLine(c: CommandSpec): string {
  const head = `/${c.name}${c.usage ? ` ${c.usage}` : ''}`;
  const marks = `${c.scope === 'admin' ? ' · admin' : ''}${WHERE[c.where]}`;
  return `${head}${marks}\n    ${c.what}`;
}

/** The headings, in the order the table gives them. */
export function groupsInOrder(): string[] {
  const seen: string[] = [];
  for (const c of COMMANDS) if (!seen.includes(c.group)) seen.push(c.group);
  return seen;
}

/**
 * The whole list, generated.
 *
 * Admin commands are shown to everyone and marked, rather than hidden: the
 * bot posts in rooms other people run, and what it can be told to do is not
 * a secret from the people in them.
 */
export function commandList(): string {
  const out: string[] = [];
  for (const group of groupsInOrder()) {
    out.push(group + ':');
    for (const c of COMMANDS.filter((x) => x.group === group)) out.push(`  ${commandLine(c)}`);
    out.push('');
  }
  return out.join('\n').trimEnd();
}
