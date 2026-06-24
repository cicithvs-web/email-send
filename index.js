require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { 
    readEmailData, 
    addSender, 
    addReceiver, 
    sendEmail, 
    saveEmailData 
} = require("./email");

const fs = require("fs");
const path = require("path");

const bot = new TelegramBot(process.env.EMAIL_BOT_TOKEN, { polling: true });
const chatState = {};

const BACK_BUTTON = { text: "⬅️ Kembali", callback_data: "back_to_menu" };
const USERS_FILE = path.join(__dirname, "users.json");

// ==================== User Management ====================
function readUsers() {
    if (!fs.existsSync(USERS_FILE)) {
        const defaultData = { approved: [], pending: [] };
        fs.writeFileSync(USERS_FILE, JSON.stringify(defaultData, null, 2));
        return defaultData;
    }
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
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
    data.pending = data.pending.filter(id => id != userId);
    if (!data.approved.includes(userId)) data.approved.push(userId);
    saveUsers(data);
}

function rejectUser(userId) {
    const data = readUsers();
    data.pending = data.pending.filter(id => id != userId);
    saveUsers(data);
}

function revokeUser(userId) {
    const data = readUsers();
    data.approved = data.approved.filter(id => id != userId);
    saveUsers(data);
}

// ==================== Menu Utama ====================
function showMainMenu(chatId, messageId = null) {
    const text = `📧 *Email Bot*\n\nPilih menu di bawah:`;
    const keyboard = {
        inline_keyboard: [
            [{ text: "➕ Add Pengirim", callback_data: "add_sender" },
             { text: "➕ Add Penerima", callback_data: "add_receiver" }],
            [{ text: "🗑️ Hapus Pengirim", callback_data: "delete_sender" },
             { text: "🗑️ Hapus Penerima", callback_data: "delete_receiver" }],
            [{ text: "📋 List Pengirim & Penerima", callback_data: "list_all" }],
            [{ text: "🚀 Send Email", callback_data: "send_email" }]
        ]
    };

    if (messageId) {
        bot.editMessageText(text, {
            chat_id: chatId, message_id: messageId, parse_mode: "Markdown", reply_markup: keyboard
        }).catch(() => {});
    } else {
        bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: keyboard });
    }
}

