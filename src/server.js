import express from "express";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import pino from "pino";
import QRCode from "qrcode";
import { Server } from "socket.io";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestWaWebVersion,
  downloadMediaMessage
} from "@whiskeysockets/baileys";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT || 3000);
const AUTH_DIR = path.join(__dirname, "..", "auth_info");

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..")));

const state = {
  connected: false,
  connecting: false,
  phone: null,
  qr: null,
  pairingCode: null,
  pairingPhone: null,
  loginMode: "qr",
  botName: "LemonLeek Bot",
  prefix: ".",
  autoReply: true,
  logs: [],
  messages: [],
  groups: 0,
  contacts: 0
};

let sock = null;
let reconnectTimer = null;

function log(type, message, meta = {}) {
  const item = {
    id: crypto.randomUUID(),
    type,
    message,
    meta,
    at: new Date().toISOString()
  };
  state.logs.unshift(item);
  state.logs = state.logs.slice(0, 100);
  io.emit("log", item);
  return item;
}

function snapshot() {
  return {
    connected: state.connected,
    connecting: state.connecting,
    phone: state.phone,
    qr: state.qr,
    pairingCode: state.pairingCode,
    pairingPhone: state.pairingPhone,
    loginMode: state.loginMode,
    botName: state.botName,
    prefix: state.prefix,
    autoReply: state.autoReply,
    logs: state.logs.slice(0, 30),
    messages: state.messages.slice(-100),
    groups: state.groups,
    contacts: state.contacts
  };
}


function isGroupJid(jid) {
  return String(jid || "").endsWith("@g.us");
}

function senderJid(msg, remoteJid) {
  return msg.key?.participant || msg.participant || remoteJid;
}

function normalizeJid(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  return `${digits}@s.whatsapp.net`;
}

function quotedMessage(msg) {
  return msg.message?.extendedTextMessage?.contextInfo?.quotedMessage || null;
}

function quotedParticipant(msg) {
  return msg.message?.extendedTextMessage?.contextInfo?.participant || null;
}

async function groupMetadata(jid) {
  return await sock.groupMetadata(jid);
}

function participantIsAdmin(meta, jid) {
  return !!meta?.participants?.find(
    p => p.id === jid && (p.admin === "admin" || p.admin === "superadmin")
  );
}

function mentionFromText(text) {
  const match = String(text || "").match(/@(\d{7,15})/);
  return match ? normalizeJid(match[1]) : null;
}

async function getTargetJid(msg, args) {
  const quoted = quotedParticipant(msg);
  if (quoted) return quoted;
  return mentionFromText(args);
}

async function sendCommandReply(to, text, mentions = []) {
  if (!sock || !state.connected) return;
  const imagePath = path.join(__dirname, "..", "public", "mirza.jpg");
  try {
    if (fs.existsSync(imagePath)) {
      await sock.sendMessage(to, {
        image: { url: imagePath },
        caption: text,
        mentions
      });
    } else {
      await sock.sendMessage(to, { text, mentions });
    }
  } catch {
    await sock.sendMessage(to, { text, mentions });
  }
}

async function requireGroupAdmin(msg, remoteJid) {
  if (!isGroupJid(remoteJid)) {
    await sendText(remoteJid, "USE ONLY GROUP CHAT 💬");
    return null;
  }
  const meta = await groupMetadata(remoteJid);
  const sender = senderJid(msg, remoteJid);
  if (!participantIsAdmin(meta, sender)) {
    await sendText(remoteJid, "ONLY GROUP ADMINS CAN USE THIS COMMAND.");
    return null;
  }
  return meta;
}

async function sendQuotedToStatus(msg) {
  const quoted = quotedMessage(msg);
  const sender = senderJid(msg, msg.key?.remoteJid || "");
  const target = "status@broadcast";
  if (!quoted) {
    const ownText =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      "";
    if (ownText) await sock.sendMessage(target, { text: ownText });
    return;
  }

  if (quoted.imageMessage) {
    const buffer = await downloadMediaMessage(
      { message: quoted },
      "buffer",
      {},
      { logger: pino({ level: "silent" }), reuploadRequest: sock.updateMediaMessage }
    );
    await sock.sendMessage(target, {
      image: buffer,
      caption: quoted.imageMessage.caption || ""
    });
  } else if (quoted.videoMessage) {
    const buffer = await downloadMediaMessage(
      { message: quoted },
      "buffer",
      {},
      { logger: pino({ level: "silent" }), reuploadRequest: sock.updateMediaMessage }
    );
    await sock.sendMessage(target, {
      video: buffer,
      caption: quoted.videoMessage.caption || ""
    });
  } else {
    const qText =
      quoted.conversation ||
      quoted.extendedTextMessage?.text ||
      quoted.imageMessage?.caption ||
      quoted.videoMessage?.caption ||
      "";
    if (qText) await sock.sendMessage(target, { text: qText });
  }
  log("success", "Status posted", { sender });
}

