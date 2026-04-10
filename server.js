require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { execFile, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const OpenAI = require('openai');
const mongoose = require('mongoose');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const { authenticate, hubAPI } = require('./hub-auth');

const REQUIRED_ENV = ['OPENAI_API_KEY', 'HUB_URL', 'INTERNAL_API_KEY', 'AI33_API_KEY', 'PROXY_URL'];
for (const key of REQUIRED_ENV) {
    if (!process.env[key]) { console.error(`❌ Variabila de mediu lipsă: ${key}`); process.exit(1); }
}

const app = express();
const PORT = process.env.PORT || 3000;
process.on('unhandledRejection', (reason) => { console.error('⚠️ Unhandled Rejection:', reason?.message || reason); });
app.set('trust proxy', 1);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const AI33_API_KEY = process.env.AI33_API_KEY;
const AI33_BASE_URL = 'https://api.ai33.pro';
const PROXY_URL = process.env.PROXY_URL;

const DOWNLOAD_DIR = path.resolve(__dirname, 'downloads');
const PROCESSED_DIR = path.resolve(__dirname, 'processed');
for (const dir of [DOWNLOAD_DIR, PROCESSED_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const YTDLP_PATH = '/usr/local/bin/yt-dlp';
const uploadTmp = multer({ dest: DOWNLOAD_DIR, limits: { fileSize: 500 * 1024 * 1024 } });

app.use(helmet({ contentSecurityPolicy: false, crossOriginOpenerPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10kb' }));

// FIX #6: assets si index.html direct langa server.js, nu in /public
app.use(express.static(__dirname));

app.use('/api/process-yt', rateLimit({ windowMs: 60 * 1000, max: 10, message: { error: 'Maxim 10 cereri pe minut.' } }));
app.use('/api/auth/google', rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Prea multe încercări.' } }));

if (process.env.MONGO_URI) {
    mongoose.connect(process.env.MONGO_URI)
        .then(() => console.log('✅ Cache MongoDB conectat!'))
        .catch(err => console.warn('⚠️ MongoDB indisponibil:', err.message));
}
const CacheSchema = new mongoose.Schema({
    videoId: String, originalText: String, translatedText: String,
    createdAt: { type: Date, expires: 86400, default: Date.now }
});
const VideoCache = mongoose.models.VideoCache || mongoose.model('VideoCache', CacheSchema);

// ── HELPERS ─────────────────────────────────────────────────
function ts() { return `[${new Date().toISOString().slice(11, 23)}]`; }
function elapsed(s) { const ms = Date.now() - s; return ms < 1000 ? `${ms}ms` : `${(ms/1000).toFixed(1)}s`; }

function sanitizeYouTubeUrl(rawUrl) {
    const url = (rawUrl || '').trim();
    const m = url.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/);
    if (m) return { cleanUrl: `https://www.youtube.com/watch?v=${m[1]}`, videoId: m[1] };
    return null;
}

function runYtDlp(args, opts = {}) {
    return new Promise((resolve, reject) => {
        execFile(YTDLP_PATH, args, { maxBuffer: 1024*1024*200, timeout: opts.timeout || 300000 }, (error, stdout, stderr) => {
            if (error) {
                const errMsg = (stderr||'').split('\n').filter(l=>l.startsWith('ERROR:')).join(' ').trim() || error.message.slice(0,300);
                reject(new Error(errMsg));
            } else resolve({ stdout: stdout?.trim()||'', stderr: stderr?.trim()||'' });
        });
    });
}

const COOKIES_DIR = process.env.COOKIES_DIR ? path.resolve(process.env.COOKIES_DIR) : path.resolve(__dirname, 'cookies');
function cookiesFile() { const f = path.join(COOKIES_DIR, 'youtube.txt'); return fs.existsSync(f) ? f : null; }

function baseArgs() {
    const args = ['--proxy', PROXY_URL, '--no-warnings', '--geo-bypass', '--no-cache-dir', '--retries', '5', '--fragment-retries', '5', '--no-check-certificates', '--no-playlist'];
    const c = cookiesFile(); if (c) args.push('--cookies', c);
    return args;
}
function baseArgsNoProxy() {
    const full = baseArgs(); const idx = full.indexOf('--proxy');
    if (idx !== -1) full.splice(idx, 2); return full;
}

function curlDownload(url, outputPath, timeoutSec = 300, useProxy = false) {
    return new Promise((resolve, reject) => {
        const args = ['-sS', '-L', '--max-time', String(timeoutSec),
            '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
            '-H', 'Referer: https://www.youtube.com/', '-H', 'Accept: */*', '-H', 'Accept-Encoding: identity'];
        if (useProxy) args.push('--proxy', PROXY_URL);
        args.push('-o', outputPath, url);
        execFile('curl', args, { timeout: (timeoutSec+10)*1000 }, (err) => {
            if (err) return reject(new Error(err.message.slice(0,200))); resolve();
        });
    });
}

// ── DOWNLOAD VIDEO 1080p ─────────────────────────────────────
const downloadVideo = async (url, outputPath, quality = '1080') => {
    const t0 = Date.now();
    console.log(`${ts()} ▶ downloadVideo (${quality}p)`);
    if (fs.existsSync(outputPath)) try { fs.unlinkSync(outputPath); } catch(e) {}

    const qualityMap = {
        '1080': 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best',
        '720':  'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]/best',
        '480':  'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best[height<=480]/best',
    };
    const fmt = qualityMap[quality] || qualityMap['1080'];
    const strategies = [{ label: `${quality}p`, format: fmt }, { label: 'best', format: 'bestvideo+bestaudio/best' }];
    let lastError = null, proxyRequired = false;

    for (const strat of strategies) {
        if (fs.existsSync(outputPath)) try { fs.unlinkSync(outputPath); } catch(e) {}
        try {
            let cdnUrls = null, viaProxy = false;
            if (!proxyRequired) {
                try {
                    const { stdout } = await runYtDlp([...baseArgsNoProxy(), '--get-url', '-f', strat.format, '--no-playlist', url], { timeout: 30000 });
                    const urls = stdout.split('\n').filter(u => u.startsWith('http'));
                    if (urls.length > 0) { cdnUrls = urls; viaProxy = false; }
                } catch(e) { proxyRequired = true; }
            }
            if (!cdnUrls) {
                const { stdout } = await runYtDlp([...baseArgs(), '--get-url', '-f', strat.format, '--no-playlist', url], { timeout: 45000 });
                const urls = stdout.split('\n').filter(u => u.startsWith('http'));
                if (urls.length > 0) { cdnUrls = urls; viaProxy = true; }
            }
            if (!cdnUrls?.length) throw new Error('Niciun URL CDN returnat');

            if (cdnUrls.length === 1) {
                await curlDownload(cdnUrls[0], outputPath, 300, viaProxy);
            } else {
                const videoTmp = outputPath.replace(/\.mp4$/, '_vtmp.mp4');
                const audioTmp = outputPath.replace(/\.mp4$/, '_atmp.m4a');
                try {
                    await curlDownload(cdnUrls[0], videoTmp, 300, viaProxy);
                    await curlDownload(cdnUrls[1], audioTmp, 120, viaProxy);
                    await new Promise((res,rej) => execFile('ffmpeg', ['-i', videoTmp, '-i', audioTmp, '-c', 'copy', '-y', outputPath], { timeout: 120000 }, err => err ? rej(new Error('ffmpeg: '+err.message.slice(0,100))) : res()));
                } finally {
                    [videoTmp, audioTmp].forEach(f => { if(fs.existsSync(f)) try{fs.unlinkSync(f);}catch(e){} });
                }
            }
            if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 50*1024) throw new Error('Fișier video invalid');
            console.log(`${ts()} ✅ Video OK: ${(fs.statSync(outputPath).size/1024/1024).toFixed(2)}MB | ${elapsed(t0)}`);
            return;
        } catch(err) {
            lastError = err;
            if (strat === strategies[strategies.length-1]) {
                try {
                    await runYtDlp([...baseArgs(), '-f', fmt, '--merge-output-format', 'mp4', '--concurrent-fragments', '4', '-o', outputPath, url], { timeout: 600000 });
                    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 50*1024) return;
                } catch(fbErr) {}
            }
        }
    }
    throw new Error(lastError?.message || 'Nu am putut descărca videoul.');
};

// ── TRANSCRIERE + TRADUCERE ───────────────────────────────────
const getTranscriptAndTranslation = async (url, videoId, limba = 'română') => {
    const t0 = Date.now();
    let originalText = '';
    const audioPath = path.join(DOWNLOAD_DIR, `audio_${videoId}.mp3`);
    try {
        // Subtitrări native
        try {
            await runYtDlp([...baseArgs(), '--write-auto-subs', '--sub-langs', 'ro,en', '--sub-format', 'vtt', '--skip-download', '-o', path.join(DOWNLOAD_DIR, `sub_${videoId}.%(ext)s`), url], { timeout: 30000 });
            const subFile = ['ro','en'].map(l => path.join(DOWNLOAD_DIR, `sub_${videoId}.${l}.vtt`)).find(f => fs.existsSync(f));
            if (subFile) {
                const raw = fs.readFileSync(subFile, 'utf8');
                const clean = raw.replace(/WEBVTT[\s\S]*?\n\n/,'').replace(/\d{2}:\d{2}:\d{2}\.\d{3} --> [\s\S]*?\n/g,'').replace(/<[^>]+>/g,'').replace(/\n{2,}/g,' ').trim();
                try { fs.unlinkSync(subFile); } catch(e) {}
                if (clean.length > 50) { originalText = clean; }
            }
        } catch(e) {}

        // Whisper fallback
        if (!originalText) {
            try {
                const { stdout } = await runYtDlp([...baseArgs(), '--get-url', '-f', 'ba/bestaudio/best', '--no-playlist', url], { timeout: 45000 });
                const audioUrl = stdout.split('\n').find(u => u.startsWith('http'));
                if (audioUrl) {
                    const tempRaw = audioPath + '.tmp';
                    await curlDownload(audioUrl, tempRaw, 120, true);
                    await new Promise((res,rej) => execFile('ffmpeg', ['-i', tempRaw, '-vn', '-acodec', 'libmp3lame', '-q:a', '0', '-y', audioPath], { timeout: 120000 }, err => err ? rej(err) : res()));
                    try { fs.unlinkSync(tempRaw); } catch(e) {}
                }
            } catch(e) {
                await runYtDlp([...baseArgs(), '-f', 'ba/bestaudio/best', '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0', '-o', audioPath, url], { timeout: 300000 }).catch(()=>{});
            }
            if (fs.existsSync(audioPath) && fs.statSync(audioPath).size > 1000) {
                const tr = await openai.audio.transcriptions.create({ file: fs.createReadStream(audioPath), model: 'whisper-1' });
                originalText = tr.text;
            }
        }
    } catch(err) {
        console.error(`${ts()} ❌ Transcriere fail: ${err.message}`);
        return { original: '', translated: '' };
    } finally {
        if (fs.existsSync(audioPath)) try { fs.unlinkSync(audioPath); } catch(e) {}
    }

    if (!originalText) return { original: '', translated: '' };

    try {
        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: `Ești un traducător profesionist. Traduce textul primit perfect, natural și cursiv în ${limba}. Dacă e deja în ${limba}, returnează-l exact. Returnează DOAR textul tradus.` },
                { role: 'user', content: originalText.substring(0, 10000) }
            ],
        });
        return { original: originalText, translated: completion.choices[0].message.content };
    } catch(e) {
        return { original: originalText, translated: originalText };
    }
};

