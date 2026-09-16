#!/usr/bin/env node
/**
 * Telegram helper.
 *
 *   npm run telegram              verify the token and list chats that messaged the bot
 *   npm run telegram -- <chatId>  send a test alert to that chat
 *
 * Why this exists: RiderHub's bot never listens for messages (it only ever sends), so
 * a rider pressing /start gets no reply and cannot discover their own chat ID. This
 * reads the bot's pending updates and prints the IDs for you.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const c = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m' };

function token() {
  let env;
  try { env = readFileSync(join(ROOT, 'backend', '.env'), 'utf8'); }
  catch { console.error(`${c.red}backend/.env not found${c.reset} — run npm run setup`); process.exit(1); }
  const m = env.match(/^TELEGRAM_BOT_TOKEN=(.*)$/m);
  const t = m?.[1]?.trim().replace(/^["']|["']$/g, '');
  if (!t) {
    console.error(`${c.red}TELEGRAM_BOT_TOKEN is not set in backend/.env${c.reset}`);
    console.error(`${c.dim}Get one from @BotFather → /newbot, then add the line:\nTELEGRAM_BOT_TOKEN=123456:AA...${c.reset}`);
    process.exit(1);
  }
  return t;
}

/** Telegram 504s intermittently; retry before declaring the token bad. */
async function call(t, method, params, attempts = 4) {
  const url = `https://api.telegram.org/bot${t}/${method}`;
  let last = '';
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url + (params ? '?' + new URLSearchParams(params) : ''), {
        signal: AbortSignal.timeout(20000),
      });
      const body = await res.json().catch(() => null);
      if (body?.ok) return body.result;
      last = body ? `${body.error_code} ${body.description}` : `HTTP ${res.status}`;
      // 401/404 are definitive — a bad token will never succeed, so stop early.
      if (body?.error_code === 401 || body?.error_code === 404) break;
    } catch (e) {
      last = e.name === 'TimeoutError' ? 'request timed out' : e.message;
    }
    if (i < attempts) {
      process.stdout.write(`${c.dim}  attempt ${i} failed (${last}) — retrying…${c.reset}\n`);
      await new Promise(r => setTimeout(r, 2000 * i));
    }
  }
  throw new Error(last);
}

const t = token();
const target = process.argv[2];

console.log(`${c.bold}\n📨 RiderHub — Telegram check${c.reset}\n`);

// ── 1. Token ───────────────────────────────────────────────────
let me;
try {
  me = await call(t, 'getMe');
  console.log(`${c.green}✓${c.reset} Token valid`);
  console.log(`    Bot      : ${me.first_name}`);
  console.log(`    Username : ${c.cyan}@${me.username}${c.reset}`);
  console.log(`    ${c.dim}Riders must search this exact username and press Start.${c.reset}`);
} catch (e) {
  console.log(`${c.red}✗${c.reset} Could not verify token: ${e.message}`);
  if (/401|Unauthorized/i.test(e.message)) {
    console.log(`    ${c.dim}→ The token is wrong or was revoked. @BotFather → /mybots → API Token.${c.reset}`);
  } else {
    console.log(`    ${c.dim}→ Looks like a network/Telegram hiccup rather than a bad token. Try again shortly.${c.reset}`);
  }
  process.exit(1);
}

// ── 2. Send a test message ─────────────────────────────────────
if (target) {
  console.log(`\n${c.bold}Sending test alert to ${target}…${c.reset}`);
  try {
    await call(t, 'sendMessage', {
      chat_id: target,
      text: '🏍️ *RiderHub test alert*\n\nIf you can read this, SOS and reminder notifications are working.',
      parse_mode: 'Markdown',
    });
    console.log(`${c.green}✓${c.reset} Delivered. Paste ${c.cyan}${target}${c.reset} into RiderHub → Profile → Telegram Chat ID.`);
  } catch (e) {
    console.log(`${c.red}✗${c.reset} Failed: ${e.message}`);
    if (/chat not found/i.test(e.message)) {
      console.log(`    ${c.dim}→ Wrong ID, or that person has never pressed Start on @${me.username}.${c.reset}`);
    } else if (/bot can't initiate|blocked/i.test(e.message)) {
      console.log(`    ${c.dim}→ Telegram forbids bots messaging first. They must open @${me.username} and press Start.${c.reset}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

// ── 3. List chats that have messaged the bot ───────────────────
console.log(`\n${c.bold}Chats that have messaged this bot${c.reset}`);
let updates = [];
try {
  updates = await call(t, 'getUpdates', { limit: '100' });
} catch (e) {
  console.log(`${c.yellow}!${c.reset} Could not read updates: ${e.message}`);
}

const chats = new Map();
for (const u of updates) {
  const msg = u.message || u.edited_message || u.my_chat_member || u.channel_post;
  const chat = msg?.chat;
  if (chat) chats.set(chat.id, chat);
}

if (!chats.size) {
  console.log(`${c.yellow}!${c.reset} Nobody has messaged @${me.username} yet (or updates already expired).\n`);
  console.log(`${c.dim}  Ask each rider to open @${me.username} in Telegram and press Start,
  then run this again to see their chat ID.

  For a whole club: create a Telegram group, add @${me.username} to it,
  send one message in the group, and re-run — the group ID appears below
  (it starts with a minus sign). One SOS then reaches everyone at once.${c.reset}`);
} else {
  for (const [id, chat] of chats) {
    const who = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || 'unknown';
    const kind = chat.type === 'private' ? 'rider' : chat.type;
    console.log(`  ${c.cyan}${String(id).padEnd(16)}${c.reset} ${who} ${c.dim}(${kind})${c.reset}`);
  }
  console.log(`\n${c.dim}Test one with:  npm run telegram -- <chatId>${c.reset}`);
}

console.log();
