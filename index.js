require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const {
  readEmailData,
  saveEmailData,
  addGmailSender,
  addBrevoAccount,
  addBrevoFromEmail,
  addReceiver,
  getAllSenders,
  sendEmail,
} = require("./email");

const fs = require("fs");
const path = require("path");
const inbox = require("./inbox");
const { replyMeta } = inbox;

// ==================== Konfigurasi ====================
const BOT_TOKEN = process.env.EMAIL_BOT_TOKEN;
const OWNER_ID = parseInt(process.env.OWNER_ID, 10);

if (!BOT_TOKEN || !OWNER_ID) {
  console.error("❌ EMAIL_BOT_TOKEN dan OWNER_ID harus diatur di .env");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const chatState = {};
inbox.init(bot);
inbox.loadAllAndStart();

const BACK_BUTTON = { text: "⬅️", callback_data: "back_to_menu" };

// ==================== Helper: Sender Picker ====================
function buildPickSendersMessage(allSenders, selectedIdxs) {
  const senderRows = allSenders.map((s, i) => {
    const checked = selectedIdxs.includes(i) ? "✅" : "⬜";
    const label = s.email.length > 28 ? s.email.slice(0, 25) + "…" : s.email;
    return [{ text: `${checked} ${label}`, callback_data: `toggle_sender_${i}` }];
  });

  const allSelected = selectedIdxs.length === allSenders.length;
  senderRows.push([
    { text: allSelected ? "✅ Semua Dipilih" : "☑️ Pilih Semua", callback_data: "toggle_all_senders" },
  ]);
  senderRows.push([
    { text: `📨 Lanjut (${selectedIdxs.length} dipilih)`, callback_data: "confirm_senders" },
  ]);
  senderRows.push([BACK_BUTTON]);

  const text =
    `📤 *Pilih Email Pengirim*\n\nCentang pengirim yang ingin digunakan:\n` +
    `_(${selectedIdxs.length} dari ${allSenders.length} dipilih)_`;

  return [text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: senderRows } }];
}
const USERS_FILE = path.join(__dirname, "users.json");
const MAX_SEND_COUNT = 500; // batas maksimal jumlah kirim per sesi

// ==================== Utility ====================
function safeEdit(chatId, messageId, text, extra = {}) {
  return bot
    .editMessageText(text, { chat_id: chatId, message_id: messageId, ...extra })
    .catch((err) => {
      if (err.code === 400) return;
      console.error("Gagal edit pesan:", err.message);
    });
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ==================== User Management ====================
function readUsers() {
  if (!fs.existsSync(USERS_FILE)) {
    const defaultData = { approved: [], pending: [] };
    fs.writeFileSync(USERS_FILE, JSON.stringify(defaultData, null, 2));
    return defaultData;
  }
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch {
    return { approved: [], pending: [] };
  }
}

function saveUsers(data) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
}

function isApproved(userId) {
  const data = readUsers();
  return data.approved.includes(userId);
}

function isPending(userId) {
  const data = readUsers();
  return data.pending.includes(userId);
}

function requestAccess(userId) {
  const data = readUsers();
  if (!data.pending.includes(userId) && !data.approved.includes(userId)) {
    data.pending.push(userId);
    saveUsers(data);
    return true;
  }
  return false;
}

function approveUser(userId) {
  const data = readUsers();
  data.pending = data.pending.filter((id) => id !== userId);
  if (!data.approved.includes(userId)) data.approved.push(userId);
  saveUsers(data);
}

function rejectUser(userId) {
  const data = readUsers();
  data.pending = data.pending.filter((id) => id !== userId);
  saveUsers(data);
}

function revokeUser(userId) {
  const data = readUsers();
  data.approved = data.approved.filter((id) => id !== userId);
  saveUsers(data);
}

