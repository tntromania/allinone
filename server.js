require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const https = require('https');

// ✅ Auth centralizat prin HUB
const { authenticate, hubAPI } = require('./hub-auth');

const app = express();
const PORT = process.env.PORT || 3000;

// ══════════════════════════════════════════════════════════════
// ██ CONFIGURARE
// ══════════════════════════════════════════════════════════════
const AI33_API_KEY = process.env.AI33_API_KEY;
const AI33_BASE_URL = 'https://api.ai33.pro';

const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const PUBLIC_DIR   = path.join(__dirname, 'public');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

const upload = multer({
    dest: DOWNLOAD_DIR,
    limits: { fileSize: 500 * 1024 * 1024 } // 500MB
});

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// Servim fișierele descărcate
app.use('/downloads', express.static(DOWNLOAD_DIR));

// ══════════════════════════════════════════════════════════════
// ██ AUTH ROUTES — proxy către HUB
// ══════════════════════════════════════════════════════════════
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
// ██ DOWNLOAD + TRANSCRIPT (yt-dlp)
// ══════════════════════════════════════════════════════════════
app.post('/api/download', authenticate, async (req, res) => {
    try {
        const { url, format = 'mp4', quality = 'best', transcript = false } = req.body;

        if (!url || !url.startsWith('http')) {
            return res.status(400).json({ error: 'Link invalid. Trimite un URL valid.' });
        }

        // Verificăm creditele
        const balance = await hubAPI.checkCredits(req.userId);
        if (balance.credits < 1) {
            return res.status(403).json({ error: 'Cost: 1 Credit. Fonduri insuficiente.' });
        }

        const videoId = Date.now();
        const baseName = `video_${videoId}`;
        const videoOut = path.join(DOWNLOAD_DIR, `${baseName}.mp4`);
        const audioOut = path.join(DOWNLOAD_DIR, `${baseName}.mp3`);

        // Construim comanda yt-dlp
        let qualityFlag = '';
        if (quality === 'best') qualityFlag = '-f bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
        else if (quality === '1080p') qualityFlag = '-f "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]"';
        else if (quality === '720p') qualityFlag = '-f "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]"';
        else if (quality === '480p') qualityFlag = '-f "bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480]"';
        else qualityFlag = '-f best';

        const result = { videoUrl: null, audioUrl: null, transcript: null };

        // Descărcare video (mp4 sau both)
        if (format === 'mp4' || format === 'both') {
            await new Promise((resolve, reject) => {
                const cmd = `yt-dlp ${qualityFlag} --merge-output-format mp4 -o "${videoOut}" --no-warnings "${url}"`;
                exec(cmd, { timeout: 300000 }, (err, stdout, stderr) => {
                    if (err) {
                        console.error('yt-dlp video error:', stderr);
                        return reject(new Error('Descărcarea video a eșuat. Verifică link-ul sau încearcă altă calitate.'));
                    }
                    result.videoUrl = `/downloads/${baseName}.mp4`;
                    resolve();
                });
            });
        }

        // Descărcare audio (mp3 sau both)
        if (format === 'mp3' || format === 'both') {
            await new Promise((resolve, reject) => {
                const cmd = `yt-dlp -x --audio-format mp3 --audio-quality 0 -o "${audioOut}" --no-warnings "${url}"`;
                exec(cmd, { timeout: 300000 }, (err, stdout, stderr) => {
                    if (err) {
                        console.error('yt-dlp audio error:', stderr);
                        return reject(new Error('Extragerea audio a eșuat.'));
                    }
                    result.audioUrl = `/downloads/${baseName}.mp3`;
                    resolve();
                });
            });
        }

        // Transcript (subtitles YouTube sau auto-generated)
        if (transcript) {
            try {
                const subPath = path.join(DOWNLOAD_DIR, `${baseName}.vtt`);
                // Încearcă mai întâi subtitles manuale, apoi auto-generate
                await new Promise((resolve) => {
                    const cmd = `yt-dlp --write-subs --write-auto-subs --sub-langs "ro,en,ro-RO,en-US" --skip-download --convert-subs vtt -o "${path.join(DOWNLOAD_DIR, baseName)}" --no-warnings "${url}"`;
                    exec(cmd, { timeout: 60000 }, (err) => resolve()); // nu fail dacă nu găsim
                });

                // Citim primul fișier .vtt găsit
                const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith(baseName) && f.endsWith('.vtt'));
                if (files.length > 0) {
                    const vttContent = fs.readFileSync(path.join(DOWNLOAD_DIR, files[0]), 'utf8');
                    // Parsăm VTT → text curat
                    result.transcript = vttContent
                        .split('\n')
                        .filter(l => l && !l.startsWith('WEBVTT') && !l.startsWith('NOTE') && !l.includes('-->') && !/^\d+$/.test(l.trim()))
                        .map(l => l.replace(/<[^>]+>/g, '').trim())
                        .filter(l => l.length > 0)
                        .join(' ')
                        .replace(/\s+/g, ' ')
                        .trim();

                    // Curățăm fișierele vtt
                    files.forEach(f => {
                        try { fs.unlinkSync(path.join(DOWNLOAD_DIR, f)); } catch {}
                    });
                }
            } catch (e) {
                console.warn('Transcript error (non-fatal):', e.message);
            }
        }

        // Scădem creditul
        const creditResult = await hubAPI.useCredits(req.userId, 1);
        result.creditsLeft = creditResult.credits;

        res.json({ status: 'ok', ...result });

    } catch (e) {
        console.error('DOWNLOAD ERROR:', e.message);
        res.status(500).json({ error: e.message || 'Eroare la descărcare.' });
    }
});