// ── AI33 HELPERS ─────────────────────────────────────────────
function downloadVoiceFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (response) => {
            if (response.statusCode === 301 || response.statusCode === 302) { file.close(); return downloadVoiceFile(response.headers.location, dest).then(resolve).catch(reject); }
            response.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
        }).on('error', (err) => { fs.unlink(dest, ()=>{}); reject(err); });
    });
}

async function pollAI33Task(taskId, maxWait = 60000) {
    const interval = 3000, maxAttempts = Math.floor(maxWait / interval);
    for (let i = 0; i < maxAttempts; i++) {
        await new Promise(r => setTimeout(r, interval));
        let resp;
        try { resp = await fetch(`${AI33_BASE_URL}/v1/task/${taskId}`, { headers: { 'xi-api-key': AI33_API_KEY }, signal: AbortSignal.timeout(10000) }); }
        catch(e) { continue; }
        if (resp.status === 503 || resp.status === 502) continue;
        if (!resp.ok) throw new Error(`Polling fail: ${resp.status}`);
        const task = await resp.json();
        if (task.status === 'done') {
            const audioUrl = task.metadata?.audio_url || task.output_uri || task.metadata?.output_uri;
            if (!audioUrl) throw new Error('Task done fără URL.');
            return audioUrl;
        }
        if (task.status === 'error' || task.status === 'failed') throw new Error(task.error_message || 'Eroare AI33.');
    }
    throw new Error('Timeout: 60s depășit.');
}