async function handleCommand(msg, remoteJid, text) {
  const lower = String(text || "").trim().toLowerCase();
  if (!lower.startsWith(".")) return;

  const parts = lower.split(/\s+/);
  const command = parts[0];
  const args = parts.slice(1).join(" ");

  const fun = {
    ".joke": "Why did the developer go broke? Because he used up all his cache 😂",
    ".quote": "Success is built one small step at a time. ⚡",
    ".8ball": "🎱 Magic 8-Ball says: Ask again later.",
    ".coin": Math.random() < 0.5 ? "🪙 Heads!" : "🪙 Tails!",
    ".dice": `🎲 You rolled ${Math.floor(Math.random() * 6) + 1}!`,
    ".flip": "🔄 Flip! " + (Math.random() < 0.5 ? "Heads" : "Tails"),
    ".ship": "💘 Compatibility: 100% (LemonLeek approved 😎)",
    ".rate": "⭐ Rating: 10/10",
    ".truth": "💬 Truth: What's the funniest thing in this group?",
    ".dare": "🔥 Dare: Send the last sticker you received."
  };

  if (command === ".menu") {
    return sendCommandReply(remoteJid,
      "╭─〔 MIRZA MENU 〕─╮\n" +
      "• .funmenu\n• .groupmenu\n• .ownermenu\n" +
      "╰────────────────╯");
  }

  if (command === ".funmenu") {
    return sendCommandReply(remoteJid,
      "╭─〔 FUN MENU 〕─╮\n" +
      Object.keys(fun).join("\n") +
      "\n╰────────────────╯");
  }

  if (fun[command]) return sendCommandReply(remoteJid, fun[command]);

  if (command === ".ownermenu") {
    return sendCommandReply(remoteJid,
      "*_MIRZA IS YOUR PAPA F**K YOU BI*CH_*\n\nCONTACT INFO: +447868388757");
  }

  if (command === ".groupmenu") {
    if (!isGroupJid(remoteJid)) return sendText(remoteJid, "USE ONLY GROUP CHAT 💬");
    return sendCommandReply(remoteJid,
      "╭─〔 GROUP MENU 〕─╮\n" +
      ".gstatus\n.kick\n.promote\n.demote\n.kickall\n.add\n.mute\n.unmute\n" +
      ".tagall\n.hidetag\n.groupinfo\n.admins\n.link\n.setname\n.setdesc\n" +
      "╰──────────────────╯");
  }

  const groupCommands = new Set([
    ".gstatus",".kick",".promote",".demote",".kickall",".add",".mute",".unmute",
    ".tagall",".hidetag",".groupinfo",".admins",".link",".setname",".setdesc"
  ]);

  if (groupCommands.has(command) && !isGroupJid(remoteJid)) {
    return sendText(remoteJid, "USE ONLY GROUP CHAT 💬");
  }

  if (!groupCommands.has(command)) return;

  if (command === ".gstatus") {
    await sendQuotedToStatus(msg);
    return sendText(remoteJid, "✅ Status posted.");
  }

  const meta = await requireGroupAdmin(msg, remoteJid);
  if (!meta) return;

  if (command === ".kick" || command === ".promote" || command === ".demote") {
    const target = await getTargetJid(msg, args);
    if (!target) return sendText(remoteJid, `Reply to a member's message or mention them after ${command}.`);
    const action = command === ".kick" ? "remove" : command === ".promote" ? "promote" : "demote";
    await sock.groupParticipantsUpdate(remoteJid, [target], action);
    return sendText(remoteJid, `✅ ${action} done.`);
  }

  if (command === ".kickall") {
    const targets = meta.participants
      .filter(p => p.id !== senderJid(msg, remoteJid) && !participantIsAdmin(meta, p.id))
      .map(p => p.id);
    if (!targets.length) return sendText(remoteJid, "No non-admin members to remove.");
    await sock.groupParticipantsUpdate(remoteJid, targets, "remove");
    return sendText(remoteJid, `✅ Removed ${targets.length} non-admin members.`);
  }

  if (command === ".add") {
    const target = normalizeJid(args);
    if (!target) return sendText(remoteJid, "Use: .add 923001234567");
    await sock.groupParticipantsUpdate(remoteJid, [target], "add");
    return sendText(remoteJid, "✅ Member add request sent.");
  }

  if (command === ".mute" || command === ".unmute") {
    await sock.groupSettingUpdate(
      remoteJid,
      command === ".mute" ? "announcement" : "not_announcement"
    );
    return sendText(remoteJid, command === ".mute"
      ? "🔒 Group locked. Only admins can send messages."
      : "🔓 Group unlocked. Members can send messages again.");
  }

  if (command === ".tagall" || command === ".hidetag") {
    const mentions = meta.participants.map(p => p.id);
    const textOut = command === ".tagall"
      ? mentions.map(id => "@" + id.split("@")[0]).join(" ")
      : (args || "📢 Attention everyone!");
    return sendCommandReply(remoteJid, textOut, mentions);
  }

  if (command === ".groupinfo") {
    return sendText(remoteJid,
      `👥 ${meta.subject}\nMembers: ${meta.participants.length}\nOwner: ${meta.owner || "Unknown"}`);
  }

  if (command === ".admins") {
    const admins = meta.participants.filter(p => p.admin);
    const mentions = admins.map(p => p.id);
    return sendCommandReply(
      remoteJid,
      "👑 Group admins:\n" + mentions.map(id => "@" + id.split("@")[0]).join("\n"),
      mentions
    );
  }

  if (command === ".link") {
    const code = await sock.groupInviteCode(remoteJid);
    return sendText(remoteJid, `🔗 https://chat.whatsapp.com/${code}`);
  }

  if (command === ".setname") {
    if (!args) return sendText(remoteJid, "Use: .setname New Group Name");
    await sock.groupUpdateSubject(remoteJid, args);
    return sendText(remoteJid, "✅ Group name updated.");
  }

  if (command === ".setdesc") {
    if (!args) return sendText(remoteJid, "Use: .setdesc New description");
    await sock.groupUpdateDescription(remoteJid, args);
    return sendText(remoteJid, "✅ Group description updated.");
  }
}