// ==================== /start ====================
bot.onText(/\/start/, (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    if (userId == process.env.OWNER_ID) {
        return showMainMenu(chatId);
    }

    if (isApproved(userId)) {
        return showMainMenu(chatId);
    }

    if (isPending(userId)) {
        return bot.sendMessage(chatId, "⏳ Permintaanmu sudah dikirim ke owner. Mohon tunggu persetujuan.");
    }

    requestAccess(userId);
    bot.sendMessage(chatId, 
        "❌ Maaf, kamu belum memiliki izin menggunakan bot ini.\n\n" +
        "Permintaan akses sudah dikirim ke owner. Mohon tunggu persetujuan."
    );

    bot.sendMessage(process.env.OWNER_ID, 
        `📩 *Permintaan Akses Baru*\n\n` +
        `User ID: \`${userId}\`\n` +
        `Nama: ${msg.from.first_name || ""} ${msg.from.last_name || ""}\n` +         `Username: @${msg.from.username || "Tidak ada"}`,
        {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "✅ Approve", callback_data: `approve_${userId}` },
                        { text: "❌ Reject", callback_data: `reject_${userId}` }
                    ]
                ]
            }
        }
    );
});
// ==================== Command Owner: /listusers ====================
bot.onText(/\/listusers/, (msg) => {
    if (msg.from.id != process.env.OWNER_ID) return;

    const users = readUsers();
    let text = `📋 *Daftar User*\n\n`;

    text += `*✅ Approved (${users.approved.length}):*\n`;
    if (users.approved.length > 0) {
        users.approved.forEach((id, i) => {
            text += `${i + 1}. \`${id}\`\n`;
        });
    } else {
        text += `_Tidak ada_\n`;
    }

    text += `\n*⏳ Pending (${users.pending.length}):*\n`;
    if (users.pending.length > 0) {
        users.pending.forEach((id, i) => {
            text += `${i + 1}. \`${id}\`\n`;
        });
    } else {
        text += `_Tidak ada_\n`;
    }

    bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

// ==================== Command Owner: /revoke ====================
bot.onText(/\/revoke (.+)/, (msg, match) => {
    if (msg.from.id != process.env.OWNER_ID) return;

    const targetId = parseInt(match[1].trim());
    const users = readUsers();

    if (!users.approved.includes(targetId)) {
        return bot.sendMessage(msg.chat.id, `❌ User \`${targetId}\` tidak ditemukan di daftar approved.`, {
            parse_mode: "Markdown"
        });
    }

    revokeUser(targetId);

    bot.sendMessage(msg.chat.id, `✅ Akses user \`${targetId}\` telah dicabut.`, {
        parse_mode: "Markdown"
    });

    // Beritahu user yang dicabut
    bot.sendMessage(targetId, "❌ Akses kamu ke bot telah dicabut oleh owner.").catch(() => {});
});
// ==================== Command Owner: /approve ====================
bot.onText(/\/approve (.+)/, (msg, match) => {
    if (msg.from.id != process.env.OWNER_ID) return;

    const targetId = parseInt(match[1].trim());
    const users = readUsers();

    if (users.approved.includes(targetId)) {
        return bot.sendMessage(msg.chat.id, `⚠️ User \`${targetId}\` sudah di-approve sebelumnya.`, {
            parse_mode: "Markdown"
        });
    }

    approveUser(targetId);

    bot.sendMessage(msg.chat.id, `✅ User \`${targetId}\` berhasil di-approve secara manual.`, {
        parse_mode: "Markdown"
    });

    // Beritahu user yang di-approve
    bot.sendMessage(targetId, "✅ Kamu telah di-approve oleh owner! Silakan gunakan bot.").catch(() => {});
});

// ==================== Callback Query ====================
bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data;
    const userId = query.from.id;

    bot.answerCallbackQuery(query.id).catch(() => {});

    // Owner Approve / Reject
    if (userId == process.env.OWNER_ID) {
        if (data.startsWith("approve_")) {
            const targetId = parseInt(data.split("_")[1]);
            approveUser(targetId);
            bot.editMessageText(`✅ User \`${targetId}\` telah di-approve.`, {
                chat_id: chatId, message_id: messageId, parse_mode: "Markdown"
            });
            bot.sendMessage(targetId, "✅ Permintaanmu telah disetujui! Silakan gunakan bot.");
            return;
        }

        if (data.startsWith("reject_")) {
            const targetId = parseInt(data.split("_")[1]);
            rejectUser(targetId);
            bot.editMessageText(`❌ User \`${targetId}\` telah ditolak.`, {
                chat_id: chatId, message_id: messageId, parse_mode: "Markdown"
            });
            bot.sendMessage(targetId, "❌ Permintaanmu ditolak oleh owner.");
            return;
        }
    }

    // Cek akses
    if (userId != process.env.OWNER_ID && !isApproved(userId)) {
        return bot.answerCallbackQuery(query.id, { 
            text: "❌ Kamu belum memiliki izin.", 
            show_alert: true 
        });
    }

    // Kembali ke menu
    if (data === "back_to_menu") {
        delete chatState[chatId];
        return showMainMenu(chatId, messageId);
    }

    // ==================== FITUR ====================
    const currentUserId = (userId == process.env.OWNER_ID) ? process.env.OWNER_ID : userId;

    if (data === "add_sender") {
        chatState[chatId] = { flow: "email", step: "add_sender_email", userId: currentUserId };
        return bot.editMessageText("Kirim *email pengirim* (Gmail):", {
            chat_id: chatId, message_id: messageId, parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [[BACK_BUTTON]] }
        });
    }

    if (data === "add_receiver") {
        chatState[chatId] = { flow: "email", step: "add_receiver", userId: currentUserId };
        return bot.editMessageText("Kirim *email penerima*:", {
            chat_id: chatId, message_id: messageId, parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [[BACK_BUTTON]] }
        });
    }

    if (data === "delete_sender") {
        const emailData = readEmailData(currentUserId);
        if (!emailData.senders.length) {
            return bot.editMessageText("Tidak ada pengirim untuk dihapus.", {
                chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [[BACK_BUTTON]] }
            });
        }

        const inline_keyboard = emailData.senders.map((s, i) => ([
            { text: `🗑️ ${s.email}`, callback_data: `del_sender_${i}` }
        ]));
        inline_keyboard.push([BACK_BUTTON]);

        return bot.editMessageText("Pilih pengirim yang ingin dihapus:", {
            chat_id: chatId, message_id: messageId,
            reply_markup: { inline_keyboard }
        });
    }

    if (data.startsWith("del_sender_")) {
        const index = parseInt(data.split("_")[2]);
        const emailData = readEmailData(currentUserId);
        if (emailData.senders[index]) {
            const deleted = emailData.senders[index].email;
            emailData.senders.splice(index, 1);
            saveEmailData(currentUserId, emailData);
            return bot.editMessageText(`✅ Pengirim \`${deleted}\` berhasil dihapus.`, {
                chat_id: chatId, message_id: messageId, parse_mode: "Markdown",
                reply_markup: { inline_keyboard: [[BACK_BUTTON]] }
            });
        }
    }

    if (data === "delete_receiver") {
        const emailData = readEmailData(currentUserId);
        if (!emailData.receivers.length) {
            return bot.editMessageText("Tidak ada penerima untuk dihapus.", {
                chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [[BACK_BUTTON]] }
            });
        }

        const inline_keyboard = emailData.receivers.map((email, i) => ([
            { text: `🗑️ ${email}`, callback_data: `del_receiver_${i}` }
        ]));
        inline_keyboard.push([BACK_BUTTON]);

        return bot.editMessageText("Pilih penerima yang ingin dihapus:", {
            chat_id: chatId, message_id: messageId,
            reply_markup: { inline_keyboard }
        });
    }

    if (data.startsWith("del_receiver_")) {
        const index = parseInt(data.split("_")[2]);
        const emailData = readEmailData(currentUserId);
        if (emailData.receivers[index]) {
            const deleted = emailData.receivers[index];
            emailData.receivers.splice(index, 1);
            saveEmailData(currentUserId, emailData);
            return bot.editMessageText(`✅ Penerima \`${deleted}\` berhasil dihapus.`, {
                chat_id: chatId, message_id: messageId, parse_mode: "Markdown",
                reply_markup: { inline_keyboard: [[BACK_BUTTON]] }
            });
        }
    }

    if (data === "list_all") {
        const emailData = readEmailData(currentUserId);
        let text = "📋 *Daftar Pengirim & Penerima*\n\n";

        text += "*Pengirim:*\n";
        emailData.senders.length 
            ? emailData.senders.forEach((s, i) => text += `${i + 1}. \`${s.email}\`\n`)
            : text += "_Belum ada_\n";

        text += "\n*Penerima:*\n";
        emailData.receivers.length 
            ? emailData.receivers.forEach((email, i) => text += `${i + 1}. \`${email}\`\n`)
            : text += "_Belum ada_\n";

        return bot.editMessageText(text, {
            chat_id: chatId, message_id: messageId, parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [[BACK_BUTTON]] }
        });
    }

    if (data === "send_email") {
        const emailData = readEmailData(currentUserId);
        if (!emailData.senders.length || !emailData.receivers.length) {
            return bot.editMessageText("❌ Harus ada minimal 1 pengirim dan 1 penerima.", {
                chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [[BACK_BUTTON]] }
            });
        }
        chatState[chatId] = { flow: "email", step: "send_subject", userId: currentUserId };
        return bot.editMessageText("Masukkan *Subjek / Judul* email:", {
            chat_id: chatId, message_id: messageId, parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [[BACK_BUTTON]] }
        });
    }
});

