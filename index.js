import express from "express";
import { Telegraf, Markup } from "telegraf";
import Database from "better-sqlite3";

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = process.env.PORT || 3000;

// --- DB path pakai Volume (disarankan set: DB_PATH=/data/data.db di Railway) ---
const DB_PATH = process.env.DB_PATH || "data.db";

if (!BOT_TOKEN || !WEBHOOK_URL) {
  console.error("Harap set BOT_TOKEN dan WEBHOOK_URL di environment.");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 10_000 });
await bot.telegram.setWebhook(WEBHOOK_URL, {
  allowed_updates: ["message", "chat_member", "callback_query", "my_chat_member"],
});

// ---------- DB ----------
const db = new Database(DB_PATH);
// Stabilkan SQLite saat ramai
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("busy_timeout = 3000");

db.exec(`
CREATE TABLE IF NOT EXISTS invite_counts (
  chat_id INTEGER NOT NULL,
  inviter_user_id INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, inviter_user_id)
);

CREATE TABLE IF NOT EXISTS invite_reports (
  chat_id INTEGER NOT NULL,
  inviter_user_id INTEGER NOT NULL,
  admin_user_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  PRIMARY KEY (chat_id, inviter_user_id, admin_user_id)
);

-- Sisa kompatibilitas lama (tidak dipakai untuk multi-admin)
CREATE TABLE IF NOT EXISTS group_admin_receiver (
  chat_id INTEGER PRIMARY KEY,
  admin_user_id INTEGER NOT NULL
);

-- ON/OFF per grup (default ON = 1)
CREATE TABLE IF NOT EXISTS group_feature_flags (
  chat_id INTEGER PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1
);
`);

const incCount = db.prepare(
  `INSERT INTO invite_counts(chat_id, inviter_user_id, count) VALUES(?, ?, 1)
   ON CONFLICT(chat_id, inviter_user_id) DO UPDATE SET count = count + 1`
);
const getMyCount = db.prepare(
  `SELECT count FROM invite_counts WHERE chat_id = ? AND inviter_user_id = ?`
);
const resetCount = db.prepare(
  `DELETE FROM invite_counts WHERE chat_id = ? AND inviter_user_id = ?`
);

// Kompat lama (aman dibiarkan)
const setAdminReceiver = db.prepare(
  `INSERT INTO group_admin_receiver(chat_id, admin_user_id) VALUES(?, ?)
   ON CONFLICT(chat_id) DO UPDATE SET admin_user_id = excluded.admin_user_id`
);

// Simpan message_id DM per (chat_id, inviter_user_id, admin_user_id)
const getReportMsg = db.prepare(
  `SELECT message_id FROM invite_reports WHERE chat_id = ? AND inviter_user_id = ? AND admin_user_id = ?`
);
const upsertReportMsg = db.prepare(
  `INSERT INTO invite_reports (chat_id, inviter_user_id, admin_user_id, message_id)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(chat_id, inviter_user_id, admin_user_id)
   DO UPDATE SET message_id = excluded.message_id`
);

// ON/OFF per grup
const getGroupEnabled = db.prepare(
  `SELECT enabled FROM group_feature_flags WHERE chat_id = ?`
);
const setGroupEnabled = db.prepare(
  `INSERT INTO group_feature_flags(chat_id, enabled) VALUES(?, ?)
   ON CONFLICT(chat_id) DO UPDATE SET enabled = excluded.enabled`
);

// ---------- Helper ----------
function mention(user) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || "user";
  return `[${name}](tg://user?id=${user.id})`;
}
function atUsername(user) {
  return user.username ? `@${user.username}` : `(no username)`;
}
function nowTime() {
  // WIB (Asia/Jakarta), 24 jam
  return new Date().toLocaleTimeString("id-ID", {
    hour12: false,
    timeZone: "Asia/Jakarta"
  });
}