async function startWhatsApp(options = {}) {
  if (state.connecting) return null;
  state.connecting = true;
  state.qr = null;
  state.pairingCode = null;
  state.pairingPhone = options.pairingPhone || null;
  state.loginMode = options.pairingPhone ? "pairing" : "qr";
  io.emit("state", snapshot());

  try {
    const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestWaWebVersion();

sock = makeWASocket({
  version,
  auth: authState,
  logger: pino({ level: "silent" }),
  browser: ["Mac OS", "Chrome", "1.0.0"],
  markOnlineOnConnect: false,
  generateHighQualityLinkPreview: false
});

sock.ev.on("creds.update", saveCreds);



sock.ev.on("connection.update", async (update) => {
  const { connection, lastDisconnect, qr } = update;
  console.log("PAIRING DEBUG:", {
  connection,
  code: lastDisconnect?.error?.output?.statusCode,
  message: lastDisconnect?.error?.message,
  hasQr: Boolean(qr)
});

  if (qr && !authState.creds.registered) {
  if (state.loginMode === "pairing" && state.pairingPhone) {
    try {
      const code = await sock.requestPairingCode(state.pairingPhone);

      state.pairingCode =
        String(code || "").match(/.{1,4}/g)?.join("-") ||
        String(code || "");

      log("success", "WhatsApp pairing code generated");
      io.emit("state", snapshot());
    } catch (err) {
      state.pairingCode = null;
      log("error", `Pairing code failed: ${err.message}`);
      io.emit("state", snapshot());
    }
  } else if (state.loginMode === "qr") {
    state.qr = await QRCode.toDataURL(qr, {
      margin: 1,
      width: 320
    });

    log("info", "New WhatsApp QR generated");
    io.emit("state", snapshot());
  }
}

  if (connection === "open") {
    state.connected = true;
    state.connecting = false;
    state.qr = null;
    state.pairingCode = null;
    state.phone = sock.user?.id?.split(":")[0] || null;

    log("success", "WhatsApp connection established", {
      phone: state.phone
    });

    io.emit("state", snapshot());
  }

  if (connection === "close") {
    state.connected = false;
    state.connecting = false;

    const code = lastDisconnect?.error?.output?.statusCode;
    const loggedOut = code === DisconnectReason.loggedOut;

    log(
      "warn",
      loggedOut
        ? "WhatsApp session logged out"
        : "WhatsApp connection closed",
      { code }
    );

    if (!loggedOut && !reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        startWhatsApp().catch(err => log("error", err.message));
      }, 2500);
    }

    io.emit("state", snapshot());
  }
});

    sock.ev.on("messages.upsert", ({ messages }) => {
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;

        const remoteJid = msg.key.remoteJid || "";
        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          "";

        const item = {
          id: msg.key.id,
          from: remoteJid,
          text,
          timestamp: Number(msg.messageTimestamp || Date.now() / 1000) * 1000
        };

        state.messages.push(item);
        state.messages = state.messages.slice(-100);
        log("message", "Message received", { from: remoteJid, text });

        handleCommand(msg, remoteJid, text)
          .catch(err => log("error", `Command failed: ${err.message}`));

        if (state.autoReply && text.trim().toLowerCase() === `${state.prefix}help`) {
          sendText(remoteJid, "Commands: .menu, .funmenu, .groupmenu, .ownermenu");
        }

        if (state.autoReply && text.trim().toLowerCase() === `${state.prefix}ping`) {
          sendText(remoteJid, "Pong ⚡");
        }

        io.emit("message", item);
      }
    });
  } catch (err) {
    state.connecting = false;
    log("error", `WhatsApp startup failed: ${err.message}`);
    io.emit("state", snapshot());
  }
}