// ==================== Message Handler ====================
bot.on("message", async (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    if (msg.text && msg.text.startsWith("/")) return;

    const state = chatState[chatId];
    if (!state) return;

    // Cek akses
    if (userId != process.env.OWNER_ID && !isApproved(userId)) return;

    const text = msg.text.trim();

    // Add Pengirim
    if (state.step === "add_sender_email") {
        state.senderEmail = text;
        state.step = "add_sender_password";
        return bot.sendMessage(chatId, "Masukkan *App Password* (16 digit):", {
            parse_mode: "Markdown", reply_markup: { inline_keyboard: [[BACK_BUTTON]] }
        });
    }

    if (state.step === "add_sender_password") {
        const success = addSender(state.userId, state.senderEmail, text);
        delete chatState[chatId];
        return bot.sendMessage(chatId, success 
            ? "✅ Pengirim berhasil ditambahkan." 
            : "⚠️ Email sudah terdaftar.");
    }

    // Add Penerima
    if (state.step === "add_receiver") {
        const success = addReceiver(state.userId, text);
        delete chatState[chatId];
        return bot.sendMessage(chatId, success 
            ? "✅ Penerima berhasil ditambahkan." 
            : "⚠️ Email sudah terdaftar.");
    }

    // Send Email
    if (state.step === "send_subject") {
        state.subject = text;
        state.step = "send_body";
        return bot.sendMessage(chatId, "Masukkan *Isi Pesan* email:", {
            reply_markup: { inline_keyboard: [[BACK_BUTTON]] }
        });
    }

    if (state.step === "send_body") {
        state.body = text;
        state.step = "send_count";
        return bot.sendMessage(chatId, "Masukkan *Jumlah kirim per pengirim* (contoh: 3):", {
            reply_markup: { inline_keyboard: [[BACK_BUTTON]] }
        });
    }

    if (state.step === "send_count") {
        const count = parseInt(text);
        if (isNaN(count) || count < 1) {
            return bot.sendMessage(chatId, "Jumlah harus angka minimal 1.");
        }

        const emailData = readEmailData(state.userId);
        const { senders, receivers } = emailData;
        delete chatState[chatId];

        const statusMsg = await bot.sendMessage(chatId, "⏳ Sedang mengirim email...");

        let success = 0, failed = 0;

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
                    await new Promise(r => setTimeout(r, 1200));
                }
            }
        }

        await bot.editMessageText(
            `✅ *Pengiriman Selesai!*\n\nBerhasil: ${success}\nGagal: ${failed}`,
            { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" }
        );
    }
});

console.log("Active Email Bot");
