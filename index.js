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
// Helpers DB: ambil instruksi step
// =====================================
async function getStepInstruction(step, jenjang = null) {
  let query = supabase.from("form_steps").select("*").eq("step", step);

  if (jenjang) query = query.eq("jenjang_kode", jenjang);
  else query = query.is("jenjang_kode", null);

  const { data, error } = await query.limit(1);
  if (error) {
    console.error("getStepInstruction error", error);
    return null;
  }
  if (!data || data.length === 0) return null;
  return data[0];
}

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
// Start Bot
// =====================================
let latestQrData = null;
const sessions = {};
let waSock = null;

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
      const lower = (text || "").toLowerCase();

      if (["menu", "help", "start", "mulai"].includes(lower)) {
        sessions[nomor] = null;
        return sock.sendMessage(from, { text: HELP_TEXT });
      }

      const keywords = ["syarat", "jadwal", "kontak", "biaya", "alamat", "beasiswa", "pendaftaran"];
      const key = keywords.find(k => lower.includes(k));
      if (key) {
        let resp = null;
        if (key === "biaya" || key === "syarat") {
          const jenjang = parseJenjang(text);
          if (jenjang) resp = await getFaq(key, jenjang);
          else resp = await getFaq(key);
        } else {
          resp = await getFaq(key);
        }
        return sock.sendMessage(from, { text: withFooter(resp || "❌ Info belum tersedia.") });
      }

      // === Flow PENDAFTARAN ===
      if (lower.includes("daftar") || sessions[nomor]) {
        if (!sessions[nomor]) {
          sessions[nomor] = { step: 1, data: {} };
          const instruksi = await getStepInstruction(1);
          return sock.sendMessage(from, { text: withFooter(instruksi?.instruksi || "⚠️ Langkah 1 belum tersedia.") });
        }

        const session = sessions[nomor];
        if (!session) return sock.sendMessage(from, { text: HELP_TEXT });

        const instruksiNow = await getStepInstruction(session.step, session.data.jenjang_kode);
        if (!instruksiNow) {
          console.error(`Instruksi tidak ditemukan untuk step=${session.step} jenjang=${session.data.jenjang_kode}`);
          sessions[nomor] = null;
          return sock.sendMessage(from, { text: withFooter("⚠️ Instruksi step tidak ditemukan. Hubungi admin.") });
        }

        // === handle text ===
        if (instruksiNow.tipe === "text") {
          if (instruksiNow.kode === "data_diri") {
            const parts = text.split("#").map(p => p.trim()).filter(Boolean);
            if (parts.length < 4) {
              return sock.sendMessage(from, { text: withFooter("❌ Format salah. Gunakan: #Nama #YYYY-MM-DD #Jenjang #NomorKK") });
            }
            const namaSiswa = parts[0];
            const tgl = parts[1];
            const jen = parseJenjang(parts[2]);
            const nomorKK = parts[3].replace(/\s+/g, "");

            if (!/^\d{4}-\d{2}-\d{2}$/.test(tgl)) {
              return sock.sendMessage(from, { text: withFooter("❌ Format tanggal salah (YYYY-MM-DD).") });
            }
            if (!jen) {
              return sock.sendMessage(from, { text: withFooter("❌ Jenjang tidak valid. Pilih TK/SD/SMP/SMA.") });
            }
            if (!/^\d{16}$/.test(nomorKK)) {
              return sock.sendMessage(from, { text: withFooter("❌ Nomor KK harus 16 digit.") });
            }

            session.data.nama = namaSiswa;
            session.data.tgl_lahir = tgl;
            session.data.jenjang_kode = jen;
            session.data.nomor_kk = nomorKK;
          } else {
            session.data[instruksiNow.kode] = text;
          }
        }

        // === handle image ===
        else if (instruksiNow.tipe === "image") {
          if (!isImage) {
            return sock.sendMessage(from, { text: withFooter(`❌ Tolong kirim *gambar* untuk ${instruksiNow.instruksi}`) });
          }
          try {
            const uploadedUrl = await uploadToSupabaseStorage(content.data, `${nomor}/${instruksiNow.kode}`);
            session.data[`${instruksiNow.kode}_url`] = uploadedUrl;
          } catch (err) {
            console.error("upload error", err);
            return sock.sendMessage(from, { text: withFooter("❌ Gagal upload gambar. Coba lagi.") });
          }
        }

        // === cek step berikutnya ===
        const nextStep = session.step + 1;
        const instruksiNext = await getStepInstruction(nextStep, session.data.jenjang_kode);

        if (instruksiNext) {
          session.step = nextStep;
          return sock.sendMessage(from, { text: withFooter(instruksiNext.instruksi) });
        } else {
          // hanya insert kalau step terakhir (foto)
          if (instruksiNow.kode === "foto") {
            try {
              await supabase.from("pendaftaran_ppdb").insert([{
                nomor,
                nama: session.data.nama || null,
                tgl_lahir: session.data.tgl_lahir || null,
                jenjang_kode: session.data.jenjang_kode || null,
                nomor_kk: session.data.nomor_kk || null,
                kk_url: session.data.kk_url || null,
                akta_url: session.data.akta_url || null,
                rapor_url: session.data.rapor_url || null,
                ijazah_url: session.data.ijazah_url || null,
                foto_url: session.data.foto_url || null,
                status: "pending",
                created_at: new Date().toISOString(),
              }]);

              await kurangiKuota(session.data.jenjang_kode);
              sessions[nomor] = null;

              console.log(`✅ Pendaftaran baru: ${session.data.nama} (${session.data.jenjang_kode})`);
              return sock.sendMessage(from, { text: withFooter("✅ Pendaftaran berhasil! Terima kasih.") });
            } catch (insertErr) {
              console.error("insert error", insertErr);
              sessions[nomor] = null;
              return sock.sendMessage(from, { text: withFooter("❌ Gagal simpan pendaftaran. Hubungi admin.") });
            }
          } else {
            console.error(`❌ Instruksi hilang sebelum selesai. step=${session.step}, kode=${instruksiNow.kode}`);
            sessions[nomor] = null;
            return sock.sendMessage(from, { text: withFooter("⚠️ Instruksi berikutnya tidak ditemukan. Hubungi admin.") });
          }
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
// Kurangi Kuota
// =====================================
async function kurangiKuota(jenjang) {
  try {
    if (!jenjang) return;
    const { data, error } = await supabase
      .from("kuota_ppdb")
      .select("jumlah")
      .eq("jenjang_kode", jenjang)
      .single();

    if (error || !data) {
      console.error("❌ Gagal ambil kuota:", error?.message);
      return;
    }

    if (data.jumlah > 0) {
      const { error: updateError } = await supabase
        .from("kuota_ppdb")
        .update({ jumlah: data.jumlah - 1 })
        .eq("jenjang_kode", jenjang);

      if (updateError) console.error("❌ Gagal update kuota:", updateError.message);
      else console.log(`✅ Kuota ${jenjang} berkurang → ${data.jumlah - 1}`);
    } else {
      console.log(`⚠️ Kuota ${jenjang} sudah habis`);
    }
  } catch (err) {
    console.error("kurangiKuota error", err);
  }
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
    throw err;
  }
}

// =====================================
// Start bot & web server
// =====================================
startBot().catch(err => console.error("startBot error", err));

const app = express();
app.use(cors({ origin: "https://dashboard-ppdb-production.up.railway.app" }));
app.use(express.json());

const port = process.env.PORT || 3000;

app.get("/", (req, res) => res.send("✅ Bot WhatsApp PPDB aktif..."));

app.get("/qr", async (req, res) => {
  if (!latestQrData) return res.send("⚠️ QR belum tersedia / sudah discan.");
  const img = await QRCode.toDataURL(latestQrData);
  res.send(`<h2>Scan QR WhatsApp</h2><img src="${img}" />`);
});

app.get("/health", (req, res) => res.json({ ok: true, waConnected: Boolean(waSock) }));

app.post("/send-message", async (req, res) => {
  try {
    if (!waSock) return res.status(503).json({ ok: false, error: "WA belum siap" });

    const { nomor, pesan } = req.body || {};
    if (!nomor || !pesan) return res.status(400).json({ ok: false, error: "nomor & pesan wajib" });

    const jid = toJid(nomor);
    await waSock.sendMessage(jid, { text: pesan });
    res.json({ ok: true });
  } catch (err) {
    console.error("send-message error", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/approve-and-notify", async (req, res) => {
  try {
    const { id, nomor, pesan, status = "approved" } = req.body || {};
    if (!id || !nomor) return res.status(400).json({ ok: false, error: "id & nomor wajib" });

    const { error } = await supabase
