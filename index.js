require("dotenv").config();
const express = require("express");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const QRCode = require("qrcode");
const P = require("pino");
const path = require("path");
const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");

const log = P({ level: "info" });

// 🚀 Inisialisasi Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Debug env
console.log("DEBUG SUPABASE_URL:", SUPABASE_URL);
console.log(
  "DEBUG SUPABASE_SERVICE_KEY:",
  SUPABASE_SERVICE_KEY ? "✅ Ada" : "❌ Kosong"
);

let supabase = null;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn(
    "⚠️ SUPABASE_URL atau SUPABASE_SERVICE_KEY belum diisi. Layanan database akan dimatikan sementara."
  );
} else {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}

// 🔎 Utility: deteksi jenjang
function parseJenjang(text) {
  const t = (text || "").toUpperCase();
  if (/\bTK\b/.test(t)) return "TK";
  if (/\bSD\b/.test(t)) return "SD";
  if (/\bSMP\b/.test(t)) return "SMP";
  if (/\bSMA\b/.test(t)) return "SMA";
  return null;
}

// 🔎 Query Supabase: Semua kuota
async function getAllKuota() {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("kuota_ppdb")
    .select("jenjang_kode, jumlah, tahun_ajaran")
    .order("jenjang_kode", { ascending: true });
  if (error) {
    console.error("Supabase getAllKuota error", error);
    return null;
  }
  if (!data || data.length === 0) return null;
  const tahun = data[0].tahun_ajaran || "";
  const lines = data.map((d) => `• ${d.jenjang_kode}: ${d.jumlah}`).join("\n");
  return `Kuota PPDB ${tahun}:\n${lines}\n\nKetik: KUOTA TK/SD/SMP/SMA untuk detail per jenjang.`;
}

async function getKuotaByJenjang(kode) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("kuota_ppdb")
    .select("jumlah,tahun_ajaran")
    .eq("jenjang_kode", kode)
    .order("id", { ascending: false })
    .limit(1);

  if (error) {
    console.error("Supabase getKuotaByJenjang error", error);
    return null;
  }
  if (!data || data.length === 0) return null;
  const { jumlah, tahun_ajaran } = data[0];
  return `Kuota ${kode} tahun ajaran ${tahun_ajaran}: ${jumlah} siswa.`;
}

// 🔎 Query Supabase: Biaya
async function getBiaya() {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("biaya_ppdb")
    .select("deskripsi, nominal")
    .order("id", { ascending: true });

  if (error) {
    console.error("Supabase getBiaya error", error);
    return null;
  }
  if (!data || data.length === 0) return null;

  const lines = data
    .map((d) => `• ${d.deskripsi}: Rp${d.nominal.toLocaleString("id-ID")}`)
    .join("\n");
  return `Biaya PPDB:\n${lines}`;
}

// 🔎 Query Supabase: FAQ
async function getFaq(keyword, subkey = null) {
  if (!supabase) return null;
  let query = supabase.from("faq").select("konten").eq("keyword", keyword);
  if (subkey) query = query.eq("subkey", subkey);
  else query = query.is("subkey", null);
  const { data, error } = await query.limit(1);
  if (error) {
    console.error("Supabase getFaq error", error);
    return null;
  }
  if (!data || data.length === 0) return null;
  return data[0].konten;
}

// 📌 Pesan bantuan
const HELP_TEXT = `Halo! Selamat datang di Chatbot PPDB.\n\nKetik salah satu kata kunci:\n• KUOTA — lihat kuota TK–SMA\n• KUOTA TK/SD/SMP/SMA — detail per jenjang\n• SYARAT — persyaratan\n• BIAYA — info biaya\n• MENU — tampilkan menu ini.`;

// =====================================
// 🚀 Start Bot
// =====================================
let latestQrData = null; // simpan QR terbaru
async function startBot() {
  const authDir = path.join(__dirname, "auth_info");
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir);
  }

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const { version, isLatest } = await fetchLatestBaileysVersion().catch(() => ({
    version: [4, 0, 0],
    isLatest: false,
  }));
  log.info(`Using WA Baileys version: ${version}, isLatest: ${isLatest}`);

  const sock = makeWASocket({
    logger: log,
    printQRInTerminal: false, // kita pakai qrcode-terminal manual
    auth: state,
    version,
  });

  sock.ev.on("creds.update", saveCreds);

  // 🔑 Listener koneksi
  sock.ev.on("connection.update", (update) => {
    const { connection, qr, lastDisconnect } = update;
    if (qr) {
      latestQrData = qr; // simpan untuk /qr
      console.log("📌 Scan QR ini pakai WhatsApp HP kamu:");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      console.log("✅ Bot sudah terhubung ke WhatsApp!");
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log("❌ Koneksi terputus, mencoba ulang...");
      if (code !== DisconnectReason.loggedOut) {
        startBot();
      } else {
        console.log("🔒 Logged out. Hapus folder auth_info dan scan ulang QR.");
      }
    }
  });

  // 📩 Listener pesan
  sock.ev.on("messages.upsert", async (m) => {
    try {
      const msg = m.messages[0];
      if (!msg.message) return;
      if (msg.key.fromMe) return;

      const from = msg.key.remoteJid;
      const isGroup = from.endsWith("@g.us");
      if (isGroup) return;

      const text = (
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        ""
      ).trim();

      console.log("📩 Pesan masuk:", text);
      if (!text) return;

      const lower = text.toLowerCase();

      if (["menu", "help", "mulai", "start"].includes(lower)) {
        await sock.sendMessage(from, { text: HELP_TEXT });
        return;
      }

      if (lower.includes("kuota")) {
        const jenjang = parseJenjang(text);
        if (jenjang) {
          const resp = await getKuotaByJenjang(jenjang);
          await sock.sendMessage(from, {
            text: resp || "Data kuota tidak ditemukan.",
          });
        } else {
          const resp = await getAllKuota();
          await sock.sendMessage(from, {
            text: resp || "Data kuota tidak tersedia.",
          });
        }
        return;
      }

      if (lower.includes("syarat")) {
        const jenjang = parseJenjang(text);
        const f = await getFaq("syarat", jenjang);
        await sock.sendMessage(from, {
          text: f || "Informasi syarat belum tersedia.",
        });
        return;
      }

      if (lower.includes("biaya")) {
        const resp = await getBiaya();
        await sock.sendMessage(from, {
          text: resp || "Informasi biaya belum tersedia.",
        });
        return;
      }

      // fallback
      await sock.sendMessage(from, { text: HELP_TEXT });
    } catch (err) {
      console.error("messages.upsert error", err);
    }
  });

  return sock;
}

// Jalankan bot
startBot().catch((err) => {
  console.error("startBot error", err);
});

// =====================================
// 🌍 Web server kecil untuk UptimeRobot
// =====================================
const app = express();
const port = process.env.PORT || 3000;

app.get("/", (req, res) => res.send("✅ Bot WhatsApp PPDB sedang berjalan 24 jam..."));

// Tambahan: route QR agar bisa di-scan via browser
app.get("/qr", async (req, res) => {
  if (!latestQrData) return res.send("⚠️ QR belum tersedia / sudah discan.");
  const img = await QRCode.toDataURL(latestQrData);
  res.send(`<h2>Silakan scan QR WhatsApp</h2><img src="${img}" />`);
});

app.listen(port, () => console.log(`🌍 Web server berjalan di port ${port}`));