// ══════════════════════════════════════════════════════════════
// ██ ROUTES AUTH
// ══════════════════════════════════════════════════════════════
app.post('/api/auth/google', async (req, res) => {
    try {
        const r = await fetch(`${process.env.HUB_URL}/api/auth/google`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body) });
        res.status(r.status).json(await r.json());
    } catch(e) { res.status(500).json({ error: 'Nu pot comunica cu HUB.' }); }
});
app.get('/api/auth/me', authenticate, (req, res) => res.json({ user: req.user }));

// ══════════════════════════════════════════════════════════════
// ██ /api/process-yt — PIPELINE COMPLET (2 credite + voice chars)
// ══════════════════════════════════════════════════════════════
app.post('/api/process-yt', authenticate, async (req, res) => {
    const t0 = Date.now();
    const { url, quality = '1080', limba = 'română' } = req.body;
    if (!url) return res.status(400).json({ error: 'URL lipsă' });

    const parsed = sanitizeYouTubeUrl(url);
    if (!parsed) return res.status(400).json({ error: 'Link YouTube invalid.' });

    const { cleanUrl, videoId } = parsed;
    const outputPath = path.join(DOWNLOAD_DIR, `${videoId}_${quality}.mp4`);
    console.log(`\n${ts()} ══ /api/process-yt | ${videoId} | ${quality}p | ${limba}`);

    let creditResult;
    try {
        const cached = await VideoCache.findOne({ videoId }).catch(() => null);
        if (cached && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 100*1024) {
            const balance = await hubAPI.checkCredits(req.userId);
            return res.json({ status:'ok', downloadUrl:`/download/${path.basename(outputPath)}`, originalText: cached.originalText, translatedText: cached.translatedText, creditsLeft: balance.credits, voice_characters: balance.voice_characters });
        }

        try { creditResult = await hubAPI.useCredits(req.userId, 2); }
        catch(e) { return res.status(403).json({ error: 'Credite insuficiente. Ai nevoie de 2 credite pentru pipeline complet.' }); }

        const [aiData] = await Promise.all([
            getTranscriptAndTranslation(cleanUrl, videoId, limba),
            downloadVideo(cleanUrl, outputPath, quality),
        ]);

        await VideoCache.create({ videoId, originalText: aiData.original, translatedText: aiData.translated }).catch(() => {});
        console.log(`${ts()} ✅ TOTAL: ${elapsed(t0)}`);

        res.json({ status: 'ok', downloadUrl: `/download/${path.basename(outputPath)}`, originalText: aiData.original, translatedText: aiData.translated, creditsLeft: creditResult.credits, voice_characters: creditResult.voice_characters });

    } catch(e) {
        console.error(`${ts()} ❌ FAIL [${videoId}]: ${e.message.slice(0,300)}`);
        if (fs.existsSync(outputPath)) try { fs.unlinkSync(outputPath); } catch(e2) {}
        if (creditResult) {
            try {
                const r = await fetch(`${process.env.HUB_URL}/api/internal/refund-credits`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-key': process.env.INTERNAL_API_KEY }, body: JSON.stringify({ userId: req.userId, amount: 2 }) });
                if (r.ok) { const rd = await r.json(); console.log(`${ts()} 🔄 Refund 2 credite → ${rd.credits}`); }
            } catch(refErr) {}
        }
        res.status(500).json({ error: 'Serverul nu a putut procesa videoul. Încearcă alt link.' });
    }
});

// ══════════════════════════════════════════════════════════════
// ██ /api/transcribe — Whisper pe fișier uploadat
// ══════════════════════════════════════════════════════════════
app.post('/api/transcribe', authenticate, uploadTmp.single('audio'), async (req, res) => {
    const tmpPath = req.file?.path;
    try {
        if (!req.file) return res.status(400).json({ error: 'Fișier audio lipsă.' });
        const mp3Path = tmpPath + '.mp3';
        fs.renameSync(tmpPath, mp3Path);
        const tr = await openai.audio.transcriptions.create({ file: fs.createReadStream(mp3Path), model: 'whisper-1' });
        try { fs.unlinkSync(mp3Path); } catch(e) {}
        res.json({ transcript: tr.text });
    } catch(e) {
        if (tmpPath && fs.existsSync(tmpPath)) try { fs.unlinkSync(tmpPath); } catch(_) {}
        res.status(500).json({ error: 'Eroare transcriere: ' + e.message });
    }
});

// ══════════════════════════════════════════════════════════════
// ██ /api/translate — traducere GPT
// ══════════════════════════════════════════════════════════════
app.post('/api/translate', authenticate, async (req, res) => {
    try {
        const { text, limba = 'română' } = req.body;
        if (!text) return res.status(400).json({ error: 'Text lipsă.' });
        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: `Ești un traducător profesionist. Traduce textul primit în ${limba}. Returnează DOAR textul tradus.` },
                { role: 'user', content: text.substring(0, 10000) }
            ],
        });
        res.json({ translated: completion.choices[0].message.content });
    } catch(e) { res.status(500).json({ error: 'Eroare traducere: ' + e.message }); }
});