// Ambil semua admin manusia di grup (non-bot)
async function getGroupAdminIds(telegram, chatId) {
  const admins = await telegram.getChatAdministrators(chatId);
  return admins
    .map(a => a.user)
    .filter(u => !u.is_bot)
    .map(u => u.id);
}

function buildReportText({ chat, actor, total }) {
  const uname = actor.username ? `@${actor.username}` : "(username privat)";
  return (
    `👥 Pengundang : ${mention(actor)}\n` +
    `🔖 Username Pengundang : ${uname}\n` +
    `📊 Total undangan : ${total}\n` +
    `⏰ Last Update : ${nowTime()}\n` +
    `👥 Grup : ${chat.title || chat.id}`
  );
}

// Retry helper untuk 429 rate limit (sekali ulang)
async function safeCall(fn) {
  try { return await fn(); }
  catch (e) {
    const code = e?.response?.error_code || e?.code;
    if (code === 429) {
      const ms = (e?.response?.parameters?.retry_after ? e.response.parameters.retry_after * 1000 : 1000);
      await new Promise(r => setTimeout(r, ms));
      return await fn();
    }
    throw e;
  }
}

// ---- Per-key async lock to serialize operations ----
const opQueues = new Map(); // key -> Promise

function withKeyLock(key, fn) {
  const prev = opQueues.get(key) || Promise.resolve();
  // chain agar antrian per key dieksekusi berurutan
  const next = prev.catch(() => {}).then(fn).finally(() => {
    // bersihkan jika ini adalah tail saat ini
    if (opQueues.get(key) === next) opQueues.delete(key);
  });
  opQueues.set(key, next);
  return next;
}

// ---------- Commands ----------
bot.command("start", async (ctx) => {
  // Private: supaya admin bisa terima DM
  if (ctx.chat?.type === "private") {
    return ctx.reply("Halo! Sekarang kamu bisa menerima DM laporan kalau jadi admin di grup yang memakai bot ini. Tambahkan aku ke grup & jalankan /start di grup tersebut.");
  }

  // Grup: aktifkan & info
  if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") {
    return ctx.reply("Perintah ini dipakai di grup atau private.");
  }

  // Kompat lama (tidak dipakai lagi untuk DM target)
  setAdminReceiver.run(ctx.chat.id, ctx.from.id);

  // Pastikan grup ON saat /start
  setGroupEnabled.run(ctx.chat.id, 1);

  await ctx.reply(
    "✅ Bot siap digunakan. Laporan akan dikirim via DM ke semua admin (yang sudah /start bot di DM).\n" +
    "Gunakan /off untuk mematikan laporan di grup ini.",
    { parse_mode: "Markdown" }
  );
});

bot.command("mystats", async (ctx) => {
  if (!ctx.chat || (ctx.chat.type === "private")) return ctx.reply("Gunakan perintah ini di dalam grup.");
  const row = getMyCount.get(ctx.chat.id, ctx.from.id);
  const c = row ? row.count : 0;
  await ctx.replyWithMarkdown(`Total undangan *${c}* untuk ${mention(ctx.from)} di grup ini.`);
});

// ON/OFF per grup (sesuai permintaan: hanya /off tambahan)
bot.command("off", async (ctx) => {
  if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup")
    return ctx.reply("Jalankan perintah ini di dalam grup.");

  // hanya admin manusia
  try {
    const admins = await ctx.telegram.getChatAdministrators(ctx.chat.id);
    const isAdmin = admins.some(a => a.user.id === ctx.from.id && !a.user.is_bot);
    if (!isAdmin) return ctx.reply("Hanya admin grup yang bisa mematikan laporan.");
  } catch {
    return ctx.reply("Gagal memeriksa admin.");
  }

  setGroupEnabled.run(ctx.chat.id, 0);
  await ctx.reply("🔇 Laporan undangan dimatikan untuk grup ini. Jalankan /start untuk mengaktifkan kembali.");
});

