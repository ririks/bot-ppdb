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

// 🚀 Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

let supabase = null;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn("⚠️ SUPABASE_URL atau SUPABASE_SERVICE_KEY belum diisi. Database OFF.");
} else {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}

// =====================================
// 🔎 Utility Functions
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

async function getAllKuota() {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("kuota_ppdb")
    .select("jenjang_kode, jumlah, tahun_ajaran")
    .order("jenjang_kode", { ascending: true });
  if (error || !data || data.length === 0) return null;

  const tahun = data[0].tahun_ajaran;
  const lines = data.map(d => `• ${d.jenjang_kode}: ${d.jumlah}`).join("\n");
  return `📊 Kuota PPDB ${tahun}:\n${lines}\n\nKetik: KUOTA TK/SD/SMP/SMA untuk detail.`;
}

async function getKuotaByJenjang(kode) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("kuota_ppdb")
    .select("jumlah,tahun_ajaran")
    .eq("jenjang_kode", kode)
    .order("id", { ascending: false })
    .limit(1);
  if (error || !data || data.length === 0) return null;
  return `📊 Kuota ${kode} ${data[0].tahun_ajaran}: ${data[0].jumlah} siswa.`;
}

async function getBiayaAll() {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("biaya_ppdb")
    .select("jenjang_kode, tahun_ajaran, formulir, spp, uang_pangkal, seragam, kegiatan")
    .order("jenjang_kode", { ascending: true });
  if (error || !data || data.length === 0) return null;

  const tahun = data[0].tahun_ajaran;
  let lines = data.map(b =>
    `\n📌 ${b.jenjang_kode}:\n` +
    `• Formulir: Rp ${b.formulir.toLocaleString()}\n` +
    `• Uang Pangkal: Rp ${b.uang_pangkal.toLocaleString()}\n` +
    `• SPP: Rp ${b.spp.toLocaleString()}/bulan\n` +
    `• Seragam: Rp ${b.seragam.toLocaleString()}\n` +
    `• Kegiatan: Rp ${b.kegiatan.toLocaleString()}`
  ).join("\n");
  return `💰 Biaya PPDB ${tahun}:${lines}`;
}

async function getBiayaByJenjang(kode) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("biaya_ppdb")
    .select("tahun_ajaran, formulir, spp, uang_pangkal, seragam, kegiatan")
    .eq("jenjang_kode", kode)
    .order("updated_at", { ascending: false })
    .limit(1);
  if (error || !data || data.length === 0) return null;

  const b = data[0];
  return `💰 Biaya ${kode} ${b.tahun_ajaran}:\n` +
         `• Formulir: Rp ${b.formulir.toLocaleString()}\n` +
         `• Uang Pangkal: Rp ${b.uang_pangkal.toLocaleString()}\n` +
         `• SPP: Rp ${b.spp.toLocaleString()}/bulan\n` +
         `• Seragam: Rp ${b.seragam.toLocaleString()}\n` +
         `• Kegiatan: Rp ${b.kegiatan.toLocaleString()}`;
}

async function getFaq(keyword, subkey = null) {
  if (!supabase) return null;
  let query = supabase.from("faq").select("konten").eq("keyword", keyword);
  if (subkey) query = query.eq("subkey", subkey);
  else query = query.is("subkey", null);
  const { data, error } = await query.limit(1);
  if (error || !data || data.length === 0) return null;
  return data[0].konten;
}

// 📌 HELP Text
const HELP_TEXT = `⚡ Hi! Selamat datang di *Chatbot PPDB* 🎉  

📌 *Ketik salah satu kata kunci berikut ini ya:*  

1️⃣ *KUOTA* → Lihat kuota semua jenjang  
2️⃣ *BIAYA* → Info biaya per jenjang  
3️⃣ *SYARAT* → Persyaratan pendaftaran  
4️⃣ *JADWAL* → Jadwal PPDB terbaru  
5️⃣ *PENDAFTARAN* → Cara pendaftaran  
6️⃣ *KONTAK* → Hubungi admin  
7️⃣ *BEASISWA* → Info beasiswa  

💡 Ketik *MENU* kapan saja untuk kembali ke daftar ini.
`;

// =====================================
// 🚀 Start Bot
// =====================================
let latestQrData = null;
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

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", (update) => {
    const { connection, qr, lastDisconnect } = update;
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

  // 📩 Listener pesan
  sock.ev.on("messages.upsert", async (m) => {
    try {
      const msg = m.messages[0];
      if (!msg.message) return;
      if (msg.key.fromMe) return;
      const from = msg.key.remoteJid; // nomor WA
      if (from.endsWith("@g.us")) return; // skip grup

      const nama = msg.pushName || "Tanpa Nama";
      const nomor = from.replace("@s.whatsapp.net", "");

      // ✅ Selalu update nama terbaru ke database
      if (supabase) {
        const { error } = await supabase
          .from("users_wa")
          .upsert(
            { nomor, nama },  // kalau nama berubah, langsung overwrite
            { onConflict: "nomor" }
          );
        if (error) console.error("❌ Gagal simpan/update user:", error.message);
        else console.log(`✅ User tersimpan/diupdate: ${nomor} - ${nama}`);
      }

      const text = (
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        ""
      ).trim();
      if (!text) return;

      console.log("📩 Pesan:", text);
      const lower = text.toLowerCase();

      if (["menu", "help", "start", "mulai"].includes(lower)) {
        return sock.sendMessage(from, { text: HELP_TEXT });
      }

      if (lower.includes("kuota")) {
        const jenjang = parseJenjang(text);
        const resp = jenjang
          ? await getKuotaByJenjang(jenjang)
          : await getAllKuota();
        return sock.sendMessage(from, { text: withFooter(resp || "❌ Data kuota tidak tersedia.") });
      }

      if (lower.includes("biaya")) {
        const jenjang = parseJenjang(text);
        const resp = jenjang
          ? await getBiayaByJenjang(jenjang)
          : await getBiayaAll();
        return sock.sendMessage(from, { text: withFooter(resp || "❌ Data biaya tidak tersedia.") });
      }

      if (lower.includes("syarat")) {
        const jenjang = parseJenjang(text);
        const resp = await getFaq("syarat", jenjang);
        return sock.sendMessage(from, { text: withFooter(resp || "❌ Info syarat belum ada.") });
      }

      if (["jadwal", "pendaftaran", "kontak", "alamat", "beasiswa"].some(k => lower.includes(k))) {
        const key = ["jadwal", "pendaftaran", "kontak", "alamat", "beasiswa"].find(k => lower.includes(k));
        const resp = await getFaq(key);
        return sock.sendMessage(from, { text: withFooter(resp || "❌ Info belum tersedia.") });
      }

      // fallback
      return sock.sendMessage(from, { text: HELP_TEXT });

    } catch (err) {
      console.error("messages.upsert error", err);
    }
  });

  return sock;
}

startBot().catch(err => console.error("startBot error", err));

// =====================================
// 🌍 Web server
// =====================================
const app = express();
const port = process.env.PORT || 3000;

app.get("/", (req, res) =>
  res.send("✅ Bot WhatsApp PPDB aktif di Railway...")
);

app.get("/qr", async (req, res) => {
  if (!latestQrData) return res.send("⚠️ QR belum tersedia / sudah discan.");
  const img = await QRCode.toDataURL(latestQrData);
  res.send(`<h2>Scan QR WhatsApp</h2><img src="${img}" />`);
});

app.listen(port, () =>
  console.log(`🌍 Web server berjalan di port ${port}`)
);
