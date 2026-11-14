import express from "express";
import cors from "cors";
import pino from "pino";
import QRCode from "qrcode";
import admin from "firebase-admin";
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } from "@whiskeysockets/baileys";

const PORT = Number(process.env.PORT || 8080);
const AUTH_DIR = process.env.AUTH_DIR || "./auth";
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 200);
const MIN_DELAY = Number(process.env.MIN_DELAY_MS || 4000);
const MAX_DELAY = Number(process.env.MAX_DELAY_MS || 9000);
const COUNTRY = process.env.DEFAULT_COUNTRY_CODE || "94";
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map((o) => o.trim()).filter(Boolean);

if (!process.env.FIREBASE_PROJECT_ID) throw new Error("Set FIREBASE_PROJECT_ID");
if (!ALLOWED_EMAILS.length) throw new Error("Set ALLOWED_EMAILS");

admin.initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID });

const logger = pino({ level: "warn" });
const state = { status: "starting", qr: null, phone: "", sentToday: 0, day: new Date().toDateString() };
let socket = null;
let starting = false;
const queue = [];
let draining = false;

const rollDay = () => {
  const today = new Date().toDateString();
  if (state.day !== today) {
    state.day = today;
    state.sentToday = 0;
  }
};

const toJid = (value) => {
  let digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("0")) digits = COUNTRY + digits.slice(1);
  else if (digits.length === 9) digits = COUNTRY + digits;
  return `${digits}@s.whatsapp.net`;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect() {
  if (starting) return;
  starting = true;
  try {
    const { state: auth, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    socket = makeWASocket({ version, auth, logger, printQRInTerminal: false, browser: ["CampusFlow", "Chrome", "1.0"], syncFullHistory: false, markOnlineOnConnect: false });
    socket.ev.on("creds.update", saveCreds);
    socket.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        state.status = "qr";
        state.qr = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
      }
      if (connection === "connecting" && state.status !== "qr") state.status = "connecting";
      if (connection === "open") {
        state.status = "open";
        state.qr = null;
        state.phone = (socket.user?.id || "").split(":")[0].split("@")[0];
      }
      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        state.qr = null;
        state.phone = "";
        starting = false;
        if (code === DisconnectReason.loggedOut) {
          state.status = "loggedOut";
          await import("node:fs/promises").then((fs) => fs.rm(AUTH_DIR, { recursive: true, force: true }));
          setTimeout(connect, 1500);
        } else {
          state.status = "connecting";
          setTimeout(connect, 2500);
        }
      }
    });
  } catch (error) {
    console.error("connect failed", error);
    starting = false;
    setTimeout(connect, 5000);
  } finally {
    if (state.status !== "starting") starting = false;
  }
}

async function drain() {
  if (draining) return;
  draining = true;
  while (queue.length) {
    const job = queue.shift();
    rollDay();
    try {
      if (state.status !== "open" || !socket) throw new Error("WhatsApp is not linked");
      if (state.sentToday >= DAILY_LIMIT) throw new Error("Daily limit reached");
      const exists = await socket.onWhatsApp(job.jid);
      if (!exists?.[0]?.exists) throw new Error("Number is not on WhatsApp");
      await socket.sendMessage(job.jid, { text: job.text });
      state.sentToday += 1;
      job.resolve({ ok: true });
    } catch (error) {
      job.resolve({ ok: false, error: error.message });
    }
    if (queue.length) await sleep(MIN_DELAY + Math.random() * (MAX_DELAY - MIN_DELAY));
  }
  draining = false;
}

const enqueue = (jid, text) =>
  new Promise((resolve) => {
    queue.push({ jid, text, resolve });
    void drain();
  });

const app = express();
app.use(express.json({ limit: "200kb" }));
app.use(cors({ origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : false, allowedHeaders: ["Authorization", "Content-Type"] }));

app.use(async (req, res, next) => {
  if (req.method === "OPTIONS") return next();
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Sign in required" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    const email = (decoded.email || "").toLowerCase();
    if (!decoded.email_verified || !ALLOWED_EMAILS.includes(email)) return res.status(403).json({ error: "This account may not use WhatsApp sending" });
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: "Invalid session" });
  }
});

app.get("/status", (req, res) => {
  rollDay();
  res.json({ status: state.status, qr: state.qr, phone: state.phone, sentToday: state.sentToday, dailyLimit: DAILY_LIMIT, queued: queue.length });
});

app.post("/send", async (req, res) => {
  const jid = toJid(req.body?.to);
  const text = String(req.body?.text || "").trim();
  if (!jid || !text) return res.status(400).json({ error: "to and text are required" });
  if (state.status !== "open") return res.status(409).json({ error: "WhatsApp is not linked" });
  const result = await enqueue(jid, text);
  res.status(result.ok ? 200 : 502).json(result);
});

app.post("/send-bulk", (req, res) => {
  const items = Array.isArray(req.body?.messages) ? req.body.messages.slice(0, 300) : [];
  if (state.status !== "open") return res.status(409).json({ error: "WhatsApp is not linked" });
  const valid = items.map((m) => ({ jid: toJid(m?.to), text: String(m?.text || "").trim() })).filter((m) => m.jid && m.text);
  rollDay();
  if (state.sentToday + queue.length + valid.length > DAILY_LIMIT) return res.status(429).json({ error: `Daily limit of ${DAILY_LIMIT} messages would be exceeded` });
  valid.forEach((m) => void enqueue(m.jid, m.text));
  res.json({ ok: true, queued: valid.length, skipped: items.length - valid.length });
});

app.post("/logout", async (req, res) => {
  try {
    await socket?.logout();
  } catch {
    state.status = "connecting";
  }
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`CampusFlow WhatsApp server on :${PORT}`));
void connect();