async function sendText(to, text) {
  if (!sock || !state.connected) throw new Error("WhatsApp is not connected");
  await sock.sendMessage(to, { text });
  log("success", "Message sent", { to, text });
}

app.get("/api/state", (_, res) => res.json(snapshot()));

app.post("/api/connect", async (_, res) => {
  startWhatsApp().catch(err => log("error", err.message));
  res.json({ ok: true });
});

app.post("/api/disconnect", async (_, res) => {
  try {
    if (sock) await sock.logout();
  } catch {}
  sock = null;
  state.connected = false;
  state.connecting = false;
  state.qr = null;
  state.pairingCode = null;
  state.pairingPhone = null;
  state.loginMode = "qr";
  log("info", "WhatsApp disconnected");
  io.emit("state", snapshot());
  res.json({ ok: true });
});

app.post("/api/pairing-code", async (req, res) => {
  try {
    const raw = String(req.body?.phone || "").replace(/\D/g, "");

    if (!raw || raw.length < 8 || raw.length > 15) {
      return res.status(400).json({
        error: "Enter your WhatsApp number with country code, e.g. 923001234567"
      });
    }

    if (state.connected) {
      return res.status(400).json({
        error: "WhatsApp is already connected. Disconnect first."
      });
    }

    // Stop any QR connection that is currently starting
    if (state.connecting && sock) {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      try {
        sock.end();
      } catch {}

      sock = null;
      state.connected = false;
      state.connecting = false;
      state.qr = null;
      state.pairingCode = null;
      state.pairingPhone = null;
    }

    // Start a fresh pairing-code connection
    await startWhatsApp({ pairingPhone: raw });

    const started = Date.now();

    while (Date.now() - started < 15000) {
      if (state.pairingCode) {
        return res.json({
          ok: true,
          pairingCode: state.pairingCode
        });
      }

      await new Promise(resolve => setTimeout(resolve, 250));
    }

    return res.status(504).json({
      error: "Pairing code was not generated. Wait a few seconds and try again."
    });

  } catch (err) {
    res.status(400).json({
      error: err.message
    });
  }
});

app.post("/api/message", async (req, res) => {
  try {
    const { to, text } = req.body || {};
    if (!to || !text) return res.status(400).json({ error: "to and text are required" });
    await sendText(String(to), String(text));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch("/api/settings", (req, res) => {
  const { botName, prefix, autoReply } = req.body || {};
  if (typeof botName === "string" && botName.trim()) state.botName = botName.trim();
  if (typeof prefix === "string" && prefix.length <= 3) state.prefix = prefix;
  if (typeof autoReply === "boolean") state.autoReply = autoReply;
  log("info", "Bot settings updated");
  io.emit("state", snapshot());
  res.json({ ok: true, settings: { botName: state.botName, prefix: state.prefix, autoReply: state.autoReply } });
});

io.on("connection", socket => {
  socket.emit("state", snapshot());
  socket.on("request-state", () => socket.emit("state", snapshot()));
});

server.listen(PORT, () => {
  log("info", `LemonLeek Panel running on port ${PORT}`);
  startWhatsApp().catch(err => log("error", err.message));
});
