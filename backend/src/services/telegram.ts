import TelegramBot from 'node-telegram-bot-api';

let bot: TelegramBot | null = null;

function getBot(): TelegramBot | null {
  if (!process.env.TELEGRAM_BOT_TOKEN) return null;
  if (!bot) bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
  return bot;
}

interface SOSPayload {
  chatId: string;
  riderName: string;
  bloodGroup?: string;
  medicalNotes?: string;
  mapsLink: string;
  message?: string;
}

export async function sendSOS(payload: SOSPayload): Promise<boolean> {
  const b = getBot();
  if (!b) return false;

  const text = [
    '🚨 *SOS ALERT — RIDER NEEDS HELP!*',
    '',
    `👤 *Rider:* ${payload.riderName}`,
    payload.bloodGroup ? `🩸 *Blood Group:* ${payload.bloodGroup}` : '',
    payload.medicalNotes ? `📋 *Medical Notes:* ${payload.medicalNotes}` : '',
    '',
    `📍 *Location:* [Open in Maps](${payload.mapsLink})`,
    '',
    payload.message ? `💬 ${payload.message}` : '⚠️ Rider is in distress. Please respond immediately!',
    '',
    `🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`,
  ].filter(Boolean).join('\n');

  try {
    await b.sendMessage(payload.chatId, text, { parse_mode: 'Markdown' });
    return true;
  } catch (err) {
    console.error('Telegram SOS failed:', err);
    return false;
  }
}

export async function sendReminder(chatId: string, reminderType: string, bikeName: string, details: string): Promise<boolean> {
  const b = getBot();
  if (!b) return false;

  const text = [
    `🔔 *Maintenance Reminder — ${reminderType}*`,
    '',
    `🏍️ *Bike:* ${bikeName}`,
    `📝 ${details}`,
    '',
    `🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`,
  ].join('\n');

  try {
    await b.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    return true;
  } catch {
    return false;
  }
}

export async function sendTripNotification(chatId: string, message: string): Promise<boolean> {
  const b = getBot();
  if (!b) return false;
  try {
    await b.sendMessage(chatId, `🏍️ ${message}`);
    return true;
  } catch {
    return false;
  }
}
