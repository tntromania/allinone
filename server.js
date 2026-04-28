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

const REQUIRED_ENV = ['OPENAI_API_KEY', 'HUB_URL', 'INTERNAL_API_KEY', 'DUBVOICE_API_KEY', 'PROXY_URL'];
for (const key of REQUIRED_ENV) {
    if (!process.env[key]) { console.error(`❌ Variabila de mediu lipsă: ${key}`); process.exit(1); }
}

const app = express();
const PORT = process.env.PORT || 3000;
process.on('unhandledRejection', (reason) => { console.error('⚠️ Unhandled Rejection:', reason?.message || reason); });
app.set('trust proxy', 1);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const DUBVOICE_API_KEY = process.env.DUBVOICE_API_KEY;
const VOICE_API_BASE = 'https://www.dubvoice.ai';
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

function sanitizeVideoUrl(rawUrl) {
    const url = (rawUrl || '').trim();

    // ── YouTube ──────────────────────────────────────────────
    const yt = url.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/);
    if (yt) return { cleanUrl: `https://www.youtube.com/watch?v=${yt[1]}`, videoId: yt[1], platform: 'youtube' };

    // ── TikTok ───────────────────────────────────────────────
    const tt = url.match(/tiktok\.com\/@[^/]+\/video\/(\d+)/);
    if (tt) return { cleanUrl: url, videoId: `tt_${tt[1]}`, platform: 'tiktok' };
    const ttShort = url.match(/(?:vm|vt)\.tiktok\.com\/([A-Za-z0-9]+)/);
    if (ttShort) return { cleanUrl: url, videoId: `tt_${ttShort[1]}`, platform: 'tiktok' };

    // ── Instagram ────────────────────────────────────────────
    const ig = url.match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
    if (ig) return { cleanUrl: url, videoId: `ig_${ig[1]}`, platform: 'instagram' };

    // ── Facebook ─────────────────────────────────────────────
    const fb = url.match(/facebook\.com\/(?:watch\/?\?v=|[^/]+\/videos\/)(\d+)/);
    if (fb) return { cleanUrl: url, videoId: `fb_${fb[1]}`, platform: 'facebook' };
    const fbShort = url.match(/fb\.watch\/([A-Za-z0-9_-]+)/);
    if (fbShort) return { cleanUrl: url, videoId: `fb_${fbShort[1]}`, platform: 'facebook' };

    // ── Generic fallback (orice URL HTTPS valid suportat de yt-dlp) ──
    try {
        const parsed = new URL(url);
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
            const id = 'gen_' + Buffer.from(url).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
            return { cleanUrl: url, videoId: id, platform: 'generic' };
        }
    } catch (_) {}

    return null;
}
// Alias pentru compatibilitate cu orice import extern
const sanitizeYouTubeUrl = sanitizeVideoUrl;

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
// Platforme care nu suportă descărcare directă CDN — trebuie yt-dlp nativ
const NON_YT_PLATFORMS = /tiktok\.com|instagram\.com|facebook\.com|fb\.watch|twitter\.com|x\.com|vm\.tiktok|vt\.tiktok/;