// ══════════════════════════════════════════════════════════════
// ██ /api/generate — Voice Generation AI33
// ══════════════════════════════════════════════════════════════
app.post('/api/generate', authenticate, async (req, res) => {
    try {
        const { text, voiceId, voice, stability, similarity_boost, speed } = req.body;
        if (!text) return res.status(400).json({ error: 'Text lipsă.' });

        const cost = text.replace(/\s+/g, '').length;
        const balance = await hubAPI.checkCredits(req.userId);
        if ((balance.voice_characters || 0) < cost) return res.status(403).json({ error: `Caractere insuficiente. Ai nevoie de ${cost}.` });

        const resolvedVoiceId = voiceId || 'nPczCjzI2devNBz1zQrb';

        // FIX #4 server-side: clamp speed la 0.70–1.20 conform API
        const clampedSpeed = Math.min(1.20, Math.max(0.70, parseFloat(speed) || 1.0));

        let ai33Resp;
        try {
            ai33Resp = await fetch(`${AI33_BASE_URL}/v1/text-to-speech/${resolvedVoiceId}?output_format=mp3_44100_128`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'xi-api-key': AI33_API_KEY },
                body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: parseFloat(stability)||0.5, similarity_boost: parseFloat(similarity_boost)||0.75, speed: clampedSpeed }, with_transcript: false }),
                signal: AbortSignal.timeout(15000),
            });
        } catch(fetchErr) {
            if (fetchErr.name === 'TimeoutError' || fetchErr.name === 'AbortError') return res.status(503).json({ error: 'Serverul de voce nu răspunde.' });
            throw fetchErr;
        }

        if (!ai33Resp.ok) {
            if (ai33Resp.status === 429) return res.status(429).json({ error: 'Suprasolicitat. Așteaptă câteva secunde.' });
            throw new Error(`AI33 eroare ${ai33Resp.status}`);
        }

        const ai33Data = await ai33Resp.json();
        if (!ai33Data.success || !ai33Data.task_id) throw new Error('AI33 nu a returnat task_id.');

        const outputUrl = await pollAI33Task(ai33Data.task_id);
        const fileName = `voice_${Date.now()}.mp3`;
        await downloadVoiceFile(outputUrl, path.join(DOWNLOAD_DIR, fileName));

        try { await hubAPI.useVoiceChars(req.userId, cost); } catch(e) {}

        res.json({ audioUrl: `/download/${fileName}`, remaining_chars: (balance.voice_characters||0) - cost });

    } catch(error) {
        res.status(500).json({ error: error.message || 'Eroare la generarea vocii.' });
    }
});

