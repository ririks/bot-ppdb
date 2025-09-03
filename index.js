require("dotenv").config();
const express = require("express");
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

// Mengambil FAQ
async function getFaq(keyword, subkey = null) {
  if (!supabase) return null;
  let query = supabase.from("faq").select("konten").eq("keyword", keyword);
  if (subkey) query = query.eq("subkey", subkey);
  else query = query.is("subkey", null);
  const { data, error } = await query.limit(1);
  if (error || !data || data.length === 0) return null;
  return data[0].konten;
}

// =====================================
// 📌 HELP Text
// =====================================
const HELP_TEXT = `⚡ Hi! Selamat datang di *Chatbot PPDB* 🎉  

📌 *Ketik salah satu kata kunci berikut ini ya:*  

1️⃣ *KUOTA* → Lihat kuota semua jenjang  
2️⃣ *BIAYA* → Info biaya per jenjang  
3️⃣ *SYARAT* → Persyaratan pendaftaran  
4️⃣ *JADWAL* → Jadwal PPDB terbaru  
5️⃣ *DAFTAR* → Daftar sekarang  
6️⃣ *KONTAK* → Hubungi admin  
7️⃣ *BEASISWA* → Info beasiswa  

💡 Ketik *MENU* kapan saja untuk kembali ke daftar ini.
`;

// =====================================
// 🚀 Start Bot
// =====================================
let latestQrData = null;
const sessions = {}; // Menyimpan state pendaftaran sementara per nomor

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
      const from = msg.key.remoteJid;
      if (from.endsWith("@g.us")) return; // skip grup

      const nama = msg.pushName || "Tanpa Nama";
      const nomor = from.replace("@s.whatsapp.net", "");

      // ✅ Simpan/update user WA
      if (supabase) {
        await supabase.from("users_wa").upsert({ nomor, nama }, { onConflict: "nomor" });
      }

      const text = (
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        ""
      ).trim();

      // Handle menu/help
      const lower = (text || "").toLowerCase();
      if (["menu", "help", "start", "mulai"].includes(lower)) {
        sessions[nomor] = null; // reset session
        return sock.sendMessage(from, { text: HELP_TEXT });
      }

      // Handle FAQ
      if (["syarat", "jadwal", "kontak", "alamat", "beasiswa"].some(k => lower.includes(k))) {
        const key = ["syarat", "jadwal", "kontak", "alamat", "beasiswa"].find(k => lower.includes(k));
        const resp = await getFaq(key);
        return sock.sendMessage(from, { text: withFooter(resp || "❌ Info belum tersedia.") });
      }

      // Handle DAFTAR (pendaftaran step-by-step)
      if (lower.includes("daftar") || sessions[nomor]) {
        if (!sessions[nomor]) {
          sessions[nomor] = { step: 1, data: {} };
          return sock.sendMessage(from, { text: "📝 Pendaftaran PPDB\n\nLangkah 1: Masukkan *Nama Lengkap* siswa:" });
        }

        const session = sessions[nomor];

        switch (session.step) {
          case 1:
            session.data.nama_siswa = text;
            session.step++;
            return sock.sendMessage(from, { text: "Langkah 2: Masukkan *Tanggal Lahir* (YYYY-MM-DD):" });

          case 2:
            session.data.tgl_lahir = text;
            session.step++;
            return sock.sendMessage(from, { text: "Langkah 3: Masukkan *Jenjang* (TK/SD/SMP/SMA):" });

          case 3:
            const jenjang = parseJenjang(text);
            if (!jenjang) return sock.sendMessage(from, { text: "❌ Jenjang tidak valid, masukkan TK/SD/SMP/SMA:" });
            session.data.jenjang = jenjang;
            session.step++;
            return sock.sendMessage(from, { text: "Langkah 4: Masukkan *Nomor KK*:" });

          case 4:
            session.data.nomor_kk = text;
            session.step++;
            return sock.sendMessage(from, { text: "Langkah 5: Silahkan kirim *foto KK* (gambar):" });

          case 5:
            if (msg.message.imageMessage) {
              // Download image
              const stream = await downloadContentFromMessage(msg.message.imageMessage, "buffer");
              const filePath = path.join(__dirname, "uploads", `${nomor}_kk.jpg`);
              if (!fs.existsSync(path.join(__dirname, "uploads"))) fs.mkdirSync(path.join(__dirname, "uploads"));
              const buffers = [];
              for await (const chunk of stream) buffers.push(chunk);
              fs.writeFileSync(filePath, Buffer.concat(buffers));
              session.data.foto_kk = filePath;

              // Simpan ke Supabase
              if (supabase) {
                await supabase.from("pendaftaran_ppdb").insert([{
                  nomor,
                  nama_siswa: session.data.nama_siswa,
                  tgl_lahir: session.data.tgl_lahir,
                  jenjang: session.data.jenjang,
                  nomor_kk: session.data.nomor_kk,
                  foto_kk: session.data.foto_kk,
                  created_at: new Date().toISOString(),
                }]);
              }

              sessions[nomor] = null;
              return sock.sendMessage(from, { text: "✅ Pendaftaran berhasil! Terima kasih." });
            } else {
              return sock.sendMessage(from, { text: "❌ Tolong kirim *gambar KK*." });
            }

          default:
            sessions[nomor] = null;
            return sock.sendMessage(from, { text: HELP_TEXT });
        }
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

app.get("/", (req, res) => res.send("✅ Bot WhatsApp PPDB aktif..."));

app.get("/qr", async (req, res) => {
  if (!latestQrData) return res.send("⚠️ QR belum tersedia / sudah discan.");
  const img = await QRCode.toDataURL(latestQrData);
  res.send(`<h2>Scan QR WhatsApp</h2><img src="${img}" />`);
});

app.listen(port, () => console.log(`🌍 Web server berjalan di port ${port}`));
