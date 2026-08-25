import { Bot, type Context } from 'grammy';
import { isAddress, getAddress } from 'viem';
import { scanToken } from './scan.js';
import { renderCard } from './card.js';
import { db } from './db.js';
import { TELEGRAM_BOT_TOKEN, DISCLAIMER, EXPLORER_URL } from './config.js';

const HELP = [
  '<b>pons v2 launch scanner</b> — Robinhood Chain',
  '',
  'Send <code>/scan &lt;token address&gt;</code> to get a traction and flag card',
  'for any token launched on the pons v2 launchpad.',
  '',
  'The card reports what the chain shows: how many distinct wallets bought in',
  'the opening window, whether buying outpaced selling, how far the curve filled,',
  'and a set of structural flags — the most useful of which is the number of',
  'wallets the creator pre-exempted from the opening snipe tax, which is readable',
  'only from the launch transaction itself.',
  '',
  'Every scan is stored and rechecked at +1h, +6h, +24h and +7d, so the early',
  'signal can be compared against what actually happened.',
  '',
  `<i>${DISCLAIMER}</i>`,
].join('\n');

function extractAddress(text: string): string | null {
  const m = text.match(/0x[a-fA-F0-9]{40}/);
  if (!m) return null;
  return isAddress(m[0]) ? getAddress(m[0]) : null;
}

async function handleScan(ctx: Context, raw: string): Promise<void> {
  const addr = extractAddress(raw);
  if (!addr) {
    await ctx.reply(
      'Send a token address, e.g.\n<code>/scan 0x147Bbaa458Ab7Cd11E1E478B87f08FE5A42A9E67</code>',
      { parse_mode: 'HTML' },
    );
    return;
  }

  const notice = await ctx.reply(`Scanning <code>${addr}</code>…`, { parse_mode: 'HTML' });
  try {
    const result = await scanToken(addr, ctx.from?.id);
    if (!result) {
      await ctx.api.editMessageText(
        notice.chat.id,
        notice.message_id,
        `<code>${addr}</code> is not a pons v2 launch on this chain — the factory has no record of it.\n\n<i>${DISCLAIMER}</i>`,
        { parse_mode: 'HTML' },
      );
      return;
    }
    await ctx.api.editMessageText(notice.chat.id, notice.message_id, renderCard(result), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  } catch (err: any) {
    console.error('[scan] failed:', err);
    await ctx.api.editMessageText(
      notice.chat.id,
      notice.message_id,
      `Scan failed: ${String(err?.shortMessage ?? err?.message ?? err).slice(0, 200)}`,
    );
  }
}

export function createBot(token = TELEGRAM_BOT_TOKEN): Bot {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  const bot = new Bot(token);

  bot.command(['start', 'help'], (ctx) =>
    ctx.reply(HELP, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
  );

  bot.command('scan', (ctx) => handleScan(ctx, ctx.match || ''));

  bot.command('stats', async (ctx) => {
    const launches = (db.prepare('SELECT COUNT(*) n FROM launches').get() as any).n;
    const scans = (db.prepare('SELECT COUNT(*) n FROM scans').get() as any).n;
    const trades = (db.prepare('SELECT COUNT(*) n FROM trades').get() as any).n;
    const pending = (db.prepare('SELECT COUNT(*) n FROM rechecks WHERE completed_at IS NULL').get() as any).n;
    const done = (db.prepare('SELECT COUNT(*) n FROM rechecks WHERE completed_at IS NOT NULL').get() as any).n;
    const withEx = (db.prepare('SELECT COUNT(*) n FROM launches WHERE snipe_exemption_count > 0').get() as any).n;
    const known = (db.prepare('SELECT COUNT(*) n FROM launches WHERE snipe_exemption_count IS NOT NULL').get() as any).n;
    await ctx.reply(
      [
        '<b>index</b>',
        `  launches indexed: ${launches}`,
        `  creation tx decoded: ${known}${launches ? ` (${((known / launches) * 100).toFixed(1)}%)` : ''}`,
        `  with snipe-tax exemptions: ${withEx}`,
        `  curve trades: ${trades}`,
        '<b>scans</b>',
        `  scans recorded: ${scans}`,
        `  rechecks done: ${done}, pending: ${pending}`,
        '',
        `<i>${DISCLAIMER}</i>`,
      ].join('\n'),
      { parse_mode: 'HTML' },
    );
  });

  // A bare token address, with no command, is treated as a scan.
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;
    if (extractAddress(text)) await handleScan(ctx, text);
  });

  bot.catch((err) => console.error('[bot] error:', err));
  return bot;
}

export async function startBot(): Promise<void> {
  const bot = createBot();
  await bot.api.setMyCommands([
    { command: 'scan', description: 'Score a pons v2 token launch' },
    { command: 'stats', description: 'Index and scan statistics' },
    { command: 'help', description: 'What this bot reports' },
  ]);
  const me = await bot.api.getMe();
  console.log(`[bot] running as @${me.username}`);
  console.log(`[bot] explorer ${EXPLORER_URL}`);
  await bot.start();
}