const downloadVideo = async (url, outputPath, quality = '720') => {
    const t0 = Date.now();
    const isNonYT = NON_YT_PLATFORMS.test(url);
    console.log(`${ts()} ▶ downloadVideo (${quality}p) | non-yt=${isNonYT}`);
    if (fs.existsSync(outputPath)) try { fs.unlinkSync(outputPath); } catch(e) {}

    const qualityMap = {
        '1080': 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best',
        '720':  'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]/best',
        '480':  'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best[height<=480]/best',
    };
    const fmt = qualityMap[quality] || qualityMap['720'];

    // ── Platforme non-YouTube: yt-dlp direct (fără CDN URL redirect) ──
    if (isNonYT) {
        const directStrategies = [
            { label: `${quality}p`, format: fmt },
            { label: 'best-mp4', format: 'bestvideo[ext=mp4]+bestaudio/best[ext=mp4]/best' },
            { label: 'best', format: 'best' },
        ];
        let lastErr = null;
        for (const strat of directStrategies) {
            if (fs.existsSync(outputPath)) try { fs.unlinkSync(outputPath); } catch(e) {}
            try {
                await runYtDlp([
                    ...baseArgs(),
                    '-f', strat.format,
                    '--merge-output-format', 'mp4',
                    '--concurrent-fragments', '4',
                    '--no-playlist',
                    '-o', outputPath,
                    url,
                ], { timeout: 300000 });
                if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 50*1024) {
                    console.log(`${ts()} ✅ Video OK [${strat.label}]: ${(fs.statSync(outputPath).size/1024/1024).toFixed(2)}MB | ${elapsed(t0)}`);
                    return;
                }
                lastErr = new Error(`Fișier prea mic după strategie "${strat.label}"`);
            } catch(e) {
                lastErr = e;
                console.warn(`${ts()} ⚠️ Strategie "${strat.label}" eșuată: ${e.message.slice(0, 120)}`);
            }
        }
        throw new Error(lastErr?.message || 'Nu am putut descărca videoul.');
    }

    // ── YouTube: strategie CDN URL (mai rapidă) ──────────────────────
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
const getTranscriptAndTranslation = async (url, videoId, limba = 'română', existingVideoPath = null) => {
    const t0 = Date.now();
    let originalText = '';
    const isNonYT = NON_YT_PLATFORMS.test(url);
    const audioPath = path.join(DOWNLOAD_DIR, `audio_${videoId}.mp3`);

    // Funcție internă: descarcă audio cu yt-dlp direct (fără CDN URL)
    // Folosit doar ca fallback final dacă nu există video local
    async function downloadAudioDirect() {
        if (fs.existsSync(audioPath)) try { fs.unlinkSync(audioPath); } catch(e) {}
        await runYtDlp([
            ...baseArgs(),
            '-f', 'ba/bestaudio/best',
            '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '5',
            '--no-playlist',
            '-o', audioPath, url
        ], { timeout: 300000 });
    }

    // Funcție internă: extrage audio din videoul deja descărcat (ffmpeg, GRATIS · fără proxy)
    // 64k mono = ~30MB/oră, perfect pentru Whisper (speech), sub limita de 25MB până la ~60 min
    async function extractAudioFromVideo(videoPath) {
        if (fs.existsSync(audioPath)) try { fs.unlinkSync(audioPath); } catch(e) {}
        console.log(`${ts()} 🎬 Extrag audio din video existent (${(fs.statSync(videoPath).size/1024/1024).toFixed(2)}MB) → mp3 64k mono...`);
        await new Promise((res, rej) => execFile('ffmpeg', [
            '-i', videoPath, '-vn',
            '-ac', '1',                 // mono (suficient pentru speech)
            '-ar', '16000',             // 16kHz (nativ pentru Whisper)
            '-acodec', 'libmp3lame', '-b:a', '64k',
            '-y', audioPath
        ], { timeout: 120000 }, err => err ? rej(new Error('ffmpeg extract: ' + err.message.slice(0, 100))) : res()));
    }

    try {
        // ── 1. Subtitrări native ──────────────────────────────────
        // Luăm TOATE limbile: subs sunt ~50KB/fișier (neglijabil vs video 50MB),
        // iar dacă găsim subs în limba originală (Hindi, Coreeană etc.) evităm Whisper = economie reală.
        try {
            await runYtDlp([...baseArgs(), '--write-auto-subs', '--write-subs', '--sub-langs', 'all', '--sub-format', 'vtt', '--skip-download', '-o', path.join(DOWNLOAD_DIR, `sub_${videoId}.%(ext)s`), url], { timeout: 30000 });
            const subDir = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith(`sub_${videoId}`) && f.endsWith('.vtt'));
            // Preferință: ro > en > orice altă limbă (va fi tradusă oricum de GPT)
            const preferred = subDir.find(f => /\.ro\.vtt$/.test(f))
                           || subDir.find(f => /\.en\.vtt$/.test(f))
                           || subDir[0];
            if (preferred) {
                const subFile = path.join(DOWNLOAD_DIR, preferred);
                const raw = fs.readFileSync(subFile, 'utf8');
                const clean = raw.replace(/WEBVTT[\s\S]*?\n\n/,'').replace(/\d{2}:\d{2}:\d{2}\.\d{3} --> [\s\S]*?\n/g,'').replace(/<[^>]+>/g,'').replace(/\n{2,}/g,' ').trim();
                subDir.forEach(f => { try { fs.unlinkSync(path.join(DOWNLOAD_DIR, f)); } catch(e) {} });
                if (clean.length > 50) { originalText = clean; console.log(`${ts()} 📝 Subtitrări native găsite (${originalText.length} chars)`); }
            }
        } catch(e) { console.log(`${ts()} ℹ️ Fără subtitrări native: ${e.message.slice(0,80)}`); }

        // ── 2. Whisper fallback ───────────────────────────────────
        if (!originalText) {
            console.log(`${ts()} 🎙 Whisper fallback | non-yt=${isNonYT} | hasLocalVideo=${!!existingVideoPath}`);
            try {
                // PRIORITATE MAXIMĂ: dacă avem deja videoul local, extragem audio din el (fără proxy!)
                // Se aplică la TOATE platformele (YouTube, TikTok, IG, FB) dacă video-ul e deja pe disc
                if (existingVideoPath && fs.existsSync(existingVideoPath) && fs.statSync(existingVideoPath).size > 50*1024) {
                    await extractAudioFromVideo(existingVideoPath);
                } else if (isNonYT) {
                    // Non-YT fără video local: trebuie yt-dlp (rar se întâmplă)
                    await downloadAudioDirect();
                } else {
                    // YouTube fără video local (nu ar trebui să se întâmple în noul pipeline)
                    // Fallback: CDN URL rapid pentru audio
                    try {
                        const { stdout } = await runYtDlp([...baseArgs(), '--get-url', '-f', 'ba/bestaudio/best', '--no-playlist', url], { timeout: 45000 });
                        const audioUrl = stdout.split('\n').find(u => u.startsWith('http'));
                        if (!audioUrl) throw new Error('No CDN URL');
                        const tempRaw = audioPath + '.tmp';
                        await curlDownload(audioUrl, tempRaw, 120, true);
                        await new Promise((res,rej) => execFile('ffmpeg', [
                            '-i', tempRaw, '-vn', '-ac', '1', '-ar', '16000',
                            '-acodec', 'libmp3lame', '-b:a', '64k', '-y', audioPath
                        ], { timeout: 120000 }, err => err ? rej(err) : res()));
                        try { fs.unlinkSync(tempRaw); } catch(e) {}
                    } catch(e) {
                        console.log(`${ts()} ⚠️ CDN audio fail, fallback direct: ${e.message.slice(0,60)}`);
                        await downloadAudioDirect();
                    }
                }

                if (fs.existsSync(audioPath) && fs.statSync(audioPath).size > 1000) {
                    const sizeKB = fs.statSync(audioPath).size/1024;
                    // Safety check: Whisper acceptă max 25MB. Skip dacă e prea mare.
                    if (sizeKB > 25000) {
                        console.warn(`${ts()} ⚠️ Audio prea mare pentru Whisper (${sizeKB.toFixed(0)}KB > 25MB). Skip.`);
                        return { original: '', translated: '' };
                    }
                    console.log(`${ts()} 🎙 Whisper pe ${sizeKB.toFixed(0)}KB audio...`);
                    // Retry Whisper doar de 2 ori (era 3) — reduce cost în caz de eroare transitorie
                    let tr, whisperAttempt = 0;
                    while (whisperAttempt < 2) {
                        try {
                            tr = await openai.audio.transcriptions.create({ file: fs.createReadStream(audioPath), model: 'whisper-1' });
                            break;
                        } catch(wErr) {
                            whisperAttempt++;
                            if (whisperAttempt >= 2) throw wErr;
                            console.warn(`${ts()} ⚠️ Whisper retry ${whisperAttempt}/2: ${wErr.message.slice(0,80)}`);
                            await new Promise(r => setTimeout(r, 2000 * whisperAttempt));
                        }
                    }
                    originalText = tr.text;
                    console.log(`${ts()} 📝 Whisper OK: ${originalText.length} chars`);
                } else {
                    console.warn(`${ts()} ⚠️ Audio fie lipsă fie prea mic după extracție`);
                }
            } catch(e) {
                console.error(`${ts()} ❌ Whisper fail: ${e.message.slice(0,200)}`);
            }
        }
    } catch(err) {
        console.error(`${ts()} ❌ Transcriere fail: ${err.message}`);
    } finally {
        if (fs.existsSync(audioPath)) try { fs.unlinkSync(audioPath); } catch(e) {}
    }

    if (!originalText) {
        console.warn(`${ts()} ⚠️ Transcriere goală pentru ${videoId}`);
        return { original: '', translated: '' };
    }

    // ── 3. Traducere ─────────────────────────────────────────────
    try {
        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: `Ești un traducător profesionist. Traduce textul primit perfect, natural și cursiv în ${limba}. Dacă e deja în ${limba}, returnează-l exact. Returnează DOAR textul tradus.` },
                { role: 'user', content: originalText.substring(0, 10000) }
            ],
        });
        const translated = completion.choices[0].message.content;
        console.log(`${ts()} 🌐 Traducere OK: ${translated.length} chars`);
        return { original: originalText, translated };
    } catch(e) {
        console.warn(`${ts()} ⚠️ Traducere fail, folosesc originalul: ${e.message}`);
        return { original: originalText, translated: originalText };
    }
};

