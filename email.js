const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");

function getUserEmailFile(userId) {
  const dir = path.join(__dirname, "users", String(userId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "email.json");
}

function readEmailData(userId) {
  const file = getUserEmailFile(userId);
  if (!fs.existsSync(file)) {
    const defaultData = { senders: [], receivers: [] };
    fs.writeFileSync(file, JSON.stringify(defaultData, null, 2));
    return defaultData;
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function saveEmailData(userId, data) {
  const file = getUserEmailFile(userId);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function addSender(userId, email, appPassword) {
  const data = readEmailData(userId);
  if (data.senders.find(s => s.email === email)) return false;
  data.senders.push({ email, appPassword });
  saveEmailData(userId, data);
  return true;
}

function addReceiver(userId, email) {
  const data = readEmailData(userId);
  if (data.receivers.includes(email)) return false;
  data.receivers.push(email);
  saveEmailData(userId, data);
  return true;
}

async function sendEmail(sender, to, subject, text) {
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user: sender.email,
      pass: sender.appPassword,
    },
  });

  return transporter.sendMail({
    from: sender.email,
    to: to,
    subject: subject,
    text: text,
  });
}

module.exports = {
  readEmailData,
  saveEmailData,
  addSender,
  addReceiver,
  sendEmail,
};
