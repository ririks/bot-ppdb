// index.js (server bot WA + API)
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadContentFromMessage,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const QRCode = require("qrcode");
const P = require("pino");
const path = require("path");
const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");

const log = P({ level: "info" });

// =====================================
// Supabase
// =====================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("❌ SUPABASE_URL / SUPABASE_SERVICE_KEY belum di-set di .env");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// =====================================
// Helper Functions
// =====================================
function parseJenjang(text) {
  const t = (text || "").toUpperCase();
  if (/\bTK\b/.test(t)) return "TK";
  if (/\bSD\b/.test(t)) return "SD";
  if (/\bSMP\b/.test(t)) return "SMP";
  if (/\bSMA\b/.test(t)) return "SMA";
  return null;
}

function withFooter(text) {
  return `${text}\n\n👉 Ketik *MENU* untuk kembali ke menu utama.`;
}

async function getFaq(keyword, subkey = null) {
  let query = supabase.from("faq").select("konten").eq("keyword", keyword);
  if (subkey) query = query.eq("subkey", subkey);
  else query = query.is("subkey", null);

  const { data, error } = await query.limit(1);
  if (error || !data || data.length === 0) return null;
  return data[0].konten;
}

// Nomor WA -> JID
function toJid(nomor) {
  if (!nomor) return null;
  let n = String(nomor).replace(/[^\d]/g, "");
  if (n.startsWith("0")) n = "62" + n.slice(1);
  if (!n.startsWith("62")) n = "62" + n;
  return `${n}@s.whatsapp.net`;
}

// =====================================
// Help Text
// =====================================
const HELP_TEXT = withFooter(`⚡ Hi! Selamat datang di *Chatbot PPDB* 🎉  

📌 *Ketik salah satu kata kunci berikut ini:*  

1️⃣ *KUOTA* → Lihat kuota semua jenjang  
2️⃣ *BIAYA* → Info biaya per jenjang  
3️⃣ *SYARAT* → Persyaratan pendaftaran  
4️⃣ *JADWAL* → Jadwal PPDB terbaru  
5️⃣ *PENDAFTARAN* → daftar PPDB  
6️⃣ *KONTAK* → Hubungi admin  
7️⃣ *BEASISWA* → Info beasiswa  
`);

// =====================================
// Bot WA
// =====================================
let latestQrData = null;
let waSock = null;
const sessions = {};

async function startBot() {
  const authDir = path.join(__dirname, "auth_info");
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir);

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({
    version: [4, 0, 0],
  }));

  const sock = makeWASocket({
    logger: log,
    printQRInTerminal: false,
    auth: state,
    version,
  });

  waSock = sock;

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", (update) => {
    const { connection, qr, lastDisconnect } = update || {};
    if (qr) {
      latestQrData = qr;
      console.log("📌 Scan QR ini:");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") console.log("✅ Bot sudah online!");
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log("❌ Koneksi terputus, reconnect...");
      if (code !== DisconnectReason.loggedOut) startBot();
      else console.log("🔒 Logged out. Hapus auth_info & scan ulang QR.");
    }
  });

  // Listener pesan masuk
  sock.ev.on("messages.upsert", async (m) => {
    try {
      const msg = m.messages?.[0];
      if (!msg?.message || msg.key.fromMe) return;
      const from = msg.key.remoteJid;
      if (from.endsWith("@g.us")) return; // skip group

      const nama = msg.pushName || "Tanpa Nama";
      const nomor = from.replace("@s.whatsapp.net", "");
      await supabase.from("users_wa").upsert({ nomor, nama }, { onConflict: "nomor" });

      // pesan teks / image / dokumen
      let text = "";
      let isImage = false;
      if (msg.message.conversation) text = msg.message.conversation;
      if (msg.message.extendedTextMessage) text = msg.message.extendedTextMessage.text;
      if (msg.message.imageMessage || msg.message.documentMessage) isImage = true;
      text = (text || "").trim().toLowerCase();

      // Command sederhana
      if (["menu", "help", "start", "mulai"].includes(text)) {
        sessions[nomor] = null;
        return sock.sendMessage(from, { text: HELP_TEXT });
      }

      // Bisa tambahkan flow DAFTAR atau FAQ di sini sesuai kebutuhan

    } catch (err) {
      console.error("messages.upsert error", err);
    }
  });

  return sock;
}

// =====================================
// Upload ke Supabase Storage
// =====================================
async function uploadToSupabaseStorage(messageContent, fileName) {
  try {
    let contentType = "image";
    if (messageContent.mimetype?.startsWith("video/")) contentType = "video";
    if (messageContent.mimetype?.includes("pdf")) contentType = "document";

    const stream = await downloadContentFromMessage(messageContent, contentType);
    const buffers = [];
    for await (const chunk of stream) buffers.push(chunk);
    const buffer = Buffer.concat(buffers);

    let ext = "jpg";
    if (contentType === "video") ext = "mp4";
    if (contentType === "document") {
      const mt = messageContent.mimetype || "";
      ext = mt.split("/")[1] || "bin";
    }

    const filePath = `${fileName}_${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from("ppdb-files").upload(filePath, buffer, { upsert: true });
    if (error) throw error;

    const { data: publicData } = supabase.storage.from("ppdb-files").getPublicUrl(filePath);
    return publicData.publicUrl || "BELUM ADA";
  } catch (err) {
    console.error("uploadToSupabaseStorage error", err);
    return "BELUM ADA";
  }
}

// =====================================
// Web server + API
// =====================================
const app = express();
app.use(cors({ origin: "*" })); // izinkan semua origin
app.use(express.json());

const port = process.env.PORT || 3000;

app.get("/", (req, res) => res.send("✅ Bot WhatsApp PPDB aktif..."));

app.get("/qr", async (req, res) => {
  if (!latestQrData) return res.send("⚠️ QR belum tersedia / sudah discan.");
  const img = await QRCode.toDataURL(latestQrData);
  res.send(`<h2>Scan QR WhatsApp</h2><img src="${img}" />`);
});

app.get("/health", (req, res) => res.json({ ok: true, waConnected: Boolean(waSock) }));

// Endpoint kirim pesan WA
app.post("/send-message", async (req, res) => {
  try {
    if (!waSock) return res.status(503).json({ ok: false, error: "WA belum siap" });

    const { nomor, pesan } = req.body || {};
    if (!nomor || !pesan) return res.status(400).json({ ok: false, error: "nomor & pesan wajib diisi" });

    const jid = toJid(nomor);
    await waSock.sendMessage(jid, { text: pesan });
    res.json({ ok: true });
  } catch (err) {
    console.error("send-message error", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Endpoint approve + notify
app.post("/approve-and-notify", async (req, res) => {
  try {
    const { id, nomor, pesan, status = "approved" } = req.body || {};
    if (!id || !nomor) return res.status(400).json({ ok: false, error: "id & nomor wajib" });

    const { error } = await supabase.from("pendaftaran_ppdb").update({ status }).eq("id", id);
    if (error) return res.status(500).json({ ok: false, error: error.message });

    if (waSock && pesan) {
      const jid = toJid(nomor);
      await waSock.sendMessage(jid, { text: pesan });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("approve-and-notify error", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// =====================================
// Start bot & server
// =====================================
startBot().catch(err => console.error("startBot error", err));

app.listen(port, () => console.log(`🌍 Web server berjalan di port ${port}`));