// ══════════════════════════════════════════════════════════════
// ██ /api/smart-cut — silence remove (0.5 credite)
// ══════════════════════════════════════════════════════════════
app.post('/api/smart-cut', authenticate, uploadTmp.single('file'), async (req, res) => {
    try {
        const balance = await hubAPI.checkCredits(req.userId);
        if (balance.credits < 0.5) { if (req.file) try{fs.unlinkSync(req.file.path);}catch(e){} return res.status(403).json({ error: 'Cost: 0.5 Credite. Fonduri insuficiente.' }); }
        if (!req.file) return res.status(400).json({ error: 'Fișier lipsă.' });
        const inputFile = req.file.path;
        const outputFile = path.join(PROCESSED_DIR, `cut_${Date.now()}.mp3`);
        const threshold = req.body.threshold || '-45dB';
        const minSilence = req.body.minSilence || '0.35';
        const af = `silenceremove=start_periods=1:start_duration=0.1:start_threshold=${threshold}:stop_periods=-1:stop_duration=${minSilence}:stop_threshold=${threshold}`;
        exec(`ffmpeg -y -i "${inputFile}" -af "${af}" "${outputFile}"`, async (error) => {
            if (fs.existsSync(inputFile)) try{fs.unlinkSync(inputFile);}catch(e){}
            if (error) return res.status(500).json({ error: 'Eroare procesare audio.' });
            try { const r = await hubAPI.useCredits(req.userId, 0.5); res.json({ status:'ok', downloadUrl:`/download/${path.basename(outputFile)}`, creditsLeft: r.credits }); }
            catch(e) { res.json({ status:'ok', downloadUrl:`/download/${path.basename(outputFile)}`, creditsLeft:0 }); }
        });
    } catch(e) {
        if (req.file && fs.existsSync(req.file.path)) try{fs.unlinkSync(req.file.path);}catch(e2){}
        res.status(500).json({ error: e.message });
    }
});

