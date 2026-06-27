const Imap = require("imap");
const { simpleParser } = require("mailparser");
const fs = require("fs");
const path = require("path");

// State per-user
const userSessions = {};

// Map: telegramMessageId -> { to, subject, msgId }
const replyMeta = new Map();

let botInstance = null;

function init(bot) {
  botInstance = bot;
}

function getImapConfigFile(userId) {
  const dir = path.join(__dirname, "users", String(userId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "imap_config.json");
}

function getSession(userId) {
  if (!userSessions[userId]) {
    userSessions[userId] = { imapConfig: null, imap: null, isConnected: false };
  }
  return userSessions[userId];
}

function setImapConfig(userId, config) {
  const session = getSession(userId);
  session.imapConfig = config;
  fs.writeFileSync(getImapConfigFile(userId), JSON.stringify(config, null, 2));
}

function getImapConfig(userId) {
  const session = getSession(userId);
  if (!session.imapConfig) {
    const file = getImapConfigFile(userId);
    if (fs.existsSync(file)) {
      try {
        session.imapConfig = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (e) {}
    }
  }
  return session.imapConfig;
}

function escapeMd(str) {
  return String(str || "").replace(/[_*`[]/g, (c) => "\\" + c);
}

function formatIncomingEmail({ from, subject, body, date }) {
  const fromStr = escapeMd(from || "unknown");
  const subjectStr = escapeMd(subject || "(tanpa subjek)");
  const rawBody = (body || "(kosong)").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const bodyStr = escapeMd(rawBody.substring(0, 2000));
  const dateStr = date ? new Date(date).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }) : "-";

  return (
    `📥 *EMAIL MASUK*\n\n` +
    `👤 *Dari:* ${fromStr}\n` +
    `📌 *Subjek:* ${subjectStr}\n` +
    `🕐 *Waktu:* ${dateStr}\n\n` +
    `💬 *Isi:*\n${bodyStr}`
  );
}

function extractEmail(fromStr) {
  if (!fromStr) return null;
  const match = fromStr.match(/<([^>]+)>/);
  if (match) return match[1].trim();
  const plain = fromStr.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(plain)) return plain;
  return null;
}

// Fetch & proses satu email berdasarkan UID, lalu kirim ke Telegram
function processMessage(imap, uid, userId) {
  return new Promise((resolve) => {
    const f = imap.fetch(uid, { bodies: "", markSeen: true });

    f.on("message", (msg) => {
      const chunks = [];
      msg.on("body", (stream) => {
        stream.on("data", (chunk) => chunks.push(chunk));
        stream.on("end", async () => {
          try {
            const raw = Buffer.concat(chunks);
            const parsed = await simpleParser(raw);

            const fromRaw = parsed.from?.text || "";
            const fromEmail = extractEmail(fromRaw);
            const subject = parsed.subject || "";
            const body = parsed.text || parsed.html || "";
            const date = parsed.date;

            const telegramText = formatIncomingEmail({ from: fromRaw, subject, body, date });
            await botInstance.sendMessage(userId, telegramText, { parse_mode: "Markdown" });

            const replyPrompt = await botInstance.sendMessage(
              userId,
              `↩️ Balas pesan ini untuk membalas email ke ${fromEmail}`,
              { reply_markup: { force_reply: true, selective: true } }
            );

            replyMeta.set(replyPrompt.message_id, {
              to: fromEmail,
              subject: subject,
              msgId: parsed.messageId || "",
            });
          } catch (err) {
            console.error(`❌ Gagal proses email (user ${userId}):`, err.message);
          }
          resolve();
        });
      });
    });

    f.once("error", (err) => {
      console.error(`❌ Fetch error (user ${userId}):`, err.message);
      resolve();
    });
  });
}

// Fetch semua UNSEEN saat pertama connect
function fetchUnseen(imap, userId) {
  imap.search(["UNSEEN"], (err, uids) => {
    if (err || !uids || !uids.length) return;
    console.log(`📬 ${uids.length} email unseen ditemukan (user ${userId})`);
    // Proses satu per satu supaya tidak flood Telegram
    uids.reduce((chain, uid) => {
      return chain.then(() => processMessage(imap, uid, userId));
    }, Promise.resolve());
  });
}

function startIdleLoop(imap, userId) {
  // Buka INBOX lalu mulai IDLE
  imap.openBox("INBOX", false, (err) => {
    if (err) {
      console.error(`❌ Gagal buka INBOX (user ${userId}):`, err.message);
      return scheduleReconnect(userId);
    }

    console.log(`📬 IMAP IDLE aktif (user ${userId})`);

    // Cek email yang sudah ada tapi belum dibaca
    fetchUnseen(imap, userId);

    // Tiap ada email baru, Gmail kirim event 'mail'
    imap.on("mail", () => {
      console.log(`📩 Email baru masuk (user ${userId})`);
      fetchUnseen(imap, userId);
    });
  });
}

function scheduleReconnect(userId) {
  const session = getSession(userId);
  if (!session.imapConfig) return;
  session.isConnected = false;
  console.log(`🔄 Reconnect dalam 15 detik (user ${userId})...`);
  setTimeout(() => connect(userId), 15000);
}

function connect(userId) {
  const session = getSession(userId);
  if (!session.imapConfig) return;
  if (session.isConnected) return;

  const cfg = session.imapConfig;

  const imap = new Imap({
    user: cfg.user,
    password: cfg.password,
    host: cfg.host,
    port: cfg.port || 993,
    tls: cfg.tls !== false,
    tlsOptions: { rejectUnauthorized: false },
    keepalive: {
      interval: 10000,   // ping tiap 10 detik
      idleInterval: 300000, // re-IDLE tiap 5 menit
      forceNoop: true,
    },
    authTimeout: 15000,
  });

  session.imap = imap;

  imap.once("ready", () => {
    session.isConnected = true;
    startIdleLoop(imap, userId);
  });

  imap.on("error", (err) => {
    console.error(`❌ IMAP error (user ${userId}):`, err.message);
    if (botInstance) {
      botInstance.sendMessage(userId, `⚠️ Koneksi inbox terputus: ${err.message}\nMencoba reconnect...`).catch(() => {});
    }
    scheduleReconnect(userId);
  });

  imap.once("end", () => {
    console.log(`📭 Koneksi IMAP ditutup (user ${userId})`);
    session.isConnected = false;
  });

  imap.connect();
}

function startPolling(userId) {
  const session = getSession(userId);
  if (session.isConnected) return;
  connect(userId);
}

function stopPolling(userId) {
  const session = getSession(userId);
  if (session.imap) {
    try { session.imap.end(); } catch (e) {}
    session.imap = null;
  }
  session.isConnected = false;
  console.log(`📭 Inbox dihentikan (user ${userId})`);
}

function isActive(userId) {
  return !!getSession(userId).isConnected;
}

function loadAllAndStart() {
  const usersDir = path.join(__dirname, "users");
  if (!fs.existsSync(usersDir)) return;
  for (const userDir of fs.readdirSync(usersDir)) {
    const configFile = path.join(usersDir, userDir, "imap_config.json");
    if (fs.existsSync(configFile)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(configFile, "utf8"));
        const userId = Number(userDir);
        getSession(userId).imapConfig = cfg;
        startPolling(userId);
        console.log(`📬 Auto-start IDLE inbox user ${userId}`);
      } catch (e) {
        console.error(`❌ Gagal load imap_config user ${userDir}:`, e.message);
      }
    }
  }
}

module.exports = {
  init,
  setImapConfig,
  getImapConfig,
  startPolling,
  stopPolling,
  isActive,
  loadAllAndStart,
  extractEmail,
  replyMeta,
};
