# Telegram Inviter Counter Bot (Node.js)

Bot Telegram untuk menghitung **siapa yang menambahkan anggota baru ke grup**.  
⚠️ **Tidak menghitung join via link undangan** atau join sendiri, hanya manual add (A menambahkan B).  

## ✨ Fitur
- Hitung **A added B** saja.
- Abaikan join via **link** dan join sendiri.
- `/start` di grup → set **admin penerima laporan**.
- Laporan ke admin berisi:
  - Username
  - User ID (@handle)
  - Pengundang (Adder)
  - Total undangan
  - Waktu update
  - Grup
  - Tombol **Reset**
- `/mystats` → cek total undangan kamu di grup.
- **Reset counter** via tombol inline (hanya admin penerima).

## 🚀 Deploy ke Railway
1. Fork / upload file:
   - `index.js`
   - `package.json`
   - `README.md`
2. Buat project baru di [Railway](https://railway.app/) → **Deploy from GitHub** → pilih repo ini.
3. Tambahkan **Environment Variables**:
   - `BOT_TOKEN` → token dari [@BotFather](https://t.me/botfather)
   - `WEBHOOK_URL` → `https://<APPNAME>.up.railway.app/telegram`
4. Railway otomatis menjalankan `npm install` & `npm start`.
5. Tambahkan bot ke grup (jadikan admin).
6. Di grup, jalankan `/start` oleh admin yang akan menerima laporan.
7. Selesai 🎉 Bot siap digunakan.

## ⚙️ Command & Cara Pakai
- `/start` (di grup) → set admin penerima laporan.
- `/mystats` → lihat total undangan kamu di grup.
- Saat ada **A menambahkan B**:
  - Bot kirim laporan ke admin penerima.
  - Admin bisa tekan tombol **Reset** untuk hapus counter user tertentu.

## 📂 Struktur Project
