require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { exec } = require('child_process');
const fs      = require('fs');
const path    = require('path');
const multer  = require('multer');
const https   = require('https');

// ✅ Auth centralizat prin HUB
const { authenticate, hubAPI } = require('./hub-auth');

const app  = express();
const PORT = process.env.PORT || 3000;

// ══════════════════════════════════════════════════════════════
// ██ CONFIG
// ══════════════════════════════════════════════════════════════
const AI33_API_KEY  = process.env.AI33_API_KEY;
const AI33_BASE_URL = 'https://api.ai33.pro';

const CREDIT_COST = 2; // cost per usage pentru TOATE tool-urile

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
app.use('/downloads', express.static(DOWNLOAD_DIR));

// ══════════════════════════════════════════════════════════════
// ██ VOICE ID MAP (din voices.js — toate vocile AI33/ElevenLabs)
// ══════════════════════════════════════════════════════════════
const VOICE_ID_MAP = {
    "Bella":      "hpp4J3VqNfWAUOO0d1Us",
    "Alex":       "yl2ZDV1MzN4HbQJbMihG",
    "Roger":      "CwhRBWXzGAHq8TQ4Fs17",
    "Sarah":      "EXAVITQu4vr4xnSDxMaL",
    "Laura":      "FGY2WhTYpPnrIDTdsKH5",
    "Charlie":    "IKne3meq5aSn9XLyUdCD",
    "George":     "JBFqnCBsd6RMkjVDRZzb",
    "Callum":     "N2lVS1w4EtoT3dr4eOWO",
    "River":      "SAz9YHcvj6GT2YYXdXww",
    "Harry":      "SOYHLrjzK2X1ezoPC6cr",
    "Liam":       "TX3LPaxmHKxFdv7VOQHJ",
    "Kuon":       "pMsXgVXv3BLzUgSXRplE",
    "Aria":       "9BWtsMINqrJLrRacOk9x",
    "Reginald":   "onwK4e9ZLuTAKqWW03F9",
    "Jane":       "Xb7hH8MSUJpSbSDYk0k2",
    "Juniper":    "zcAOhNBS3c14rBihAFp1",
    "Arabella":   "jBpfuIE2acCO8z3wKNLl",
    "Hope":       "ODq5zmih8GrVes37Dx9b",
    "Blondie":    "XrExE9yKIg1WjnnlVkGX",
    "Priyanka":   "c1Yh0AkPmCiEa4bBMJJU",
    "Alexandra":  "ThT5KcBeYPX3keUQqHPh",
    "Paul":       "nPczCjzI2devNBz1zQrb",
    "Drew":       "29vD33N1CtxCmqQRPOHJ",
    "Clyde":      "2EiwWnXFnvU5JabPnv8n",
    "Dave":       "CYw3kZ02Hs0563khs1Fj",
    "Fin":        "D38z5RcWu1voky8WS1ja",
    "James":      "ZQe5CZNOzWyzPSCn5a3c",
    "Austin":     "g5CIjZEefAph4nQFvHAz",
    "Mark":       "UgBBYS2sOqTuMpoF3BR0",
    "Rachel":     "21m00Tcm4TlvDq8ikWAM",
    "Domi":       "AZnzlk1XvdvUeBnXmlld",
};

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
// ██ HELPER — Descărcare audio de pe URL
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

// ══════════════════════════════════════════════════════════════
// ██ HELPER — Polling task AI33
// ══════════════════════════════════════════════════════════════
async function pollTask(taskId, maxWait = 60000) {
    const interval    = 3000;
    const maxAttempts = Math.floor(maxWait / interval);

    for (let i = 0; i < maxAttempts; i++) {
        await new Promise(r => setTimeout(r, interval));
        let response;
        try {
            response = await fetch(`${AI33_BASE_URL}/v1/task/${taskId}`, {
                headers: { 'xi-api-key': AI33_API_KEY },
                signal: AbortSignal.timeout(10000)
            });
        } catch (fetchErr) {
            console.warn(`⚠️ Polling fetch error attempt ${i + 1}: ${fetchErr.message}`);
            continue;
        }

        if (response.status === 503 || response.status === 502) {
            console.warn(`⚠️ AI33 polling ${response.status}, attempt ${i + 1}, reîncercăm...`);
            continue;
        }
        if (!response.ok) throw new Error(`Polling eșuat: ${response.status}`);

        const task = await response.json();

        if (task.status === 'done') {
            const audioUrl = task.metadata?.audio_url || task.output_uri || task.metadata?.output_uri;
            if (!audioUrl) throw new Error("Task finalizat dar fără URL audio.");
            return audioUrl;
        }
        if (task.status === 'error' || task.status === 'failed') {
            throw new Error(task.error_message || "Eroare la generarea vocii în AI33.");
        }
        // pending/processing — continuăm
    }
    throw new Error("Timeout: generarea a durat prea mult (60s). Încearcă din nou.");
}