// ── VOICE API HELPERS ───────────────────────────────────────
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

async function pollVoiceTask(taskId) {
    const interval = 3000;
    while (true) {
        await new Promise(r => setTimeout(r, interval));
        let resp;
        try { resp = await fetch(`${VOICE_API_BASE}/api/v1/tts/${taskId}`, { headers: { 'Authorization': `Bearer ${DUBVOICE_API_KEY}` }, signal: AbortSignal.timeout(10000) }); }
        catch(e) { continue; }
        if (resp.status === 503 || resp.status === 502) continue;
        if (!resp.ok) throw new Error(`Polling fail: ${resp.status}`);
        const task = await resp.json();
        if (task.status === 'completed') {
            const audioUrl = task.result;
            if (!audioUrl) throw new Error('Task finalizat fără URL audio.');
            return audioUrl;
        }
        if (task.status === 'failed' || task.status === 'error') throw new Error(task.error || 'Eroare la procesarea vocii.');
    }
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
// ██ JOB QUEUE — async processing cu polling
// ══════════════════════════════════════════════════════════════
const jobs = new Map(); // jobId → { status, progress, data, error, userId, createdAt }

function newJob(userId) {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    jobs.set(jobId, { status: 'pending', progress: 'Se inițializează...', data: null, error: null, userId, createdAt: Date.now() });
    return jobId;
}
function setJobProgress(jobId, progress) {
    const j = jobs.get(jobId); if (j) { j.progress = progress; j.status = 'running'; }
}
function setJobDone(jobId, data) {
    const j = jobs.get(jobId); if (j) { j.status = 'done'; j.data = data; }
}
function setJobError(jobId, error) {
    const j = jobs.get(jobId); if (j) { j.status = 'error'; j.error = error; }
}

// Curăță job-uri vechi (>2h)
setInterval(() => {
    const cutoff = Date.now() - 2 * 3600000;
    for (const [id, job] of jobs) { if (job.createdAt < cutoff) jobs.delete(id); }
}, 600000);

// GET /api/job/:id — polling endpoint
app.get('/api/job/:jobId', authenticate, (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job negăsit sau expirat.' });
    if (job.userId !== req.userId) return res.status(403).json({ error: 'Acces interzis.' });
    res.json({ status: job.status, progress: job.progress, data: job.data, error: job.error });
});

// ══════════════════════════════════════════════════════════════
// ██ /api/process-yt — PIPELINE COMPLET (2 credite + voice chars)
// Răspunde imediat cu jobId, procesează în background
// ══════════════════════════════════════════════════════════════
app.post('/api/process-yt', authenticate, async (req, res) => {
    const { url, quality = '720', limba = 'română' } = req.body;
    if (!url) return res.status(400).json({ error: 'URL lipsă' });

    const parsed = sanitizeVideoUrl(url);
    if (!parsed) return res.status(400).json({ error: 'Link invalid. Suportăm YouTube, TikTok, Instagram, Facebook și alte platforme.' });

    const { cleanUrl, videoId, platform } = parsed;
    const outputPath = path.join(DOWNLOAD_DIR, `${videoId}_${quality}.mp4`);
    console.log(`\n${ts()} ══ /api/process-yt | ${platform} | ${videoId} | ${quality}p | ${limba}`);

    // Verifică cache înainte să creeze job (răspuns instant)
    try {
        const cached = await VideoCache.findOne({ videoId }).catch(() => null);
        if (cached && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 100*1024) {
            const balance = await hubAPI.checkCredits(req.userId);
            return res.json({ status: 'done', cached: true, data: { downloadUrl: `/download/${path.basename(outputPath)}`, originalText: cached.originalText, translatedText: cached.translatedText, creditsLeft: balance.credits, voice_characters: balance.voice_characters } });
        }
    } catch(e) {}

    // Creează job și răspunde imediat
    const jobId = newJob(req.userId);
    res.json({ status: 'queued', jobId });

    // ── Funcție robustă de refund (încearcă de 3 ori) ──────────
    async function refundCredits(userId, amount) {
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const controller = new AbortController();
                const tid = setTimeout(() => controller.abort(), 8000);
                let r;
                try {
                    r = await fetch(`${process.env.HUB_URL}/api/internal/refund-credits`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'x-internal-key': process.env.INTERNAL_API_KEY },
                        body: JSON.stringify({ userId, amount }),
                        signal: controller.signal,
                    });
                } finally { clearTimeout(tid); }

                const rawText = await r.text();
                if (r.ok) {
                    try {
                        const rd = JSON.parse(rawText);
                        console.log(`${ts()} 🔄 Refund ${amount} credite (attempt ${attempt}) → ${rd.credits}`);
                        return true;
                    } catch(_) {
                        console.log(`${ts()} 🔄 Refund OK (attempt ${attempt}), răspuns non-JSON: ${rawText.slice(0, 80)}`);
                        return true; // r.ok = succes chiar dacă nu e JSON valid
                    }
                }
                console.warn(`${ts()} ⚠️ Refund attempt ${attempt} failed: HTTP ${r.status} — ${rawText.slice(0, 150)}`);
            } catch (refErr) {
                console.warn(`${ts()} ⚠️ Refund attempt ${attempt} error: ${refErr.message}`);
            }
            if (attempt < 3) await new Promise(r => setTimeout(r, 1500 * attempt));
        }
        console.error(`${ts()} ❌ Refund EȘUAT userId=${userId} amount=${amount}. Verifică HUB_URL și INTERNAL_API_KEY.`);
        return false;
    }

    // Procesează în background (fără await)
    (async () => {
        const t0 = Date.now();
        let creditResult = null;
        try {
            setJobProgress(jobId, 'Se verifică creditele...');
            try { creditResult = await hubAPI.useCredits(req.userId, 2); }
            catch(e) { return setJobError(jobId, 'Credite insuficiente. Ai nevoie de 2 credite pentru pipeline complet.'); }

            setJobProgress(jobId, `Se descarcă video ${quality}p și se extrage transcrierea...`);

            let aiData;
            if (platform !== 'youtube') {
                // Non-YT (TikTok/IG/FB): video primul, apoi transcriere din el
                setJobProgress(jobId, `Se descarcă video ${quality}p...`);
                await downloadVideo(cleanUrl, outputPath, quality);
                setJobProgress(jobId, 'Se transcrie audio...');
                aiData = await getTranscriptAndTranslation(cleanUrl, videoId, limba, outputPath);
            } else {
                // YouTube: video + subtitrări în paralel (subs sunt light, video greu)
                // Dacă subs lipsesc, Whisper extrage din video-ul local (zero trafic extra prin proxy)
                setJobProgress(jobId, `Se descarcă video ${quality}p + subtitrări...`);
                const [result] = await Promise.all([
                    getTranscriptAndTranslation(cleanUrl, videoId, limba, outputPath /* va fi gata la nevoie */),
                    downloadVideo(cleanUrl, outputPath, quality),
                ]);
                aiData = result;
                // Edge case: dacă subs au lipsit și Whisper a rulat înainte ca video să fie gata,
                // Whisper folosește audio CDN. Dacă video era gata, folosește audio local.
                // În ambele cazuri NU se mai face al 2-lea download audio prin proxy dublat.
            }

            setJobProgress(jobId, 'Se finalizează...');
            await VideoCache.create({ videoId, originalText: aiData.original, translatedText: aiData.translated }).catch(() => {});
            console.log(`${ts()} ✅ TOTAL: ${elapsed(t0)}`);

            setJobDone(jobId, {
                downloadUrl: `/download/${path.basename(outputPath)}`,
                originalText: aiData.original,
                translatedText: aiData.translated,
                creditsLeft: creditResult.credits,
                voice_characters: creditResult.voice_characters
            });

        } catch(e) {
            console.error(`${ts()} ❌ FAIL [${platform}/${videoId}]: ${e.message.slice(0, 300)}`);
            if (fs.existsSync(outputPath)) try { fs.unlinkSync(outputPath); } catch(e2) {}
            // ── Refund credite dacă au fost deja scăzute ──────────
            if (creditResult !== null) {
                await refundCredits(req.userId, 2);
            }
            setJobError(jobId, 'Serverul nu a putut procesa videoul. Creditele au fost returnate. Încearcă alt link.');
        }
    })();
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
// ██ /api/generate — Voice Generation (ElevenLabs + Minimax)
// ══════════════════════════════════════════════════════════════
app.post('/api/generate', authenticate, async (req, res) => {
    try {
        const {
            text, voiceId, voice, provider,
            // ElevenLabs params
            stability, similarity_boost, speed,
            // Minimax params
            minimaxVoiceId, pitch, vol, language_boost
        } = req.body;

        if (!text) return res.status(400).json({ error: 'Text lipsă.' });

        // ── Credit check ─────────────────────────────────────────
        const cost = text.replace(/\s+/g, '').length;
        const balance = await hubAPI.checkCredits(req.userId);
        if ((balance.voice_characters || 0) < cost) {
            return res.status(403).json({ error: `Caractere insuficiente. Ai nevoie de ${cost}.` });
        }

        // ── Provider detection ───────────────────────────────────
        // Prioritate: (1) câmp explicit `provider`, (2) detectare după format ID
        // Minimax IDs sunt numerice lungi (ex: "209533299589205")
        // ElevenLabs IDs sunt alfanumerice (ex: "CwhRBWXzGAHq8TQ4Fs17")
        const rawId = voiceId || minimaxVoiceId || '';
        const isMinimax = provider === 'minimax' || /^\d{10,}$/.test(rawId);

        let voiceResp, outputUrl;

        if (isMinimax) {
            // ── MINIMAX ───────────────────────────────────────────
            const mmVoiceId = minimaxVoiceId || voiceId;
            if (!mmVoiceId) return res.status(400).json({ error: 'Voice ID Minimax lipsă.' });

            const clampedSpeed = Math.min(10.0, Math.max(0.01, parseFloat(speed) || 1.0));
            const clampedPitch = Math.min(12, Math.max(-12, parseInt(pitch) || 0));
            const clampedVol = Math.min(2.0, Math.max(0.5, parseFloat(vol) || 1.0));

            console.log(`${ts()} 🎤 Generare Minimax | voice=${mmVoiceId} | speed=${clampedSpeed} | pitch=${clampedPitch} | vol=${clampedVol}`);

            try {
                voiceResp = await fetch(`${VOICE_API_BASE}/api/minimax-tts`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DUBVOICE_API_KEY}` },
                    body: JSON.stringify({
                        text: text.substring(0, 100000),
                        voice_id: mmVoiceId,
                        model: 'speech-2.6-hd',
                        language_boost: language_boost || 'Auto',
                        speed: clampedSpeed,
                        pitch: clampedPitch,
                        vol: clampedVol,
                    }),
                });
            } catch(fetchErr) { throw fetchErr; }

            if (!voiceResp.ok) {
                if (voiceResp.status === 429) return res.status(429).json({ error: 'Suprasolicitat. Așteaptă câteva secunde.' });
                let errDetail = '';
                try { errDetail = (await voiceResp.text()).slice(0, 200); } catch(_) {}
                console.error(`${ts()} ❌ Eroare generare voce (Minimax) ${voiceResp.status}: ${errDetail}`);
                throw new Error(`Eroare la generarea vocii (${voiceResp.status}).`);
            }

            const mmData = await voiceResp.json();
            if (!mmData.success || !mmData.audio_url) throw new Error('Răspuns invalid de la server.');
            outputUrl = mmData.audio_url;

        } else {
            // ── ELEVENLABS ───────────────────────────────────────
            const resolvedVoiceId = voiceId || 'nPczCjzI2devNBz1zQrb';
            const clampedSpeed = Math.min(1.20, Math.max(0.70, parseFloat(speed) || 1.0));

            console.log(`${ts()} 🎤 Generare ElevenLabs | voice=${resolvedVoiceId} | speed=${clampedSpeed}`);

            try {
                voiceResp = await fetch(`${VOICE_API_BASE}/api/v1/tts`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DUBVOICE_API_KEY}` },
                    body: JSON.stringify({
                        text,
                        voice_id: resolvedVoiceId,
                        model_id: 'eleven_multilingual_v2',
                        voice_settings: {
                            stability: parseFloat(stability) || 0.5,
                            similarity_boost: parseFloat(similarity_boost) || 0.75,
                            speed: clampedSpeed,
                            style: 0,
                            use_speaker_boost: true,
                        },
                    }),
                    signal: AbortSignal.timeout(20000),
                });
            } catch(fetchErr) {
                if (fetchErr.name === 'TimeoutError' || fetchErr.name === 'AbortError')
                    return res.status(503).json({ error: 'Serverul de voce nu răspunde.' });
                throw fetchErr;
            }

            if (!voiceResp.ok) {
                if (voiceResp.status === 429) return res.status(429).json({ error: 'Suprasolicitat. Așteaptă câteva secunde.' });
                let errDetail = '';
                try { errDetail = (await voiceResp.text()).slice(0, 200); } catch(_) {}
                console.error(`${ts()} ❌ Eroare generare voce (ElevenLabs) ${voiceResp.status}: ${errDetail}`);
                throw new Error(`Eroare la generarea vocii (${voiceResp.status}).`);
            }

            const elData = await voiceResp.json();
            if (!elData.task_id) throw new Error('Răspuns invalid de la server.');
            outputUrl = await pollVoiceTask(elData.task_id);
        }
        const fileName = `voice_${Date.now()}.mp3`;
        await downloadVoiceFile(outputUrl, path.join(DOWNLOAD_DIR, fileName));

        try { await hubAPI.useVoiceChars(req.userId, cost); } catch(e) {}

        res.json({ audioUrl: `/download/${fileName}`, remaining_chars: (balance.voice_characters||0) - cost });

    } catch(error) {
        console.error(`${ts()} ❌ /api/generate fail: ${error.message}`);
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

// ── STATIC FILES (după toate rutele API) ─────────────────────
// assets/ și index.html sunt lângă server.js — nu în /public
// Fallback la /public pentru compatibilitate dacă nu s-a mutat încă
app.use(express.static(__dirname, { index: 'index.html' }));
app.use(express.static(path.join(__dirname, 'public')));

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