// ── DOWNLOAD FILE ─────────────────────────────────────────────
app.get('/download/:filename', (req, res) => {
    const filename = path.basename(req.params.filename);
    for (const dir of [DOWNLOAD_DIR, PROCESSED_DIR]) {
        const fp = path.resolve(dir, filename);
        if (fp.startsWith(dir) && fs.existsSync(fp)) return res.download(fp);
    }
    res.status(404).send('Fișierul nu mai există sau a expirat.');
});

// ── CURĂȚARE 24h ─────────────────────────────────────────────
setInterval(() => {
    const now = Date.now(), exts = ['.mp4','.mp3','.tmp','.m4a','.vtt'];
    for (const dir of [DOWNLOAD_DIR, PROCESSED_DIR]) {
        try { fs.readdirSync(dir).forEach(file => { if (exts.some(e=>file.endsWith(e))) { const fp=path.join(dir,file); try{if(now-fs.statSync(fp).mtimeMs>86400000)fs.unlinkSync(fp);}catch(e){} } }); } catch(e) {}
    }
}, 3600000);

app.listen(PORT, () => {
    console.log(`\n🚀 Viralio Pipeline · port ${PORT}`);
    console.log(`   ✅ /api/process-yt  — YT 1080p + Transcriere (2 credite)`);
    console.log(`   ✅ /api/generate    — Voice Generation (voice_characters)`);
    console.log(`   ✅ /api/smart-cut   — Smart Cut (0.5 credite)`);
    console.log(`   ✅ /api/transcribe  — Whisper upload`);
    console.log(`   ✅ /api/translate   — Traducere GPT\n`);
    console.log(`   📁 Static files     — servite din: ${__dirname}`);
});