// ==================== Menu Utama ====================
function showMainMenu(chatId, messageId = null) {
  const text = "📧 *Pilih menu di bawah:*";
  const keyboard = {
    inline_keyboard: [
      [
        { text: "➕ pengirim", callback_data: "add_sender" },
        { text: "➕ penerima", callback_data: "add_receiver" },
      ],
      [
        { text: "➖ pengirim", callback_data: "delete_sender" },
        { text: "➖ penerima", callback_data: "delete_receiver" },
      ],
      [{ text: "📋 List Pengirim & Penerima", callback_data: "list_all" }],
      [{ text: "📨 Send Email", callback_data: "send_email" }],
      [{ text: "📬 Inbox (Email Masuk)", callback_data: "inbox_menu" }],
    ],
  };

  if (messageId) {
    safeEdit(chatId, messageId, text, { parse_mode: "Markdown", reply_markup: keyboard });
  } else {
    bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: keyboard });
  }
}

// ==================== /start ====================
bot.onText(/\/start/, (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  if (userId === OWNER_ID || isApproved(userId)) {
    return showMainMenu(chatId);
  }

  if (isPending(userId)) {
    return bot.sendMessage(chatId, "⏳ Permintaanmu sudah dikirim ke owner. Mohon tunggu persetujuan.");
  }

  requestAccess(userId);
  bot.sendMessage(
    chatId,
    "❌ Maaf, kamu belum memiliki izin menggunakan bot ini.\n\n" +
      "Permintaan akses sudah dikirim ke owner. Mohon tunggu persetujuan."
  );

  const name = `${msg.from.first_name || ""} ${msg.from.last_name || ""}`.trim() || "Tidak ada nama";
  bot.sendMessage(
    OWNER_ID,
    `📩 *Permintaan Akses Baru*\n\n` +
      `User ID: \`${userId}\`\n` +
      `Nama: ${name}\n` +
      `Username: @${msg.from.username || "Tidak ada"}`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Approve", callback_data: `approve_${userId}` },
            { text: "❌ Reject", callback_data: `reject_${userId}` },
          ],
        ],
      },
    }
  );
});