// ---------- Event: member added (manual) ----------
bot.on("chat_member", async (ctx) => {
  try {
    const upd = ctx.update.chat_member;
    const chat = upd.chat;

    // Skip jika grup OFF
    const flag = getGroupEnabled.get(chat.id);
    if (flag && flag.enabled === 0) return;

    const newm = upd.new_chat_member;
    const oldm = upd.old_chat_member;
    const actor = upd.from; // si A yang melakukan aksi add

    const becameMember = oldm.status !== "member" && newm.status === "member";
    if (!becameMember) return;

    // 1) Abaikan join via link
    if (upd.invite_link && upd.invite_link.invite_link) return;

    // 2) Abaikan join sendiri (aktor = user baru)
    if (actor && actor.id === newm.user.id) return;

    // 3) Hitung ke aktor (A menambahkan B)
    if (!actor) return;
    incCount.run(chat.id, actor.id);

    const row = getMyCount.get(chat.id, actor.id);
    const total = row ? row.count : 1;

    // Siapkan teks & tombol
    const text = buildReportText({ chat, actor, total });
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback("🔁 Reset", `reset:${chat.id}:${actor.id}`)],
    ]);

    // Kirim ke SEMUA admin manusia, mode "single output": edit-or-send per (inviter, admin)
    const adminIds = await getGroupAdminIds(ctx.telegram, chat.id);

    for (const adminId of adminIds) {
  const key = `${chat.id}:${actor.id}:${adminId}`;
  await withKeyLock(key, async () => {
    try {
      const exist = getReportMsg.get(chat.id, actor.id, adminId);

      if (exist?.message_id) {
        // Edit pesan lama
        await safeCall(() =>
          ctx.telegram.editMessageText(
            adminId,
            exist.message_id,
            undefined,
            text,
            { parse_mode: "Markdown", ...kb }
          )
        );
      } else {
        // Kirim pertama kali, simpan message_id
        const sent = await safeCall(() =>
          ctx.telegram.sendMessage(adminId, text, { parse_mode: "Markdown", ...kb })
        );
        upsertReportMsg.run(chat.id, actor.id, adminId, sent.message_id);
      }
    } catch (e) {
      // 403: admin belum /start DM → abaikan
      // 400 (message deleted) → kirim baru + simpan id
      const code = e?.response?.error_code || e?.code;
      if (code === 400) {
        try {
          const sent = await safeCall(() =>
            ctx.telegram.sendMessage(adminId, text, { parse_mode: "Markdown", ...kb })
          );
          upsertReportMsg.run(chat.id, actor.id, adminId, sent.message_id);
        } catch {}
      }
    }
  });
}

  } catch (err) {
    console.error("chat_member handler error:", err);
  }
});

// ---------- Reset handler (admin only) ----------
bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery?.data || "";
  if (!data.startsWith("reset:")) return ctx.answerCbQuery();

  const [, chatIdStr, inviterIdStr] = data.split(":");
  const chatId = Number(chatIdStr);
  const inviterId = Number(inviterIdStr);

  // Hanya admin manusia di grup tsb yang boleh reset
  const adminIds = await getGroupAdminIds(ctx.telegram, chatId);
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.answerCbQuery("Hanya admin grup yang dapat reset.", { show_alert: true });
  }

  resetCount.run(chatId, inviterId);
  await ctx.editMessageText("✅ Counter direset.");
});

// ---------- Global error guards ----------
process.on("unhandledRejection", (err) => console.error("UNHANDLED REJECTION:", err));
process.on("uncaughtException", (err) => console.error("UNCAUGHT EXCEPTION:", err));

// ---------- Webhook server ----------
const app = express();
app.use(express.json());
app.post("/telegram", (req, res) => { bot.handleUpdate(req.body).then(() => res.sendStatus(200)); });
app.get("/health", (req, res) => res.send("OK"));
app.listen(PORT, () => console.log(`Bot listening on port ${PORT}`));
