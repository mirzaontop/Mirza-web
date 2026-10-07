import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import QRCode from "qrcode";
import { Server } from "socket.io";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT || 3000);
const AUTH_DIR = path.join(__dirname, "..", "auth_info");

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

const state = {
  connected: false,
  connecting: false,
  phone: null,
  qr: null,
  botName: "LemonLeek Bot",
  prefix: "/",
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
    botName: state.botName,
    prefix: state.prefix,
    autoReply: state.autoReply,
    logs: state.logs.slice(0, 30),
    messages: state.messages.slice(-100),
    groups: state.groups,
    contacts: state.contacts
  };
}

async function startWhatsApp() {
  if (state.connecting) return;
  state.connecting = true;
  state.qr = null;
  io.emit("state", snapshot());

  try {
    const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: authState,
      logger: pino({ level: "silent" }),
      browser: ["LemonLeek Panel", "Chrome", "1.0.0"],
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        state.qr = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
        log("info", "New WhatsApp QR generated");
        io.emit("state", snapshot());
      }

      if (connection === "open") {
        state.connected = true;
        state.connecting = false;
        state.qr = null;
        state.phone = sock.user?.id?.split(":")[0] || null;
        log("success", "WhatsApp connection established", { phone: state.phone });
        io.emit("state", snapshot());
      }

      if (connection === "close") {
        state.connected = false;
        state.connecting = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;

        log("warn", loggedOut ? "WhatsApp session logged out" : "WhatsApp connection closed", { code });

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

        if (state.autoReply && text.trim().toLowerCase() === `${state.prefix}help`) {
          sendText(remoteJid, "Commands: /menu, /help, /ping, /status");
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
  log("info", "WhatsApp disconnected");
  io.emit("state", snapshot());
  res.json({ ok: true });
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