// ==================== Command Owner ====================
bot.onText(/\/listusers/, (msg) => {
  if (msg.from.id !== OWNER_ID) return;

  const users = readUsers();
  let text = `📋 *Daftar User*\n\n`;

  text += `*✅ Approved (${users.approved.length}):*\n`;
  if (users.approved.length) {
    users.approved.forEach((id, i) => {
      text += `${i + 1}. \`${id}\`\n`;
    });
  } else {
    text += "_Tidak ada_\n";
  }

  text += `\n*⏳ Pending (${users.pending.length}):*\n`;
  if (users.pending.length) {
    users.pending.forEach((id, i) => {
      text += `${i + 1}. \`${id}\`\n`;
    });
  } else {
    text += "_Tidak ada_\n";
  }

  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

bot.onText(/\/revoke (.+)/, (msg, match) => {
  if (msg.from.id !== OWNER_ID) return;

  const targetId = parseInt(match[1].trim(), 10);
  if (isNaN(targetId)) {
    return bot.sendMessage(msg.chat.id, "❌ ID tidak valid.");
  }

  const users = readUsers();
  if (!users.approved.includes(targetId)) {
    return bot.sendMessage(msg.chat.id, `❌ User \`${targetId}\` tidak ditemukan di daftar approved.`, {
      parse_mode: "Markdown",
    });
  }

  revokeUser(targetId);
  bot.sendMessage(msg.chat.id, `✅ Akses user \`${targetId}\` telah dicabut.`, { parse_mode: "Markdown" });
  bot.sendMessage(targetId, "❌ Akses kamu ke bot telah dicabut oleh owner.").catch(() => {});
});

bot.onText(/\/approve (.+)/, (msg, match) => {
  if (msg.from.id !== OWNER_ID) return;

  const targetId = parseInt(match[1].trim(), 10);
  if (isNaN(targetId)) {
    return bot.sendMessage(msg.chat.id, "❌ ID tidak valid.");
  }

  const users = readUsers();
  if (users.approved.includes(targetId)) {
    return bot.sendMessage(msg.chat.id, `⚠️ User \`${targetId}\` sudah di-approve sebelumnya.`, {
      parse_mode: "Markdown",
    });
  }

  approveUser(targetId);
  bot.sendMessage(msg.chat.id, `✅ User \`${targetId}\` berhasil di-approve secara manual.`, {
    parse_mode: "Markdown",
  });
  bot.sendMessage(targetId, "✅ Kamu telah di-approve oleh owner! Silakan gunakan bot dengan /start ulang.").catch(() => {});
});

// ==================== Callback Query ====================
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;
  const userId = query.from.id;

  await bot.answerCallbackQuery(query.id).catch(() => {});

  // ---------- Owner: Approve / Reject ----------
  if (userId === OWNER_ID) {
    if (data.startsWith("approve_")) {
      const targetId = parseInt(data.split("_")[1], 10);
      if (!isNaN(targetId)) {
        approveUser(targetId);
        safeEdit(
          chatId,
          messageId,
          `✅ User \`${targetId}\` telah di-approve.`,
          { parse_mode: "Markdown" }
        );
        bot.sendMessage(targetId, "✅ Permintaanmu telah disetujui! Silakan gunakan bot dengan /start ulang.").catch(() => {});
      }
      return;
    }

    if (data.startsWith("reject_")) {
      const targetId = parseInt(data.split("_")[1], 10);
      if (!isNaN(targetId)) {
        rejectUser(targetId);
        safeEdit(
          chatId,
          messageId,
          `❌ User \`${targetId}\` telah ditolak.`,
          { parse_mode: "Markdown" }
        );
        bot.sendMessage(targetId, "❌ Permintaanmu ditolak oleh owner.").catch(() => {});
      }
      return;
    }
  }

  // ---------- Cek akses ----------
  if (userId !== OWNER_ID && !isApproved(userId)) {
    return bot.answerCallbackQuery(query.id, {
      text: "❌ Kamu belum memiliki izin.",
      show_alert: true,
    });
  }

  // ---------- Back to menu ----------
  if (data === "back_to_menu") {
    delete chatState[chatId];
    return showMainMenu(chatId, messageId);
  }

  // ---------- Fitur ----------
  const currentUserId = userId === OWNER_ID ? OWNER_ID : userId;

  // Tambah pengirim
  if (data === "add_sender") {
    chatState[chatId] = { flow: "email", step: "add_sender_type", userId: currentUserId };
    return safeEdit(
      chatId,
      messageId,
      "Pilih *tipe pengirim*:",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "📧 Gmail SMTP", callback_data: "sender_type_gmail" },
              { text: "📨 Brevo SMTP", callback_data: "sender_type_brevo" },
            ],
            [BACK_BUTTON],
          ],
        },
      }
    );
  }

  if (data === "sender_type_gmail") {
    const state = chatState[chatId];
    if (!state || state.step !== "add_sender_type") return;
    state.senderType = "gmail";
    state.step = "add_sender_email";
    return safeEdit(
      chatId,
      messageId,
      "Masukkan *email Gmail* pengirim:",
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[BACK_BUTTON]] } }
    );
  }

  if (data === "sender_type_brevo") {
    const state = chatState[chatId];
    if (!state || state.step !== "add_sender_type") return;
    state.senderType = "brevo";

    // Cek apakah sudah ada akun Brevo tersimpan
    const emailData = readEmailData(currentUserId);
    const brevoAccounts = emailData.brevoAccounts || [];

    if (brevoAccounts.length > 0) {
      // Tampilkan pilihan: pakai akun existing atau tambah baru
      const accountButtons = brevoAccounts.map((acc, i) => [
        { text: `📨 ${acc.brevoEmail} (${acc.fromEmails.length} from)`, callback_data: `brevo_pick_acc_${i}` }
      ]);
      accountButtons.push([{ text: "➕ Tambah akun Brevo baru", callback_data: "brevo_new_acc" }]);
      accountButtons.push([BACK_BUTTON]);
      state.step = "brevo_pick_or_new";
      return safeEdit(chatId, messageId, "Pilih *akun Brevo* yang mau dipakai, atau tambah baru:", {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: accountButtons },
      });
    }

    // Belum ada akun Brevo, langsung ke input baru
    state.step = "add_sender_brevo_email";
    return safeEdit(chatId, messageId, "Masukkan *email akun Brevo* kamu (untuk login SMTP):", {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[BACK_BUTTON]] },
    });
  }

  // Pilih akun Brevo existing
  if (data.startsWith("brevo_pick_acc_")) {
    const state = chatState[chatId];
    if (!state) return;
    const idx = parseInt(data.split("_")[3], 10);
    const emailData = readEmailData(currentUserId);
    const acc = (emailData.brevoAccounts || [])[idx];
    if (!acc) return safeEdit(chatId, messageId, "❌ Akun tidak ditemukan.", { reply_markup: { inline_keyboard: [[BACK_BUTTON]] } });
    state.brevoEmail = acc.brevoEmail;
    state.step = "add_sender_brevo_from";
    return safeEdit(chatId, messageId,
      `Akun: \`${acc.brevoEmail}\`\n\nMasukkan *email pengirim (from)* yang sudah diverifikasi di Brevo:`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[BACK_BUTTON]] } }
    );
  }

  // Tambah akun Brevo baru
  if (data === "brevo_new_acc") {
    const state = chatState[chatId];
    if (!state) return;
    state.step = "add_sender_brevo_email";
    return safeEdit(chatId, messageId, "Masukkan *email akun Brevo* kamu (untuk login SMTP):", {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[BACK_BUTTON]] },
    });
  }

  // Tambah penerima
  if (data === "add_receiver") {
    chatState[chatId] = { flow: "email", step: "add_receiver", userId: currentUserId };
    return safeEdit(
      chatId,
      messageId,
      "Kirim *email penerima*:",
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[BACK_BUTTON]] } }
    );
  }

  // Hapus pengirim
  if (data === "delete_sender") {
    const emailData = readEmailData(currentUserId);
    if (!emailData.senders.length) {
      return safeEdit(
        chatId,
        messageId,
        "Tidak ada pengirim untuk dihapus.",
        { reply_markup: { inline_keyboard: [[BACK_BUTTON]] } }
      );
    }

    const inline_keyboard = emailData.senders.map((s, i) => [
      { text: `🗑️ ${s.email}`, callback_data: `del_sender_${i}` },
    ]);
    inline_keyboard.push([BACK_BUTTON]);

    return safeEdit(chatId, messageId, "Pilih pengirim yang ingin dihapus:", {
      reply_markup: { inline_keyboard },
    });
  }

  if (data.startsWith("del_sender_")) {
    const index = parseInt(data.split("_")[2], 10);
    const emailData = readEmailData(currentUserId);
    if (!isNaN(index) && emailData.senders[index]) {
      const deleted = emailData.senders[index].email;
      emailData.senders.splice(index, 1);
      saveEmailData(currentUserId, emailData);
      return safeEdit(
        chatId,
        messageId,
        `✅ Pengirim \`${deleted}\` berhasil dihapus.`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[BACK_BUTTON]] } }
      );
    }
    return safeEdit(chatId, messageId, "❌ Gagal menghapus pengirim.", {
      reply_markup: { inline_keyboard: [[BACK_BUTTON]] },
    });
  }

  // Hapus penerima
  if (data === "delete_receiver") {
    const emailData = readEmailData(currentUserId);
    if (!emailData.receivers.length) {
      return safeEdit(
        chatId,
        messageId,
        "Tidak ada penerima untuk dihapus.",
        { reply_markup: { inline_keyboard: [[BACK_BUTTON]] } }
      );
    }

    const inline_keyboard = emailData.receivers.map((email, i) => [
      { text: `🗑️ ${email}`, callback_data: `del_receiver_${i}` },
    ]);
    inline_keyboard.push([BACK_BUTTON]);

    return safeEdit(chatId, messageId, "Pilih penerima yang ingin dihapus:", {
      reply_markup: { inline_keyboard },
    });
  }

  if (data.startsWith("del_receiver_")) {
    const index = parseInt(data.split("_")[2], 10);
    const emailData = readEmailData(currentUserId);
    if (!isNaN(index) && emailData.receivers[index]) {
      const deleted = emailData.receivers[index];
      emailData.receivers.splice(index, 1);
      saveEmailData(currentUserId, emailData);
      return safeEdit(
        chatId,
        messageId,
        `✅ Penerima \`${deleted}\` berhasil dihapus.`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[BACK_BUTTON]] } }
      );
    }
    return safeEdit(chatId, messageId, "❌ Gagal menghapus penerima.", {
      reply_markup: { inline_keyboard: [[BACK_BUTTON]] },
    });
  }

  // List semua
  if (data === "list_all") {
    const emailData = readEmailData(currentUserId);
    let text = "📋 *Daftar Pengirim & Penerima*\n\n";

    // Gmail senders
    text += "*📧 Gmail:*\n";
    const gmailSenders = emailData.senders.filter(s => s.type === "gmail");
    if (gmailSenders.length) {
      gmailSenders.forEach((s, i) => { text += `${i + 1}. \`${s.email}\`\n`; });
    } else {
      text += "_Belum ada_\n";
    }

    // Brevo accounts
    text += "\n*📨 Brevo:*\n";
    const brevoAccounts = emailData.brevoAccounts || [];
    if (brevoAccounts.length) {
      brevoAccounts.forEach((acc) => {
        text += `• Login: \`${acc.brevoEmail}\`\n`;
        if (acc.fromEmails.length) {
          acc.fromEmails.forEach((f, j) => { text += `  ${j + 1}. \`${f}\`\n`; });
        } else {
          text += "  _Belum ada from email_\n";
        }
      });
    } else {
      text += "_Belum ada_\n";
    }

    text += "\n*Penerima:*\n";
    if (emailData.receivers.length) {
      emailData.receivers.forEach((email, i) => { text += `${i + 1}. \`${email}\`\n`; });
    } else {
      text += "_Belum ada_\n";
    }

    return safeEdit(chatId, messageId, text, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[BACK_BUTTON]] },
    });
  }

  // ========== Inbox Menu ==========
  if (data === "inbox_menu") {
    const cfg = inbox.getImapConfig(currentUserId);
    const active = inbox.isActive(currentUserId);
    const status = active ? "🟢 Aktif" : "🔴 Mati";
    const cfgInfo = cfg ? `\nAkun: \`${cfg.user}\`` : "\n_Belum dikonfigurasi_";
    return safeEdit(chatId, messageId,
      `📬 *Inbox Email Masuk*\n\nStatus: ${status}${cfgInfo}\n\nEmail masuk akan diteruskan ke sini. Balas pesan notifikasinya untuk membalas email langsung dari Telegram.`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "⚙️ Setup IMAP", callback_data: "inbox_setup" }],
    [active
? { text: "🔌 Disconnect",
   callback_data: "inbox_stop" }
: { text: "🔌 Connect", callback_data: "inbox_start" }
            ],
            [BACK_BUTTON],
          ],
        },
      }
    );
  }

  if (data === "inbox_setup") {
    chatState[chatId] = { flow: "inbox", step: "imap_host", userId: currentUserId };
    return safeEdit(chatId, messageId,
      "⚙️ *Setup IMAP*\n\nMasukkan *IMAP host*:\n_Contoh Gmail: imap.gmail.com_\n_Contoh Outlook: outlook.office365.com_",
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[BACK_BUTTON]] } }
    );
  }

  if (data === "inbox_start") {
    if (!inbox.getImapConfig(currentUserId)) {
      return safeEdit(chatId, messageId, "❌ Belum ada konfigurasi IMAP. Setup dulu.", {
        reply_markup: { inline_keyboard: [[{ text: "⚙️ Setup IMAP", callback_data: "inbox_setup" }], [BACK_BUTTON]] },
      });
    }
    inbox.startPolling(currentUserId);
    return safeEdit(chatId, messageId, "✅ Inbox *connect*. Email masuk akan diteruskan ke sini.",
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[BACK_BUTTON]] } }
    );
  }

  if (data === "inbox_stop") {
    inbox.stopPolling(currentUserId);
    return safeEdit(chatId, messageId, "⏹ Inbox *disconnect*.",
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[BACK_BUTTON]] } }
    );
  }

  // Send email — step 1: pilih pengirim
  if (data === "send_email") {
    const emailData = readEmailData(currentUserId);
    const allSenders = getAllSenders(currentUserId);
    if (!allSenders.length || !emailData.receivers.length) {
      return safeEdit(
        chatId,
        messageId,
        "❌ Harus ada minimal 1 pengirim dan 1 penerima.",
        { reply_markup: { inline_keyboard: [[BACK_BUTTON]] } }
      );
    }
    // Init state dengan semua pengirim tercentang
    chatState[chatId] = {
      flow: "email",
      step: "pick_senders",
      userId: currentUserId,
      selectedSenders: allSenders.map((_, i) => i), // semua dipilih by default
    };
    return safeEdit(chatId, messageId, ...buildPickSendersMessage(allSenders, allSenders.map((_, i) => i)));
  }

  // Toggle pilihan pengirim
  if (data.startsWith("toggle_sender_")) {
    const state = chatState[chatId];
    if (!state || state.step !== "pick_senders") return;
    const idx = parseInt(data.split("_")[2], 10);
    const allSenders = getAllSenders(state.userId);
    const sel = state.selectedSenders;
    if (sel.includes(idx)) {
      state.selectedSenders = sel.filter((i) => i !== idx);
    } else {
      state.selectedSenders = [...sel, idx].sort((a, b) => a - b);
    }
    return safeEdit(chatId, messageId, ...buildPickSendersMessage(allSenders, state.selectedSenders));
  }

  // Toggle semua pengirim
  if (data === "toggle_all_senders") {
    const state = chatState[chatId];
    if (!state || state.step !== "pick_senders") return;
    const allSenders = getAllSenders(state.userId);
    if (state.selectedSenders.length === allSenders.length) {
      state.selectedSenders = [];
    } else {
      state.selectedSenders = allSenders.map((_, i) => i);
    }
    return safeEdit(chatId, messageId, ...buildPickSendersMessage(allSenders, state.selectedSenders));
  }

  // Konfirmasi pilihan pengirim → lanjut ke subjek
  if (data === "confirm_senders") {
    const state = chatState[chatId];
    if (!state || state.step !== "pick_senders") return;
    if (!state.selectedSenders.length) {
      return bot.answerCallbackQuery(query.id, { text: "⚠️ Pilih minimal 1 pengirim!", show_alert: true });
    }
    state.step = "send_subject";
    return safeEdit(chatId, messageId, "Masukkan *Subjek / Judul* email:", {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[BACK_BUTTON]] },
    });
  }
});

