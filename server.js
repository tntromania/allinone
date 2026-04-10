require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

// ✅ Auth centralizat prin HUB
const { authenticate, hubAPI } = require('./hub-auth');

const app = express();
const PORT = process.env.PORT || 3000;

const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

const upload = multer({ 
    dest: DOWNLOAD_DIR, 
    limits: { fileSize: 500 * 1024 * 1024 } // 500MB
});

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════════════════════════
// ██ AUTH ROUTES — proxy către HUB
// ══════════════════════════════════════════════════════════════

// Login-ul Google se face PE HUB (redirect sau iframe)
// Dar dacă frontend-ul existent trimite credentialul aici, îl trimitem mai departe la HUB
app.post('/api/auth/google', async (req, res) => {
    try {
        const response = await fetch(`${process.env.HUB_URL}/api/auth/google`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body),
        });
        const data = await response.json();
        res.status(response.status).json(data);
    } catch (e) {
        res.status(500).json({ error: 'Nu pot comunica cu serverul principal.' });
    }
});

app.get('/api/auth/me', authenticate, async (req, res) => {
    res.json({ user: req.user });
});

// ══════════════════════════════════════════════════════════════
// ██ CAPTION REMOVER (FFMPEG)
// ══════════════════════════════════════════════════════════════
app.post('/api/remove-caption', authenticate, upload.single('video'), async (req, res) => {
    try {
        // Verificăm creditele prin HUB
        const balance = await hubAPI.checkCredits(req.userId);
        if (balance.credits < 0.5) {
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(403).json({ error: "Cost: 0.5 Credite. Fonduri insuficiente." });
        }
        if (!req.file) return res.status(400).json({ error: "Video lipsă." });

        const inputPath = req.file.path;
        const videoId = Date.now();
        const outputPath = path.join(DOWNLOAD_DIR, `clean_${videoId}.mp4`);

        const boxY = req.body.boxY !== undefined ? parseInt(req.body.boxY) : 70;
        const boxH = req.body.boxH !== undefined ? parseInt(req.body.boxH) : 20;
        const boxX = req.body.boxX !== undefined ? parseInt(req.body.boxX) : 10;
        const boxW = req.body.boxW !== undefined ? parseInt(req.body.boxW) : 80;

        exec(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${inputPath}"`, (probeErr, probeOut) => {
            if (probeErr) {
                if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
                return res.status(500).json({ error: "Eroare la analiza metadatelor." });
            }

            const [width, height] = probeOut.trim().split('x').map(Number);

            let pixelY = Math.floor((boxY / 100) * height);
            let pixelH = Math.floor((boxH / 100) * height);
            let pixelX = Math.floor((boxX / 100) * width);
            let pixelW = Math.floor((boxW / 100) * width);

            if (pixelY + pixelH > height - 2) pixelH = height - pixelY - 2;
            if (pixelY < 2) pixelY = 2;
            if (pixelH < 2) pixelH = 2;
            if (pixelX + pixelW > width - 2) pixelW = width - pixelX - 2;
            if (pixelX < 2) pixelX = 2;
            if (pixelW < 2) pixelW = 2;

            const filterString = `delogo=x=${pixelX}:y=${pixelY}:w=${pixelW}:h=${pixelH}`;
            const ffmpegCommand = `ffmpeg -y -i "${inputPath}" \
  -vf "${filterString}" \
  -map 0:v:0 \
  -map 0:a? \
  -c:v libx264 -preset ultrafast -crf 23 \
  -c:a copy \
  "${outputPath}"`;

            exec(ffmpegCommand, async (error, stdout, stderr) => {
                if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);

                if (error) {
                    console.error("FFMPEG ERROR:", stderr);
                    return res.status(500).json({ error: "Eroare video. Încearcă o zonă puțin mai mică." });
                }

                // Scădem creditele prin HUB (atomic)
                try {
                    const result = await hubAPI.useCredits(req.userId, 0.5);
                    res.json({ status: 'ok', downloadUrl: `/download/clean_${videoId}.mp4`, creditsLeft: result.credits });
                } catch (e) {
                    // Video-ul e procesat dar nu s-au putut scădea creditele — trimitem oricum
                    res.json({ status: 'ok', downloadUrl: `/download/clean_${videoId}.mp4`, creditsLeft: 0 });
                }
            });
        });
    } catch (e) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: e.message });
    }
});

app.get('/download/:filename', (req, res) => {
    const file = path.join(DOWNLOAD_DIR, req.params.filename);
    if (fs.existsSync(file)) res.sendFile(file); else res.status(404).send('Expirat.');
});

app.listen(PORT, () => console.log(`🚀 Fast Captions rulează pe ${PORT}!`));