// ══════════════════════════════════════════════════════════════
// ██ VOICE GENERATION (AI33 / ElevenLabs)
// ══════════════════════════════════════════════════════════════

function downloadAudio(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (response) => {
            if (response.statusCode === 301 || response.statusCode === 302) {
                file.close();
                return downloadAudio(response.headers.location, dest).then(resolve).catch(reject);
            }
            response.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
        }).on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
    });
}

async function pollTask(taskId, maxWait = 90000) {
    const interval = 3000;
    const maxAttempts = Math.floor(maxWait / interval);
    for (let i = 0; i < maxAttempts; i++) {
        await new Promise(r => setTimeout(r, interval));
        let response;
        try {
            response = await fetch(`${AI33_BASE_URL}/v1/task/${taskId}`, {
                headers: { 'xi-api-key': AI33_API_KEY },
                signal: AbortSignal.timeout(10000)
            });
        } catch (err) { console.warn(`⚠️ Polling ${i+1}: ${err.message}`); continue; }

        if (response.status === 503 || response.status === 502) { continue; }
        if (!response.ok) throw new Error(`Polling eșuat: ${response.status}`);

        const task = await response.json();
        if (task.status === 'done') {
            const audioUrl = task.metadata?.audio_url || task.output_uri || task.metadata?.output_uri;
            if (!audioUrl) throw new Error("Task finalizat dar fără URL audio.");
            return audioUrl;
        }
        if (task.status === 'error' || task.status === 'failed') {
            throw new Error(task.error_message || "Eroare la generarea vocii.");
        }
    }
    throw new Error("Timeout: generarea a durat prea mult. Încearcă din nou.");
}

app.post('/api/generate', authenticate, async (req, res) => {
    try {
        const { text, voiceId, voice, stability = 0.5, similarity_boost = 0.75, speed = 1.0 } = req.body;

        if (!text) return res.status(400).json({ error: "Script text lipsă." });

        const balance = await hubAPI.checkCredits(req.userId);
        const textWithoutSpaces = text.replace(/\s+/g, '');
        const charCost = textWithoutSpaces.length;

        // Estimare: 1 credit = 6000 chars (ajustează după tariful real)
        const creditCost = Math.max(0.1, charCost / 6000);
        if (balance.voice_characters !== undefined && balance.voice_characters < charCost) {
            return res.status(403).json({ error: `Fonduri insuficiente. Ai nevoie de ${charCost} caractere.` });
        }

        const resolvedVoiceId = voiceId || 'TX3LPaxmHKxFdv7VOQHJ'; // Liam default

        let ai33Response;
        try {
            ai33Response = await fetch(
                `${AI33_BASE_URL}/v1/text-to-speech/${resolvedVoiceId}?output_format=mp3_44100_128`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'xi-api-key': AI33_API_KEY },
                    body: JSON.stringify({
                        text,
                        model_id: "eleven_multilingual_v2",
                        voice_settings: {
                            stability: parseFloat(stability),
                            similarity_boost: parseFloat(similarity_boost),
                            speed: parseFloat(speed)
                        },
                        with_transcript: false
                    }),
                    signal: AbortSignal.timeout(15000)
                }
            );
        } catch (fetchErr) {
            if (fetchErr.name === 'TimeoutError' || fetchErr.name === 'AbortError')
                return res.status(503).json({ error: "Serverul nu răspunde. Încearcă din nou." });
            throw fetchErr;
        }

        if (!ai33Response.ok) {
            const errBody = await ai33Response.text();
            if (ai33Response.status === 429) return res.status(429).json({ error: "Sistemul este suprasolicitat. Așteaptă câteva secunde." });
            if (ai33Response.status === 503 || ai33Response.status === 502) return res.status(503).json({ error: "Serviciul de voce e momentan indisponibil. Încearcă din nou." });
            throw new Error(`AI33 eroare ${ai33Response.status}`);
        }

        const ai33Data = await ai33Response.json();
        if (!ai33Data.success || !ai33Data.task_id) throw new Error("AI33 nu a returnat task_id valid.");

        const outputUrl = await pollTask(ai33Data.task_id);
        const fileName = `voice_${Date.now()}.mp3`;
        const filePath = path.join(DOWNLOAD_DIR, fileName);
        await downloadAudio(outputUrl, filePath);

        // Scădem caracterele prin HUB (dacă există endpoint)
        let remaining = null;
        try {
            const r = await hubAPI.useCredits(req.userId, creditCost > 0.1 ? creditCost : 0);
            remaining = r.voice_characters ?? r.credits;
        } catch {}

        res.json({ audioUrl: `/downloads/${fileName}`, remaining_chars: remaining });

    } catch (error) {
        console.error("VOICE GEN ERROR:", error.message);
        res.status(500).json({ error: error.message || "Eroare la generarea vocii. Încearcă din nou." });
    }
});