// ==================== Message Handler ====================
bot.on("message", async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  if (msg.text && msg.text.startsWith("/")) return;

  // ========== Reply ke email masuk ==========
  // Deteksi saat user reply ke pesan notifikasi "↩️ Balas pesan ini..."
  if (
    msg.reply_to_message &&
    msg.reply_to_message.text &&
    msg.reply_to_message.text.startsWith("↩️ Balas pesan ini untuk membalas email ke")
  ) {
    const repliedMsgId = msg.reply_to_message.message_id;

    // Ambil metadata dari Map (disimpan waktu email masuk)
    const meta = replyMeta.get(repliedMsgId);
    let toEmail, replySubject, replyMsgId;

    if (meta) {
      toEmail = meta.to;
      replySubject = meta.subject ? (meta.subject.startsWith("Re:") ? meta.subject : `Re: ${meta.subject}`) : "Re:";
      replyMsgId = meta.msgId || null;
      replyMeta.delete(repliedMsgId); // bersihkan setelah dipakai
    } else {
      // Fallback: ekstrak email dari teks pesan kalau metadata tidak ada (misal setelah restart)
      const match = msg.reply_to_message.text.match(/ke\s+([^\s@]+@[^\s@]+\.[^\s]+)/);
      if (!match) return bot.sendMessage(chatId, "❌ Tidak bisa membaca alamat email tujuan dari pesan itu.");
      toEmail = match[1];
      replySubject = "Re:";
      replyMsgId = null;
    }

    const replyBody = msg.text.trim();

    const allSenders = getAllSenders(userId);
    if (!allSenders.length) {
      return bot.sendMessage(chatId, "❌ Belum ada pengirim terdaftar. Tambahkan dulu via menu.");
    }
    const sender = allSenders.find(s => s.type === "brevo") || allSenders[0];

    try {
      await sendEmail(sender, toEmail, replySubject, replyBody, replyMsgId);
      return bot.sendMessage(chatId, `✅ Balasan terkirim ke \`${toEmail}\``, { parse_mode: "Markdown" });
    } catch (err) {
      console.error("❌ Gagal kirim balasan:", err.message);
      return bot.sendMessage(chatId, `❌ Gagal kirim: ${err.message}`);
    }
  }

  const state = chatState[chatId];
  if (!state) return;

  if (userId !== OWNER_ID && !isApproved(userId)) {
    delete chatState[chatId];
    return;
  }

  const text = msg.text.trim();

  try {
    // ---------- Add Pengirim ----------

    // Gmail: email → appPassword
    if (state.step === "add_sender_email") {
      if (!isValidEmail(text)) {
        return bot.sendMessage(chatId, "❌ Format email tidak valid. Masukkan email yang benar (contoh: user@gmail.com).");
      }
      state.senderEmail = text;
      state.step = "add_sender_password";
      return bot.sendMessage(chatId, "Masukkan *App Password* Gmail (16 digit):", {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[BACK_BUTTON]] },
      });
    }

    if (state.step === "add_sender_password") {
      if (text.length < 8) {
        return bot.sendMessage(chatId, "❌ Password terlalu pendek (minimal 8 karakter).");
      }
      const success = addGmailSender(state.userId, state.senderEmail, text);
      delete chatState[chatId];
      return bot.sendMessage(chatId, success ? "✅ Pengirim Gmail berhasil ditambahkan." : "⚠️ Email sudah terdaftar.");
    }

    // Brevo: brevoEmail → apiKey → fromEmail (akun baru)
    if (state.step === "add_sender_brevo_email") {
      if (!isValidEmail(text)) {
        return bot.sendMessage(chatId, "❌ Format email tidak valid.");
      }
      state.brevoEmail = text;
      state.step = "add_sender_brevo_apikey";
      return bot.sendMessage(chatId, "Masukkan *SMTP API Key* Brevo kamu:\n\n_(Brevo → SMTP & API → SMTP → Generate a new SMTP key)_", {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[BACK_BUTTON]] },
      });
    }

    if (state.step === "add_sender_brevo_apikey") {
      if (text.length < 8) {
        return bot.sendMessage(chatId, "❌ API Key terlalu pendek.");
      }
      state.apiKey = text;
      // Simpan akun Brevo dulu, lalu minta fromEmail
      addBrevoAccount(state.userId, state.brevoEmail, state.apiKey);
      state.step = "add_sender_brevo_from";
      return bot.sendMessage(chatId, "Akun Brevo disimpan! ✅\n\nSekarang masukkan *email pengirim (from)* yang sudah diverifikasi di Brevo:", {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[BACK_BUTTON]] },
      });
    }

    // fromEmail — dipakai baik dari akun existing maupun akun baru
    if (state.step === "add_sender_brevo_from") {
      if (!isValidEmail(text)) {
        return bot.sendMessage(chatId, "❌ Format email tidak valid.");
      }
      const result = addBrevoFromEmail(state.userId, state.brevoEmail, text);
      delete chatState[chatId];
      if (result === "ok") return bot.sendMessage(chatId, `✅ Email pengirim \`${text}\` berhasil ditambahkan ke akun Brevo.`, { parse_mode: "Markdown" });
      if (result === "duplicate") return bot.sendMessage(chatId, "⚠️ Email pengirim sudah terdaftar di akun ini.");
      return bot.sendMessage(chatId, "❌ Akun Brevo tidak ditemukan.");
    }

    // ---------- Add Penerima ----------
    if (state.step === "add_receiver") {
      if (!isValidEmail(text)) {
        return bot.sendMessage(chatId, "❌ Format email tidak valid.");
      }
      const success = addReceiver(state.userId, text);
      delete chatState[chatId];
      return bot.sendMessage(chatId, success ? "✅ Penerima berhasil ditambahkan." : "⚠️ Email sudah terdaftar.");
    }

    // ---------- Send Email ----------
    if (state.step === "send_subject") {
      state.subject = text;
      state.step = "send_body";
      return bot.sendMessage(chatId, "Masukkan *Isi Pesan* email:", {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[BACK_BUTTON]] },
      });
    }

    if (state.step === "send_body") {
      state.body = text;
      state.step = "send_count";
      return bot.sendMessage(chatId, "Masukkan *Jumlah kirim per pengirim* (contoh: 3, maks 500):", {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[BACK_BUTTON]] },
      });
    }

    // ========== Setup IMAP ==========
    if (state.flow === "inbox") {
      if (state.step === "imap_host") {
        state.imapHost = text;
        state.step = "imap_user";
        return bot.sendMessage(chatId, "Masukkan *email akun IMAP* (email yang diteruskan Cloudflare):", {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[BACK_BUTTON]] },
        });
      }

      if (state.step === "imap_user") {
        if (!isValidEmail(text)) return bot.sendMessage(chatId, "❌ Format email tidak valid.");
        state.imapUser = text;
        state.step = "imap_password";
        return bot.sendMessage(chatId, "Masukkan *App Password* akun tersebut:", {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[BACK_BUTTON]] },
        });
      }

      if (state.step === "imap_password") {
        if (text.length < 8) return bot.sendMessage(chatId, "❌ Password terlalu pendek.");
        const isGmail = state.imapHost.includes("gmail");
        const cfg = {
          host: state.imapHost,
          port: isGmail ? 993 : 993,
          tls: true,
          user: state.imapUser,
          password: text,
        };
        inbox.setImapConfig(state.userId, cfg); // simpan per user (ke users/{userId}/imap_config.json)
        inbox.startPolling(state.userId);
        delete chatState[chatId];
        return bot.sendMessage(chatId,
          `✅ IMAP dikonfigurasi!\n\n📬 Polling aktif — email masuk ke \`${cfg.user}\` akan diteruskan ke sini.\n\nBalas pesan notifikasi email untuk membalas langsung.`,
          { parse_mode: "Markdown" }
        );
      }
    }

    if (state.step === "send_count") {
      const count = parseInt(text, 10);
      if (isNaN(count) || count < 1) {
        return bot.sendMessage(chatId, "❌ Jumlah harus angka minimal 1.");
      }
      if (count > MAX_SEND_COUNT) {
        return bot.sendMessage(chatId, `❌ Jumlah terlalu besar. Maksimal ${MAX_SEND_COUNT}.`);
      }

      const emailData = readEmailData(state.userId);
      const allSenders = getAllSenders(state.userId);
      // Hanya pakai pengirim yang dipilih user
      const senders = (state.selectedSenders && state.selectedSenders.length)
        ? state.selectedSenders.map((i) => allSenders[i]).filter(Boolean)
        : allSenders;
      const { receivers } = emailData;
      delete chatState[chatId];

      const statusMsg = await bot.sendMessage(chatId, "⏳ Sedang mengirim email...\nSabar ya kakak agak lama 🤗");

      let success = 0,
        failed = 0;

      // Kirim secara berurutan
      for (const sender of senders) {
        for (const receiver of receivers) {
          for (let i = 0; i < count; i++) {
            try {
              await sendEmail(sender, receiver, state.subject, state.body);
              success++;
            } catch (err) {
              console.error(`Gagal kirim ke ${receiver}:`, err.message);
              failed++;
            }
            // jeda 1.2 detik
            await new Promise((r) => setTimeout(r, 1200));
          }
        }
      }

      await bot.editMessageText(
        `✅ *Pengiriman Selesai!*\n\nBerhasil: ${success}\nGagal: ${failed}`,
        { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" }
      ).catch(() => {});
    }
  } catch (error) {
    console.error("Error di message handler:", error);
    delete chatState[chatId];
    bot.sendMessage(chatId, "❌ Terjadi kesalahan. Silakan coba lagi.").catch(() => {});
  }
});

console.log("✅ Bot Email aktif.");
