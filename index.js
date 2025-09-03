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

📌 *Ketik salah satu kata kunci berikut ini:*  

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
            session.data.jenjang_kode = jenjang;
            session.step++;
            return sock.sendMessage(from, { text: "Langkah 4: Masukkan *Nomor KK*:" });

          case 4:
            session.data.nomor_kk = text;
            session.step++;
            return sock.sendMessage(from, { text: "Langkah 5: Kirim *foto KK* (gambar):" });

          case 5:
            if (msg.message.imageMessage) {
              const filePath = await saveImage(msg.message.imageMessage, nomor, "kk");
              session.data.kk_url = filePath;

              if (session.data.jenjang_kode === "SMP" || session.data.jenjang_kode === "SMA") {
                session.step++;
                return sock.sendMessage(from, { text: "Langkah 6: Kirim *foto Rapor* (gambar):" });
              } else {
                session.step = 8; // TK/SD langsung ke foto peserta
                return sock.sendMessage(from, { text: "Langkah 7: Kirim *Foto Peserta* (gambar):" });
              }
            } else {
              return sock.sendMessage(from, { text: "❌ Tolong kirim *gambar KK*." });
            }

          case 6: // Rapor/Ijazah SMP/SMA
            if (msg.message.imageMessage) {
              const filePath = await saveImage(msg.message.imageMessage, nomor, "rapor");
              session.data.rapor_url = filePath;
              session.step++;
              return sock.sendMessage(from, { text: "Langkah 7: Kirim *Foto Ijazah* (gambar):" });
            } else {
              return sock.sendMessage(from, { text: "❌ Tolong kirim *gambar Rapor*." });
            }

          case 7: // Ijazah SMP/SMA
            if (msg.message.imageMessage) {
              const filePath = await saveImage(msg.message.imageMessage, nomor, "ijazah");
              session.data.ijazah_url = filePath;
              session.step++;
              return sock.sendMessage(from, { text: "Langkah 8: Kirim *Foto Peserta* (gambar):" });
            } else {
              return sock.sendMessage(from, { text: "❌ Tolong kirim *gambar Ijazah*." });
            }

          case 8: // Foto Peserta
            if (msg.message.imageMessage) {
              const filePath = await saveImage(msg.message.imageMessage, nomor, "foto");
              session.data.foto_url = filePath;

              // Simpan ke Supabase
              if (supabase) {
                await supabase.from("pendaftaran_ppdb").insert([{
                  nomor,
                  nama: session.data.nama_siswa,
                  jenjang_kode: session.data.jenjang_kode,
                  kk_url: session.data.kk_url,
                  akta_lahir_url: session.data.akta_lahir_url || null,
                  rapor_url: session.data.rapor_url || null,
                  ijazah_url: session.data.ijazah_url || null,
                  foto_url: session.data.foto_url,
                  status: "pending",
                  created_at: new Date().toISOString(),
                }]);
              }

              sessions[nomor] = null;
              return sock.sendMessage(from, { text: "✅ Pendaftaran berhasil! Terima kasih." });
            } else {
              return sock.sendMessage(from, { text: "❌ Tolong kirim *Foto Peserta*." });
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

// Helper untuk save image
async function saveImage(imageMessage, nomor, type) {
  const stream = await downloadContentFromMessage(imageMessage, "buffer");
  const uploadDir = path.join(__dirname, "uploads");
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

  const filePath = path.join(uploadDir, `${nomor}_${type}_${Date.now()}.jpg`);
  const buffers = [];
  for await (const chunk of stream) buffers.push(chunk);
  fs.writeFileSync(filePath, Buffer.concat(buffers));

  return filePath; // bisa diganti dengan URL Supabase Storage jika mau upload ke cloud
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
