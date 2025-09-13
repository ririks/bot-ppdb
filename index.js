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
  let { data, error } = await supabase
    .from("form_steps")
    .select("*")
    .eq("step", step)
    .order("jenjang_kode", { ascending: false }); // biar jenjang lebih prioritas

  if (error || !data) return null;

  if (jenjang) {
    // cari dulu instruksi khusus sesuai jenjang
    const khusus = data.find((d) => d.jenjang_kode === jenjang);
    if (khusus) return khusus;
  }

  // fallback ke instruksi umum (jenjang_kode null)
  return data.find((d) => d.jenjang_kode === null) || null;
}

// =====================================
// Handler pesan WA (pakai getStepInstruction)
// =====================================
async function handleMessage(msg) {
  const from = msg.key.remoteJid;
  const body = msg.message?.conversation || "";

  // ambil step berikutnya dari session
  const session = getSession(from);

  const nextStep = session.step + 1;
  const instruksiNext = await getStepInstruction(nextStep, session.data.jenjang_kode);

  if (instruksiNext) {
    session.step = nextStep;
    await sock.sendMessage(from, { text: instruksiNext.instruksi });
  } else {
    // kalau sudah tidak ada step lagi → simpan ke tabel pendaftaran
    await supabase.from("pendaftaran_ppdb").insert([{ ...session.data }]);
  }
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
      if (from.endsWith("@g.us")) return; // skip group

      const nama = msg.pushName || "Tanpa Nama";
      const nomor = from.replace("@s.whatsapp.net", "");

      // simpan/refresh user di tabel users_wa
      await supabase.from("users_wa").upsert({ nomor, nama }, { onConflict: "nomor" });

      const content = extractMessage(msg);
      if (!content) return;

      const isImage = content.type === "image";
      const text = content.type === "text" ? (content.data || "").trim() : "";
      const lower = (text || "").toLowerCase();

      // handle menu/start (bisa keluar dari session)
      if (["menu", "help", "start", "mulai"].includes(lower)) {
        sessions[nomor] = null;
        return sock.sendMessage(from, { text: HELP_TEXT });
      }

      // --- IMPORTANT: if session exists, handle registration flow first ---
      if (sessions[nomor]) {
        // existing session: process current step
        const session = sessions[nomor];
        if (!session) {
          sessions[nomor] = null;
          return sock.sendMessage(from, { text: HELP_TEXT });
        }

        const instruksiNow = await getStepInstruction(session.step, session.data.jenjang_kode);
        if (!instruksiNow) {
          console.error(`Instruksi tidak ditemukan untuk step=${session.step} jenjang=${session.data.jenjang_kode}`);
          sessions[nomor] = null;
          return sock.sendMessage(from, { text: withFooter("⚠️ Instruksi step tidak ditemukan. Hubungi admin.") });
        }

        // handle text-type step
        if (instruksiNow.tipe === "text") {
          if (instruksiNow.kode === "data_diri") {
            // expect format: #Nama #YYYY-MM-DD #Jenjang #NomorKK
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
            // other text steps
            session.data[instruksiNow.kode] = text;
          }
        } else if (instruksiNow.tipe === "image") {
  if (!isImage) {
    return sock.sendMessage(from, { text: withFooter(`❌ Tolong kirim *gambar* untuk: ${instruksiNow.instruksi}`) });
  }
  try {
    const uploadedUrl = await uploadToSupabaseStorage(content.data, `${nomor}/${instruksiNow.kode}`);
    if (instruksiNow.kode === "akta") {
      session.data.akta_lahir_url = uploadedUrl; // FIX: sesuai nama kolom
    } else {
      session.data[`${instruksiNow.kode}_url`] = uploadedUrl;
    }
  } catch (err) {
    console.error("upload error", err);
    return sock.sendMessage(from, { text: withFooter("❌ Gagal upload gambar. Coba lagi.") });
  }
}


        // move to next step if exists
        const nextStep = session.step + 1;
        const instruksiNext = await getStepInstruction(nextStep, session.data.jenjang_kode);

        if (instruksiNext) {
          // ada langkah selanjutnya -> naikkan step & kirim instruksi
          session.step = nextStep;
          return sock.sendMessage(from, { text: withFooter(instruksiNext.instruksi) });
        } else {
          // tidak ada langkah selanjutnya -> simpan pendaftaran
          try {
           await supabase.from("pendaftaran_ppdb").insert([{
  nomor,
  nama: session.data.nama || null,
  tgl_lahir: session.data.tgl_lahir || null,
  jenjang_kode: session.data.jenjang_kode || null,
  nomor_kk: session.data.nomor_kk || null,
  kk_url: session.data.kk_url || "BELUM ADA",
  akta_lahir_url: session.data.akta_lahir_url || "BELUM ADA",
  rapor_url: session.data.rapor_url || "BELUM ADA",
  ijazah_url: session.data.ijazah_url || "BELUM ADA",
  foto_url: session.data.foto_url || "BELUM ADA",
  status: "pending",
  created_at: new Date().toISOString(),
}]);

            }]);
          } catch (insertErr) {
            console.error("insert pendaftaran_ppdb error", insertErr);
            sessions[nomor] = null;
            return sock.sendMessage(from, { text: withFooter("❌ Gagal menyimpan pendaftaran. Hubungi admin.") });
          }

          await kurangiKuota(session.data.jenjang_kode);
          sessions[nomor] = null;

          console.log(`✅ Pendaftaran baru: ${session.data.nama} (${session.data.jenjang_kode})`);
          return sock.sendMessage(from, { text: withFooter("✅ Pendaftaran berhasil! Terima kasih.") });
        }
      } // end session flow

      // jika tidak ada session, cek apakah user ingin START daftar
      if (lower.includes("daftar")) {
        sessions[nomor] = { step: 1, data: {} };
        const instruksi = await getStepInstruction(1);
        return sock.sendMessage(from, { text: withFooter(instruksi?.instruksi || "⚠️ Langkah 1 belum tersedia.") });
      }

      // deteksi FAQ keywords (hanya kalau tidak sedang di session)
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

      // fallback help
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
// Start bot & web server + API
// =====================================
startBot().catch(err => console.error("startBot error", err));

const app = express();
app.use(cors({
  origin: "https://dashboard-ppdb-production.up.railway.app"
}));
app.use(express.json());

const port = process.env.PORT || 3000;

app.get("/", (req, res) => res.send("✅ Bot WhatsApp PPDB aktif..."));

app.get("/qr", async (req, res) => {
  if (!latestQrData) return res.send("⚠️ QR belum tersedia / sudah discan.");
  const img = await QRCode.toDataURL(latestQrData);
  res.send(`<h2>Scan QR WhatsApp</h2><img src="${img}" />`);
});

app.get("/health", (req, res) => {
  res.json({ ok: true, waConnected: Boolean(waSock) });
});

// send-message endpoint (dashboard)
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

// approve-and-notify
app.post("/approve-and-notify", async (req, res) => {
  try {
    const { id, nomor, pesan, status = "approved" } = req.body || {};
    if (!id || !nomor) return res.status(400).json({ ok: false, error: "id & nomor wajib" });

    const { error } = await supabase
      .from("pendaftaran_ppdb")
      .update({ status })
      .eq("id", id);

    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }

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

// ✅ FIX: proper app.listen callback block
app.listen(port, () => {
  console.log(`🌍 Web server berjalan di port ${port}`);
});
