// index.js (server bot WA + API)
// ------------------------------------
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
// Utility Functions
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
  if (!n.startsWith("62")) n = "62" + n; // fallback ke Indonesia
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
// Start Bot
// =====================================
let latestQrData = null;
const sessions = {};
let waSock = null; // <-- simpan socket global buat dipakai endpoint API

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

  // =====================================
  // Helper ambil isi pesan WA
  // =====================================
  function extractMessage(msg) {
    if (!msg.message) return null;

    if (msg.message.ephemeralMessage?.message) {
      return extractMessage({ message: msg.message.ephemeralMessage.message });
    }
    if (msg.message.viewOnceMessage?.message) {
      return extractMessage({ message: msg.message.viewOnceMessage.message });
    }

    if (msg.message.imageMessage) return { type: "image", data: msg.message.imageMessage };
    if (msg.message.videoMessage) return { type: "video", data: msg.message.videoMessage };
    if (msg.message.documentMessage) {
      const mime = msg.message.documentMessage.mimetype || "";
      if (mime.startsWith("image/")) return { type: "image", data: msg.message.documentMessage };
      return { type: "document", data: msg.message.documentMessage };
    }

    if (msg.message.conversation) return { type: "text", data: msg.message.conversation };
    if (msg.message.extendedTextMessage) return { type: "text", data: msg.message.extendedTextMessage.text };

    return null;
  }

  // =====================================
  // Listener Pesan
  // =====================================
  sock.ev.on("messages.upsert", async (m) => {
    try {
      const msg = m.messages?.[0];
      if (!msg?.message) return;
      if (msg.key.fromMe) return;

      const from = msg.key.remoteJid;
      if (from.endsWith("@g.us")) return;

      const nama = msg.pushName || "Tanpa Nama";
      const nomor = from.replace("@s.whatsapp.net", "");

      await supabase.from("users_wa").upsert({ nomor, nama }, { onConflict: "nomor" });

      const content = extractMessage(msg);
      if (!content) return;

      const isImage = content.type === "image";
      const text = content.type === "text" ? (content.data || "").trim() : "";
      const lower = text.toLowerCase();

      if (["menu", "help", "start", "mulai"].includes(lower)) {
        sessions[nomor] = null;
        return sock.sendMessage(from, { text: HELP_TEXT });
      }

      if (["syarat", "jadwal", "kontak", "alamat", "beasiswa", "pendaftaran"].some(k => lower.includes(k))) {
        const key = ["syarat", "jadwal", "kontak", "alamat", "beasiswa", "pendaftaran"].find(k => lower.includes(k));
        const resp = await getFaq(key);
        return sock.sendMessage(from, { text: withFooter(resp || "❌ Info belum tersedia.") });
      }

      // === Flow DAFTAR ===
      if (lower.includes("daftar") || sessions[nomor]) {
        if (!sessions[nomor]) {
          sessions[nomor] = { step: 1, data: {} };
          return sock.sendMessage(from, {
            text: withFooter("📝 Pendaftaran PPDB\n\nLangkah 1: Masukkan *Nama Lengkap* siswa:")
          });
        }

        const session = sessions[nomor];

        switch (session.step) {
          case 1:
            session.data.nama_siswa = text;
            session.step++;
            return sock.sendMessage(from, { text: withFooter("Langkah 2: Masukkan *Tanggal Lahir* (YYYY-MM-DD):") });

          case 2:
            session.data.tgl_lahir = text;
            session.step++;
            return sock.sendMessage(from, { text: withFooter("Langkah 3: Masukkan *Jenjang* (TK/SD/SMP/SMA):") });

          case 3:
            const jenjang = parseJenjang(text);
            if (!jenjang)
              return sock.sendMessage(from, { text: withFooter("❌ Jenjang tidak valid, masukkan TK/SD/SMP/SMA:") });
            session.data.jenjang_kode = jenjang;
            session.step++;
            return sock.sendMessage(from, { text: withFooter("Langkah 4: Masukkan *Nomor KK*:") });

          case 4:
            session.data.nomor_kk = text;
            session.step++;
            return sock.sendMessage(from, { text: withFooter("Langkah 5: Kirim *Foto KK* (gambar):") });

          case 5:
            if (isImage) {
              session.data.kk_url = await uploadToSupabaseStorage(content.data, `${nomor}/kk`);
              session.step++;
              return sock.sendMessage(from, { text: withFooter("Langkah 6: Kirim *Foto Akta Lahir* (gambar):") });
            } else {
              return sock.sendMessage(from, { text: withFooter("❌ Tolong kirim *gambar KK*.") });
            }

          case 6:
            if (isImage) {
              session.data.akta_lahir_url = await uploadToSupabaseStorage(content.data, `${nomor}/akta_lahir`);
              session.step = ["SMP", "SMA"].includes(session.data.jenjang_kode) ? 7 : 9;
              return sock.sendMessage(from, {
                text: withFooter(
                  ["SMP", "SMA"].includes(session.data.jenjang_kode)
                    ? "Langkah 7: Kirim *foto Rapor* (gambar):"
                    : "Langkah 9: Kirim *Foto Peserta* (gambar):"
                )
              });
            } else {
              return sock.sendMessage(from, { text: withFooter("❌ Tolong kirim *gambar Akta Lahir*.") });
            }

          case 7:
            if (isImage) {
              session.data.rapor_url = await uploadToSupabaseStorage(content.data, `${nomor}/rapor`);
              session.step++;
              return sock.sendMessage(from, { text: withFooter("Langkah 8: Kirim *Foto Ijazah* (gambar):") });
            } else {
              return sock.sendMessage(from, { text: withFooter("❌ Tolong kirim *gambar Rapor*.") });
            }

          case 8:
            if (isImage) {
              session.data.ijazah_url = await uploadToSupabaseStorage(content.data, `${nomor}/ijazah`);
              session.step++;
              return sock.sendMessage(from, { text: withFooter("Langkah 9: Kirim *Foto Peserta* (gambar):") });
            } else {
              return sock.sendMessage(from, { text: withFooter("❌ Tolong kirim *gambar Ijazah*.") });
            }

          case 9:
            if (isImage) {
              session.data.foto_url = await uploadToSupabaseStorage(content.data, `${nomor}/foto`);

              console.log("DATA AKAN DIINSERT:", session.data);

              await supabase.from("pendaftaran_ppdb").insert([{
                nomor,
                nama: session.data.nama_siswa,
                tgl_lahir: session.data.tgl_lahir,
                jenjang_kode: session.data.jenjang_kode,
                nomor_kk: session.data.nomor_kk,
                kk_url: session.data.kk_url || "BELUM ADA",
                akta_lahir_url: session.data.akta_lahir_url || "BELUM ADA",
                rapor_url: session.data.rapor_url || "BELUM ADA",
                ijazah_url: session.data.ijazah_url || "BELUM ADA",
                foto_url: session.data.foto_url || "BELUM ADA",
                status: "pending",
                created_at: new Date().toISOString(),
              }]);

              sessions[nomor] = null;
              return sock.sendMessage(from, { text: withFooter("✅ Pendaftaran berhasil! Terima kasih.") });
            } else {
              return sock.sendMessage(from, { text: withFooter("❌ Tolong kirim *Foto Peserta*.") });
            }

          default:
            sessions[nomor] = null;
            return sock.sendMessage(from, { text: HELP_TEXT });
        }
      }

      return sock.sendMessage(from, { text: HELP_TEXT });
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

    // nama file unik
    const filePath = `${fileName}_${Date.now()}.${ext}`;

    const { error } = await supabase.storage
      .from("ppdb-files")
      .upload(filePath, buffer, { upsert: true });

    if (error) throw error;

    // selalu ambil publicUrl dari filePath
    const { data: publicData } = supabase
      .storage
      .from("ppdb-files")
      .getPublicUrl(filePath);

    return publicData.publicUrl || "BELUM ADA";
  } catch (err) {
    console.error("uploadToSupabaseStorage error", err);
    return "BELUM ADA";
  }
}

// =====================================
// Start bot & web server + API
// =====================================
startBot().catch(err => console.error("startBot error", err));

const app = express();
app.use(cors()); // opsional: batasi origin kalau perlu
app.use(express.json());

const port = process.env.PORT || 3000;

app.get("/", (req, res) => res.send("✅ Bot WhatsApp PPDB aktif..."));

app.get("/qr", async (req, res) => {
  if (!latestQrData) return res.send("⚠️ QR belum tersedia / sudah discan.");
  const img = await QRCode.toDataURL(latestQrData);
  res.send(`<h2>Scan QR WhatsApp</h2><img src="${img}" />`);
});

// Endpoint simpel untuk pengecekan
app.get("/health", (req, res) => {
  res.json({ ok: true, waConnected: Boolean(waSock) });
});

// ============================
// Endpoint untuk kirim pesan WA
// Dipanggil dari dashboard (daftar.jsx)
// Body: { nomor: "08xxxx / 62xxxx", pesan: "string" }
// ============================
app.post("/send-message", async (req, res) => {
  try {
    if (!waSock) return res.status(503).json({ ok: false, error: "WA belum siap" });

    const { nomor, pesan } = req.body || {};
    if (!nomor || !pesan) {
      return res.status(400).json({ ok: false, error: "nomor & pesan wajib diisi" });
    }

    const jid = toJid(nomor);
    await waSock.sendMessage(jid, { text: pesan });

    res.json({ ok: true });
  } catch (err) {
    console.error("send-message error", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// (Opsional) Endpoint sekali jalan: update status + kirim pesan
// Bisa dipakai kalau ingin backend yang urus dua-duanya
// Body: { id, nomor, pesan, status } -> status default 'approved'
app.post("/approve-and-notify", async (req, res) => {
  try {
    const { id, nomor, pesan, status = "approved" } = req.body || {};
    if (!id || !nomor) {
      return res.status(400).json({ ok: false, error: "id & nomor wajib" });
    }

    // update status di Supabase
    const { error } = await supabase
      .from("pendaftaran_ppdb")
      .update({ status })
      .eq("id", id);

    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }

    // kirim pesan WA
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

app.listen(port, () => console.log(`🌍 Web server berjalan di port ${port}`));