// ══════════════════════════════════════════════════════════════
// ██ SMART CUT (FFmpeg silence removal)
// ══════════════════════════════════════════════════════════════
const { exec: execFfmpeg } = require('child_process');

app.post('/api/smart-cut', authenticate, upload.single('file'), async (req, res) => {
    try {
        const balance = await hubAPI.checkCredits(req.userId);
        if (balance.credits < 0.5) {
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(403).json({ error: "Cost: 0.5 Credite. Fonduri insuficiente." });
        }
        if (!req.file) return res.status(400).json({ error: 'Fișier lipsă' });

        const inputFile = req.file.path;
        const outputFile = path.join(DOWNLOAD_DIR, `cut_${Date.now()}.mp3`);
        const threshold = req.body.threshold || '-45dB';
        const minSilence = req.body.minSilence || '0.35';

        const audioFilter = `silenceremove=start_periods=1:start_duration=0.1:start_threshold=${threshold}:stop_periods=-1:stop_duration=${minSilence}:stop_threshold=${threshold}`;
        const cmd = `ffmpeg -y -i "${inputFile}" -af "${audioFilter}" -c:a libmp3lame -q:a 2 "${outputFile}"`;

        exec(cmd, { timeout: 300000 }, async (err, stdout, stderr) => {
            if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile);
            if (err) {
                console.error("FFmpeg Smart Cut error:", stderr);
                return res.status(500).json({ error: 'Eroare la procesarea audio.' });
            }
            try {
                const result = await hubAPI.useCredits(req.userId, 0.5);
                res.json({ status: 'ok', downloadUrl: `/downloads/${path.basename(outputFile)}`, creditsLeft: result.credits });
            } catch {
                res.json({ status: 'ok', downloadUrl: `/downloads/${path.basename(outputFile)}`, creditsLeft: 0 });
            }
        });
    } catch (e) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: e.message });
    }
});

// ══════════════════════════════════════════════════════════════
// ██ CAPTION REMOVER (FFmpeg delogo)
// ══════════════════════════════════════════════════════════════
app.post('/api/remove-caption', authenticate, upload.single('video'), async (req, res) => {
    try {
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
            const ffmpegCommand = `ffmpeg -y -i "${inputPath}" -vf "${filterString}" -map 0:v:0 -map 0:a? -c:v libx264 -preset ultrafast -crf 23 -c:a copy "${outputPath}"`;

            exec(ffmpegCommand, { timeout: 600000 }, async (error, stdout, stderr) => {
                if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
                if (error) {
                    console.error("FFMPEG ERROR:", stderr);
                    return res.status(500).json({ error: "Eroare video. Încearcă o zonă puțin mai mică." });
                }
                try {
                    const result = await hubAPI.useCredits(req.userId, 0.5);
                    res.json({ status: 'ok', downloadUrl: `/downloads/clean_${videoId}.mp4`, creditsLeft: result.credits });
                } catch {
                    res.json({ status: 'ok', downloadUrl: `/downloads/clean_${videoId}.mp4`, creditsLeft: 0 });
                }
            });
        });
    } catch (e) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: e.message });
    }
});

// ══════════════════════════════════════════════════════════════
// ██ CURĂȚARE FIȘIERE VECHI (24h)
// ══════════════════════════════════════════════════════════════
setInterval(() => {
    fs.readdir(DOWNLOAD_DIR, (err, files) => {
        if (err) return;
        files.forEach(file => {
            const filePath = path.join(DOWNLOAD_DIR, file);
            fs.stat(filePath, (err, stats) => {
                if (!err && (Date.now() - stats.mtimeMs > 86400000)) fs.unlink(filePath, () => {});
            });
        });
    });
}, 3600000);

app.get('*', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.listen(PORT, () => console.log(`🚀 Viralio Pipeline rulează pe portul ${PORT}!`));
