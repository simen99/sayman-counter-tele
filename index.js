import express from "express";
import { Telegraf, Markup } from "telegraf";
import Database from "better-sqlite3";

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN || !WEBHOOK_URL) {
  console.error("Harap set BOT_TOKEN dan WEBHOOK_URL di environment.");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 10_000 });
await bot.telegram.setWebhook(WEBHOOK_URL, {
  allowed_updates: ["message", "chat_member", "callback_query", "my_chat_member"],
});

// ---------- DB ----------
const db = new Database("data.db");

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

-- Tabel berikut sebenarnya TIDAK dipakai lagi untuk multi-admin,
-- tapi boleh dibiarkan agar tidak mengubah struktur lain.
CREATE TABLE IF NOT EXISTS group_admin_receiver (
  chat_id INTEGER PRIMARY KEY,
  admin_user_id INTEGER NOT NULL
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

// Masih ada biar /start lama tidak error, walau tidak dipakai untuk kirim DM
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

// ---------- Helper ----------
function mention(user) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || "user";
  return `[${name}](tg://user?id=${user.id})`;
}
function atUsername(user) {
  return user.username ? `@${user.username}` : `(no username)`;
}
function nowTime() {
  const d = new Date();
  return d.toTimeString().slice(0,8); // HH:MM:SS
}

// Ambil semua admin manusia di grup (non-bot)
async function getGroupAdminIds(telegram, chatId) {
  const admins = await telegram.getChatAdministrators(chatId);
  return admins
    .map(a => a.user)
    .filter(u => !u.is_bot)
    .map(u => u.id);
}

function buildReportText({ chat, actor, newUser, total }) {
  return (
    `👤 Username : ${newUser.first_name || newUser.username || newUser.id}\n` +
    `🆔 User ID : ${newUser.username ? '@' + newUser.username : '(no username)'}\n` +
    `👥 Pengundang / Adder : ${mention(actor)}\n` +
    `📊 Total undangan (adder) : ${total}\n` +
    `⏰ Last Update : ${nowTime()}\n` +
    `👥 Grup : ${chat.title || chat.id}`
  );
}

// ---------- Commands ----------
bot.command("start", async (ctx) => {
  if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") {
    return ctx.reply(
      "Hi! Tambahkan aku ke grup dan jalankan /start di grup untuk mengaktifkan laporan.\n" +
      "Hi! Add me to a group and run /start there to enable reports."
    );
  }
  // Boleh dihapus kalau mau bersih total dari single-admin mode
  setAdminReceiver.run(ctx.chat.id, ctx.from.id);

  await ctx.reply(
    "✅ Bot siap digunakan. Laporan akan dikirim via DM ke semua admin (yang sudah /start bot di DM).\n" +
    "✅ Bot is ready. Reports will be sent via DM to all group admins (who have /start me in DM).",
    { parse_mode: "Markdown" }
  );
});

bot.command("mystats", async (ctx) => {
  if (!ctx.chat || (ctx.chat.type === "private")) return ctx.reply("Gunakan perintah ini di dalam grup.");
  const row = getMyCount.get(ctx.chat.id, ctx.from.id);
  const c = row ? row.count : 0;
  await ctx.replyWithMarkdown(`Total undangan *${c}* untuk ${mention(ctx.from)} di grup ini.`);
});

// ---------- Event: member added (manual) ----------
bot.on("chat_member", async (ctx) => {
  try {
    const upd = ctx.update.chat_member;
    const chat = upd.chat;
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
    const text = buildReportText({ chat, actor, newUser: newm.user, total });
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback("🔁 Reset", `reset:${chat.id}:${actor.id}`)],
    ]);

    // Kirim ke SEMUA admin manusia, mode "single output": edit-or-send per (inviter, admin)
    const adminIds = await getGroupAdminIds(ctx.telegram, chat.id);

    for (const adminId of adminIds) {
      try {
        const exist = getReportMsg.get(chat.id, actor.id, adminId);

        if (exist?.message_id) {
          // Edit pesan lama
          await ctx.telegram.editMessageText(
            adminId,            // DM ke admin
            exist.message_id,   // message id tersimpan
            undefined,
            text,
            { parse_mode: "Markdown", ...kb }
          );
        } else {
          // Kirim pertama kali, simpan message_id
          const sent = await ctx.telegram.sendMessage(adminId, text, { parse_mode: "Markdown", ...kb });
          upsertReportMsg.run(chat.id, actor.id, adminId, sent.message_id);
        }
      } catch (e) {
        // 403: admin belum pernah /start bot di DM → abaikan
      }
    }

    // (Opsional) Umumkan ringkas di grup:
    // await ctx.telegram.sendMessage(
    //   chat.id,
    //   `➕ ${mention(actor)} menambahkan ${mention(newm.user)} • total undangan ${total}`,
    //   { parse_mode: "Markdown", disable_notification: true }
    // );

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

// ---------- Webhook server ----------
const app = express();
app.use(express.json());
app.post("/telegram", (req, res) => { bot.handleUpdate(req.body).then(() => res.sendStatus(200)); });
app.get("/health", (req, res) => res.send("OK"));
app.listen(PORT, () => console.log(`Bot listening on port ${PORT}`));