// ══════════════════════════════════════════════════════════════
// ██ 1. VOICE GENERATION  (cost: 2.5 credite + voice_characters)
// ══════════════════════════════════════════════════════════════
app.post('/api/generate', authenticate, async (req, res) => {
    try {
        const { text, voice, stability, similarity_boost, speed } = req.body;
        if (!text) return res.status(400).json({ error: "Script text lipsă." });

        // Costul în caractere (fără spații)
        const charCost = (text || '').replace(/\s+/g, '').length;

        // Verificăm AMBELE: credite + voice_characters
        const balance = await hubAPI.checkCredits(req.userId);
        if (balance.credits < CREDIT_COST) {
            return res.status(403).json({ error: `Cost: ${CREDIT_COST} Credite. Fonduri insuficiente.` });
        }
        if (balance.voice_characters < charCost) {
            return res.status(403).json({ error: `Fonduri insuficiente. Ai nevoie de ${charCost} caractere voce.` });
        }

        const voiceId  = req.body.voiceId || VOICE_ID_MAP[voice] || VOICE_ID_MAP["Paul"];
        const modelId  = "eleven_multilingual_v2";

        console.log(`🎙️ [${new Date().toLocaleTimeString('ro-RO')}] Voice gen | user: ${req.userId} | voce: ${voice} (${voiceId}) | chars: ${charCost}`);

        // Apel AI33 TTS
        let ai33Response;
        try {
            ai33Response = await fetch(
                `${AI33_BASE_URL}/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'xi-api-key': AI33_API_KEY },
                    body: JSON.stringify({
                        text,
                        model_id: modelId,
                        voice_settings: {
                            stability:        parseFloat(stability)       || 0.5,
                            similarity_boost: parseFloat(similarity_boost)|| 0.75,
                            speed:            Math.min(2.0, Math.max(0.7, parseFloat(speed) || 1.0))
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
            console.error("Eroare AI33:", ai33Response.status, errBody);
            if (ai33Response.status === 429) return res.status(429).json({ error: "Sistem suprasolicitat. Așteaptă câteva secunde." });
            if (ai33Response.status === 503 || ai33Response.status === 502) return res.status(503).json({ error: "Serviciul de voce e indisponibil momentan." });
            throw new Error(`AI33 eroare ${ai33Response.status}`);
        }

        const ai33Data = await ai33Response.json();
        if (!ai33Data.success || !ai33Data.task_id) throw new Error("AI33 nu a returnat task_id valid.");

        const outputUrl = await pollTask(ai33Data.task_id);
        const fileName  = `voice_${Date.now()}.mp3`;
        const filePath  = path.join(DOWNLOAD_DIR, fileName);
        await downloadAudio(outputUrl, filePath);

        // Scădem AMBELE: credite + caractere voce
        let remaining = null;
        try {
            await hubAPI.useCredits(req.userId, CREDIT_COST);
            const charResult = await hubAPI.useVoiceChars(req.userId, charCost);
            remaining = charResult.voice_characters;
        } catch (e) {
            console.warn("Eroare la scăderea creditelor/chars:", e.message);
        }

        res.json({ audioUrl: `/downloads/${fileName}`, remaining_chars: remaining });

    } catch (error) {
        console.error("VOICE GEN ERROR:", error.message);
        res.status(500).json({ error: error.message || "Eroare la generarea vocii." });
    }
});

// ══════════════════════════════════════════════════════════════
// ██ 2. DOWNLOAD VIDEO/AUDIO  (cost: 2.5 credite)
// ══════════════════════════════════════════════════════════════
app.post('/api/download', authenticate, async (req, res) => {
    try {
        const { url, format = 'mp4', quality = 'best', transcript = false } = req.body;

        if (!url || !url.startsWith('http')) {
            return res.status(400).json({ error: 'Link invalid. Trimite un URL valid.' });
        }

        const balance = await hubAPI.checkCredits(req.userId);
        if (balance.credits < CREDIT_COST) {
            return res.status(403).json({ error: `Cost: ${CREDIT_COST} Credite. Fonduri insuficiente.` });
        }

        const videoId   = Date.now();
        const baseName  = `video_${videoId}`;
        const videoOut  = path.join(DOWNLOAD_DIR, `${baseName}.mp4`);
        const audioOut  = path.join(DOWNLOAD_DIR, `${baseName}.mp3`);

        let qualityFlag = '';
        if (quality === 'best')  qualityFlag = '-f bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
        else if (quality === '1080p') qualityFlag = '-f "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]"';
        else if (quality === '720p')  qualityFlag = '-f "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]"';
        else if (quality === '480p')  qualityFlag = '-f "bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480]"';
        else qualityFlag = '-f best';

        const result = { videoUrl: null, audioUrl: null, transcript: null };

        // Descărcare video
        if (format === 'mp4' || format === 'both') {
            await new Promise((resolve, reject) => {
                const proxyFlag = process.env.YT_PROXY ? `--proxy "${process.env.YT_PROXY}"` : '';
                const cmd = `yt-dlp ${qualityFlag} --merge-output-format mp4 -o "${videoOut}" --no-warnings ${proxyFlag} "${url}"`;
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

        // Descărcare audio
        if (format === 'mp3' || format === 'both') {
            await new Promise((resolve, reject) => {
                const proxyFlag = process.env.YT_PROXY ? `--proxy "${process.env.YT_PROXY}"` : '';
                const cmd = `yt-dlp -x --audio-format mp3 --audio-quality 0 -o "${audioOut}" --no-warnings ${proxyFlag} "${url}"`;
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

        // Transcript
        if (transcript) {
            try {
                await new Promise((resolve) => {
                    const proxyFlag = process.env.YT_PROXY ? `--proxy "${process.env.YT_PROXY}"` : '';
                    const cmd = `yt-dlp --write-subs --write-auto-subs --sub-langs "ro,en,ro-RO,en-US" --skip-download --convert-subs vtt -o "${path.join(DOWNLOAD_DIR, baseName)}" --no-warnings ${proxyFlag} "${url}"`;
                    exec(cmd, { timeout: 60000 }, () => resolve());
                });

                const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith(baseName) && f.endsWith('.vtt'));
                if (files.length > 0) {
                    const vttContent = fs.readFileSync(path.join(DOWNLOAD_DIR, files[0]), 'utf8');
                    result.transcript = vttContent
                        .split('\n')
                        .filter(l => l && !l.startsWith('WEBVTT') && !l.startsWith('NOTE') && !l.includes('-->') && !/^\d+$/.test(l.trim()))
                        .map(l => l.replace(/<[^>]+>/g, '').trim())
                        .filter(l => l.length > 0)
                        .join(' ')
                        .replace(/\s+/g, ' ')
                        .trim();

                    files.forEach(f => { try { fs.unlinkSync(path.join(DOWNLOAD_DIR, f)); } catch {} });
                }
            } catch (e) {
                console.warn('Transcript error (non-fatal):', e.message);
            }
        }

        const creditResult = await hubAPI.useCredits(req.userId, CREDIT_COST);
        result.creditsLeft = creditResult.credits;

        res.json({ status: 'ok', ...result });

    } catch (e) {
        console.error('DOWNLOAD ERROR:', e.message);
        res.status(500).json({ error: e.message || 'Eroare la descărcare.' });
    }
});

// ══════════════════════════════════════════════════════════════
// ██ 3. SMART CUT — Eliminare silențe (FFmpeg)  (cost: 2.5 credite)
// ══════════════════════════════════════════════════════════════
app.post('/api/smart-cut', authenticate, upload.single('file'), async (req, res) => {
    try {
        const balance = await hubAPI.checkCredits(req.userId);
        if (balance.credits < CREDIT_COST) {
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(403).json({ error: `Cost: ${CREDIT_COST} Credite. Fonduri insuficiente.` });
        }
        if (!req.file) return res.status(400).json({ error: 'Fișier lipsă.' });

        const inputFile  = req.file.path;
        const outputFile = path.join(DOWNLOAD_DIR, `cut_${Date.now()}.mp3`);
        const threshold  = req.body.threshold  || '-45dB';
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
                const result = await hubAPI.useCredits(req.userId, CREDIT_COST);
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
// ██ 4. CAPTION REMOVER — Ștergere text video (FFmpeg delogo)  (cost: 2.5 credite)
// ══════════════════════════════════════════════════════════════
app.post('/api/remove-caption', authenticate, upload.single('video'), async (req, res) => {
    try {
        const balance = await hubAPI.checkCredits(req.userId);
        if (balance.credits < CREDIT_COST) {
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(403).json({ error: `Cost: ${CREDIT_COST} Credite. Fonduri insuficiente.` });
        }
        if (!req.file) return res.status(400).json({ error: "Video lipsă." });

        // Scădem creditele IMEDIAT la upload, înainte de procesare
        let creditsLeft = 0;
        try {
            const creditResult = await hubAPI.useCredits(req.userId, CREDIT_COST);
            creditsLeft = creditResult.credits;
        } catch (e) {
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            return res.status(500).json({ error: "Eroare la scăderea creditelor." });
        }

        const inputPath  = req.file.path;
        const videoId    = Date.now();
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

            const filterString   = `delogo=x=${pixelX}:y=${pixelY}:w=${pixelW}:h=${pixelH}`;
            const ffmpegCommand  = `ffmpeg -y -i "${inputPath}" -vf "${filterString}" -map 0:v:0 -map 0:a? -c:v libx264 -preset ultrafast -crf 23 -c:a copy "${outputPath}"`;

            exec(ffmpegCommand, { timeout: 600000 }, async (error, stdout, stderr) => {
                if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
                if (error) {
                    console.error("FFMPEG ERROR:", stderr);
                    return res.status(500).json({ error: "Eroare video. Încearcă o zonă puțin mai mică." });
                }
                res.json({ status: 'ok', downloadUrl: `/downloads/clean_${videoId}.mp4`, creditsLeft });
            });
        });
    } catch (e) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: e.message });
    }
});

// ══════════════════════════════════════════════════════════════
// ██ 5. WHISPER TRANSCRIBE  (fără cost extra — inclus în pipeline)
// ══════════════════════════════════════════════════════════════
app.post('/api/transcribe', authenticate, upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Fișier audio lipsă.' });
    const inputPath = req.file.path;
    try {
        // AI33 Whisper endpoint (OpenAI-compatible)
        const FormData = require('form-data');
        const form = new FormData();
        form.append('file', fs.createReadStream(inputPath), { filename: 'audio.mp3', contentType: 'audio/mpeg' });
        form.append('model', 'whisper-1');
        form.append('response_format', 'text');

        const whisperRes = await fetch(`${AI33_BASE_URL}/v1/audio/transcriptions`, {
            method: 'POST',
            headers: { 'xi-api-key': AI33_API_KEY, ...form.getHeaders() },
            body: form,
            signal: AbortSignal.timeout(120000)
        });

        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);

        if (!whisperRes.ok) {
            const err = await whisperRes.text();
            console.error('Whisper error:', whisperRes.status, err);
            return res.status(500).json({ error: 'Transcrierea Whisper a eșuat.' });
        }

        const text = await whisperRes.text();
        console.log(`🎤 Whisper transcris: ${text.length} chars`);
        res.json({ transcript: text.trim() });

    } catch (e) {
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        console.error('Transcribe error:', e.message);
        res.status(500).json({ error: e.message || 'Eroare la transcriere.' });
    }
});

// ══════════════════════════════════════════════════════════════
// ██ 6. TRADUCERE în română  (fără cost extra — inclus în pipeline)
// ══════════════════════════════════════════════════════════════
app.post('/api/translate', authenticate, async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Text lipsă.' });

    try {
        const translateRes = await fetch(`${AI33_BASE_URL}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'xi-api-key': AI33_API_KEY },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [
                    {
                        role: 'system',
                        content: 'Ești un traducător profesionist. Traduce textul primit în română naturală, păstrând tonul și stilul original. Returnează DOAR textul tradus, fără explicații, fără ghilimele, fără prefixe.'
                    },
                    { role: 'user', content: text }
                ],
                max_tokens: 4000,
                temperature: 0.3
            }),
            signal: AbortSignal.timeout(30000)
        });

        if (!translateRes.ok) {
            const err = await translateRes.text();
            console.error('Translate error:', translateRes.status, err);
            return res.status(500).json({ error: 'Traducerea a eșuat.' });
        }

        const data = await translateRes.json();
        const translated = data.choices?.[0]?.message?.content?.trim();
        if (!translated) return res.status(500).json({ error: 'Răspuns traducere invalid.' });

        console.log(`🌍 Tradus: ${text.length} → ${translated.length} chars`);
        res.json({ translated });

    } catch (e) {
        console.error('Translate error:', e.message);
        res.status(500).json({ error: e.message || 'Eroare la traducere.' });
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

// ══════════════════════════════════════════════════════════════
// ██ SPA FALLBACK (Express v5 compatible)
// ══════════════════════════════════════════════════════════════
app.get('/{*path}', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.listen(PORT, () => console.log(`🚀 Viralio Pipeline rulează pe portul ${PORT}!`));