require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { execFile, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const OpenAI = require('openai');
const mongoose = require('mongoose');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const { authenticate, hubAPI } = require('./hub-auth');

// ── VALIDARE ENV ────────────────────────────
const REQUIRED_ENV = ['OPENAI_API_KEY', 'HUB_URL', 'INTERNAL_API_KEY', 'AI33_API_KEY', 'PROXY_URL'];
for (const key of REQUIRED_ENV) {
    if (!process.env[key]) { console.error(`❌ Variabila de mediu lipsă: ${key}`); process.exit(1); }
}

const app = express();
const PORT = process.env.PORT || 3000;

process.on('unhandledRejection', (reason) => {
    console.error('⚠️ Unhandled Rejection:', reason?.message || reason);
});
app.set('trust proxy', 1);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const AI33_API_KEY = process.env.AI33_API_KEY;
const AI33_BASE_URL = 'https://api.ai33.pro';
const PROXY_URL = process.env.PROXY_URL;

// ── FOLDERE ─────────────────────────────────
const DOWNLOAD_DIR = path.resolve(__dirname, 'downloads');
const PROCESSED_DIR = path.resolve(__dirname, 'processed');
for (const dir of [DOWNLOAD_DIR, PROCESSED_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const YTDLP_PATH = '/usr/local/bin/yt-dlp';
const uploadTmp = multer({ dest: DOWNLOAD_DIR, limits: { fileSize: 500 * 1024 * 1024 } });

// ── SECURITATE ──────────────────────────────
app.use(helmet({ contentSecurityPolicy: false, crossOriginOpenerPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/process-yt', rateLimit({ windowMs: 60 * 1000, max: 10, message: { error: 'Maxim 10 video-uri pe minut.' } }));
app.use('/api/download',   rateLimit({ windowMs: 60 * 1000, max: 10, message: { error: 'Maxim 10 cereri pe minut.' } }));
app.use('/api/auth/google', rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Prea multe încercări.' } }));

// ── MONGO — cache YT ────────────────────────
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

// ══════════════════════════════════════════════════════════════
// ██ TIMESTAMP HELPERS
// ══════════════════════════════════════════════════════════════
function ts() { return `[${new Date().toISOString().slice(11, 23)}]`; }
function elapsed(startMs) {
    const ms = Date.now() - startMs;
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// ══════════════════════════════════════════════════════════════
// ██ YT HELPERS
// ══════════════════════════════════════════════════════════════
function sanitizeYouTubeUrl(rawUrl) {
    const url = (rawUrl || '').trim();
    const m = url.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/);
    if (m) return { cleanUrl: `https://www.youtube.com/watch?v=${m[1]}`, videoId: m[1] };
    return null;
}

function runYtDlp(args, opts = {}) {
    return new Promise((resolve, reject) => {
        execFile(YTDLP_PATH, args, { maxBuffer: 1024 * 1024 * 200, timeout: opts.timeout || 300000 }, (error, stdout, stderr) => {
            if (error) {
                const errMsg = (stderr || '').split('\n').filter(l => l.startsWith('ERROR:')).join(' ').trim() || error.message.slice(0, 300);
                reject(new Error(errMsg));
            } else {
                resolve({ stdout: stdout?.trim() || '', stderr: stderr?.trim() || '' });
            }
        });
    });
}

const COOKIES_DIR = process.env.COOKIES_DIR ? path.resolve(process.env.COOKIES_DIR) : path.resolve(__dirname, 'cookies');
function cookiesFile() {
    const f = path.join(COOKIES_DIR, 'youtube.txt');
    return fs.existsSync(f) ? f : null;
}

function baseArgs() {
    const args = ['--proxy', PROXY_URL, '--no-warnings', '--geo-bypass', '--no-cache-dir', '--retries', '5', '--fragment-retries', '5', '--no-check-certificates', '--no-playlist'];
    const c = cookiesFile();
    if (c) args.push('--cookies', c);
    return args;
}
function baseArgsNoProxy() {
    const full = baseArgs();
    const idx = full.indexOf('--proxy');
    if (idx !== -1) full.splice(idx, 2);
    return full;
}

function curlDownload(url, outputPath, timeoutSec = 300, useProxy = false) {
    return new Promise((resolve, reject) => {
        const args = ['-sS', '-L', '--max-time', String(timeoutSec),
            '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
            '-H', 'Referer: https://www.youtube.com/', '-H', 'Accept: */*', '-H', 'Accept-Encoding: identity'];
        if (useProxy) args.push('--proxy', PROXY_URL);
        args.push('-o', outputPath, url);
        execFile('curl', args, { timeout: (timeoutSec + 10) * 1000 }, (err) => {
            if (err) return reject(new Error(err.message.slice(0, 200)));
            resolve();
        });
    });
}

// ══════════════════════════════════════════════════════════════
// ██ DOWNLOAD VIDEO — calitate maximă
// ══════════════════════════════════════════════════════════════
const downloadVideo = async (url, outputPath) => {
    const t0 = Date.now();
    console.log(`${ts()} ▶ downloadVideo START`);
    if (fs.existsSync(outputPath)) try { fs.unlinkSync(outputPath); } catch (e) {}

    const strategies = [
        { label: 'bestvideo+bestaudio', format: 'bestvideo+bestaudio/best' },
        { label: 'best',                format: 'best' },
    ];

    let lastError = null, proxyRequired = false;

    for (const strat of strategies) {
        if (fs.existsSync(outputPath)) try { fs.unlinkSync(outputPath); } catch (e) {}
        console.log(`${ts()} 🔍 Strategie video [${strat.label}]...`);
        try {
            let cdnUrls = null, viaProxy = false;

            if (!proxyRequired) {
                try {
                    const t1 = Date.now();
                    console.log(`${ts()} 🔍 --get-url fără proxy...`);
                    const { stdout } = await runYtDlp([...baseArgsNoProxy(), '--get-url', '-f', strat.format, '--no-playlist', url], { timeout: 30000 });
                    const urls = stdout.split('\n').filter(u => u.startsWith('http'));
                    if (urls.length > 0) { cdnUrls = urls; viaProxy = false; console.log(`${ts()} ✅ ${urls.length} CDN URL(s) fără proxy (${elapsed(t1)})`); }
                } catch (e) { proxyRequired = true; console.warn(`${ts()} ⚠️ fără proxy fail → proxy`); }
            }

            if (!cdnUrls) {
                const t1 = Date.now();
                console.log(`${ts()} 🔍 --get-url prin proxy...`);
                const { stdout } = await runYtDlp([...baseArgs(), '--get-url', '-f', strat.format, '--no-playlist', url], { timeout: 45000 });
                const urls = stdout.split('\n').filter(u => u.startsWith('http'));
                if (urls.length > 0) { cdnUrls = urls; viaProxy = true; console.log(`${ts()} ✅ ${urls.length} CDN URL(s) proxy (${elapsed(t1)})`); }
            }

            if (!cdnUrls?.length) throw new Error('Niciun URL CDN returnat');

            if (cdnUrls.length === 1) {
                const t1 = Date.now();
                console.log(`${ts()} ⬇️ curl download combinat (${viaProxy ? 'proxy' : 'direct'})...`);
                await curlDownload(cdnUrls[0], outputPath, 300, viaProxy);
                console.log(`${ts()} ✅ curl OK (${elapsed(t1)})`);
            } else {
                const videoTmp = outputPath.replace(/\.mp4$/, '_vtmp.mp4');
                const audioTmp = outputPath.replace(/\.mp4$/, '_atmp.m4a');
                try {
                    const t1 = Date.now();
                    console.log(`${ts()} ⬇️ curl video stream (${viaProxy ? 'proxy' : 'direct'})...`);
                    await curlDownload(cdnUrls[0], videoTmp, 300, viaProxy);
                    console.log(`${ts()} ✅ video stream OK (${elapsed(t1)})`);

                    const t2 = Date.now();
                    console.log(`${ts()} ⬇️ curl audio stream...`);
                    await curlDownload(cdnUrls[1], audioTmp, 120, viaProxy);
                    console.log(`${ts()} ✅ audio stream OK (${elapsed(t2)})`);

                    const t3 = Date.now();
                    console.log(`${ts()} 🔀 ffmpeg merge...`);
                    await new Promise((res, rej) => execFile('ffmpeg', ['-i', videoTmp, '-i', audioTmp, '-c', 'copy', '-y', outputPath], { timeout: 120000 }, (err) => err ? rej(new Error('ffmpeg merge: ' + err.message.slice(0, 100))) : res()));
                    console.log(`${ts()} ✅ ffmpeg merge OK (${elapsed(t3)})`);
                } finally {
                    [videoTmp, audioTmp].forEach(f => { if (fs.existsSync(f)) try { fs.unlinkSync(f); } catch (e) {} });
                }
            }

            if (!fs.existsSync(outputPath)) throw new Error('Fișierul video nu a fost creat.');
            const sizeMB = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(2);
            if (fs.statSync(outputPath).size < 50 * 1024) throw new Error(`Fișier prea mic: ${sizeMB} MB`);
            console.log(`${ts()} ✅ Video OK: ${sizeMB} MB | total: ${elapsed(t0)}`);
            return;

        } catch (err) {
            lastError = err;
            console.warn(`${ts()} ⚠️ [${strat.label}] fail (${elapsed(t0)}): ${err.message.slice(0, 150)}`);

            if (strat === strategies[strategies.length - 1]) {
                const t1 = Date.now();
                console.log(`${ts()} 🔄 Fallback yt-dlp clasic cu proxy...`);
                try {
                    await runYtDlp([...baseArgs(), '-f', 'bestvideo+bestaudio/best', '--merge-output-format', 'mp4', '--concurrent-fragments', '4', '-o', outputPath, url], { timeout: 600000 });
                    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 50 * 1024) {
                        console.log(`${ts()} ✅ Fallback OK (${elapsed(t1)})`); return;
                    }
                } catch (fbErr) { console.warn(`${ts()} ⚠️ Fallback fail: ${fbErr.message.slice(0, 150)}`); }
            }
        }
    }
    throw new Error(lastError?.message || 'Nu am putut descărca videoul.');
};

// ══════════════════════════════════════════════════════════════
// ██ DOWNLOAD AUDIO (pentru Whisper)
// ══════════════════════════════════════════════════════════════
const downloadAudio = async (url, audioPath) => {
    const t0 = Date.now();
    console.log(`${ts()} ▶ downloadAudio START`);
    if (fs.existsSync(audioPath)) try { fs.unlinkSync(audioPath); } catch (e) {}

    const strategies = [
        { label: 'bestaudio', format: 'ba/bestaudio' },
        { label: 'best',      format: 'best' },
    ];

    let lastError = null, proxyRequired = false;

    for (const strat of strategies) {
        if (fs.existsSync(audioPath)) try { fs.unlinkSync(audioPath); } catch (e) {}
        try {
            let cdnUrls = null, viaProxy = false;

            if (!proxyRequired) {
                try {
                    const t1 = Date.now();
                    const { stdout } = await runYtDlp([...baseArgsNoProxy(), '--get-url', '-f', strat.format, '--no-playlist', url], { timeout: 30000 });
                    const urls = stdout.split('\n').filter(u => u.startsWith('http'));
                    if (urls.length > 0) { cdnUrls = urls; viaProxy = false; console.log(`${ts()} ✅ audio CDN fără proxy (${elapsed(t1)})`); }
                } catch (_) { proxyRequired = true; }
            }

            if (!cdnUrls) {
                const t1 = Date.now();
                console.log(`${ts()} 🔍 audio --get-url proxy [${strat.label}]...`);
                const { stdout } = await runYtDlp([...baseArgs(), '--get-url', '-f', strat.format, '--no-playlist', url], { timeout: 45000 });
                const urls = stdout.split('\n').filter(u => u.startsWith('http'));
                if (urls.length > 0) { cdnUrls = urls; viaProxy = true; console.log(`${ts()} ✅ audio CDN proxy (${elapsed(t1)})`); }
            }

            if (!cdnUrls?.length) throw new Error('Niciun URL CDN audio returnat');

            const audioStreamUrl = cdnUrls[cdnUrls.length - 1];
            const tempRaw = audioPath.replace(/\.mp3$/, '_raw.tmp');

            const t1 = Date.now();
            console.log(`${ts()} ⬇️ curl audio (${viaProxy ? 'proxy' : 'direct'})...`);
            await curlDownload(audioStreamUrl, tempRaw, 120, viaProxy);
            console.log(`${ts()} ✅ curl audio OK (${elapsed(t1)})`);

            if (!fs.existsSync(tempRaw) || fs.statSync(tempRaw).size < 1000) throw new Error('Audio brut gol');

            const t2 = Date.now();
            console.log(`${ts()} 🔀 ffmpeg → mp3...`);
            await new Promise((res, rej) => execFile('ffmpeg', ['-i', tempRaw, '-vn', '-acodec', 'libmp3lame', '-q:a', '0', '-y', audioPath], { timeout: 120000 }, (err) => err ? rej(new Error('ffmpeg audio: ' + err.message.slice(0, 100))) : res()));
            console.log(`${ts()} ✅ ffmpeg mp3 OK (${elapsed(t2)})`);

            try { fs.unlinkSync(tempRaw); } catch (e) {}
            if (!fs.existsSync(audioPath) || fs.statSync(audioPath).size < 1000) throw new Error('MP3 gol');
            console.log(`${ts()} ✅ Audio OK | total: ${elapsed(t0)}`);
            return;

        } catch (err) {
            lastError = err;
            const tempRaw = audioPath.replace(/\.mp3$/, '_raw.tmp');
            if (fs.existsSync(tempRaw)) try { fs.unlinkSync(tempRaw); } catch (e) {}
            console.warn(`${ts()} ⚠️ Audio [${strat.label}] fail: ${err.message.slice(0, 150)}`);

            if (strat === strategies[strategies.length - 1]) {
                const t1 = Date.now();
                console.log(`${ts()} 🔄 Fallback audio yt-dlp clasic...`);
                try {
                    await runYtDlp([...baseArgs(), '-f', 'ba/bestaudio/best', '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0', '-o', audioPath, url], { timeout: 300000 });
                    if (fs.existsSync(audioPath) && fs.statSync(audioPath).size > 1000) { console.log(`${ts()} ✅ Fallback audio OK (${elapsed(t1)})`); return; }
                } catch (fbErr) { console.warn(`${ts()} ⚠️ Fallback audio fail: ${fbErr.message.slice(0, 150)}`); }
            }
        }
    }
    throw new Error(lastError?.message || 'Nu am putut extrage audio.');
};

// ══════════════════════════════════════════════════════════════
// ██ TRANSCRIERE + TRADUCERE ROMÂNĂ (internă)
// ══════════════════════════════════════════════════════════════
const getTranscriptAndTranslation = async (url, videoId) => {
    const t0 = Date.now();
    let originalText = '';
    const audioPath = path.join(DOWNLOAD_DIR, `audio_${videoId}.mp3`);

    try {
        console.log(`${ts()} ▶ Transcriere START [${videoId}]`);

        // 1. Subtitrări native (instant)
        try {
            console.log(`${ts()} 📝 Încerc subtitrări native...`);
            await runYtDlp([...baseArgs(), '--write-auto-subs', '--sub-langs', 'ro,en', '--sub-format', 'vtt', '--skip-download', '-o', path.join(DOWNLOAD_DIR, `sub_${videoId}.%(ext)s`), url], { timeout: 30000 });
            const subFile = ['ro', 'en'].map(l => path.join(DOWNLOAD_DIR, `sub_${videoId}.${l}.vtt`)).find(f => fs.existsSync(f));
            if (subFile) {
                const raw = fs.readFileSync(subFile, 'utf8');
                const clean = raw.replace(/WEBVTT[\s\S]*?\n\n/, '').replace(/\d{2}:\d{2}:\d{2}\.\d{3} --> [\s\S]*?\n/g, '').replace(/<[^>]+>/g, '').replace(/\n{2,}/g, ' ').trim();
                try { fs.unlinkSync(subFile); } catch (e) {}
                if (clean.length > 50) { originalText = clean; console.log(`${ts()} ✅ Subtitrări OK (${elapsed(t0)}) · ${clean.length} chars`); }
            }
        } catch (subErr) { console.warn(`${ts()} ⚠️ Subtitrări fail: ${subErr.message.slice(0, 100)}`); }

        // 2. Whisper dacă nu avem subtitrări
        if (!originalText) {
            console.log(`${ts()} 🎙 Fără subtitrări → Whisper...`);
            await downloadAudio(url, audioPath);
            const sizeMB = (fs.statSync(audioPath).size / 1024 / 1024).toFixed(2);
            const t1 = Date.now();
            console.log(`${ts()} 🧠 Whisper START (${sizeMB} MB)...`);
            const transcription = await openai.audio.transcriptions.create({ file: fs.createReadStream(audioPath), model: 'whisper-1' });
            originalText = transcription.text;
            console.log(`${ts()} ✅ Whisper OK (${elapsed(t1)}) · ${originalText.length} chars`);
        }

    } catch (err) {
        console.error(`${ts()} ❌ Transcriere fail (${elapsed(t0)}): ${err.message.slice(0, 200)}`);
        return { original: 'Eroare la extragerea audio.', translated: 'Eroare tehnică.' };
    } finally {
        if (fs.existsSync(audioPath)) try { fs.unlinkSync(audioPath); } catch (e) {}
    }

    // 3. Traducere română
    try {
        const t1 = Date.now();
        console.log(`${ts()} 🌍 Traducere română (GPT-4o-mini)...`);
        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: 'Ești un traducător profesionist. Primești un text transcris dintr-un video YouTube. Traduce-l perfect, natural și cursiv în ROMÂNĂ. Dacă e deja în română, returnează-l exact. Returnează DOAR textul tradus, fără comentarii.' },
                { role: 'user', content: originalText.substring(0, 10000) }
            ],
        });
        const translatedText = completion.choices[0].message.content;
        console.log(`${ts()} ✅ Traducere OK (${elapsed(t1)}) | total: ${elapsed(t0)}`);
        return { original: originalText, translated: translatedText };
    } catch (e) {
        console.error(`${ts()} ❌ Traducere fail: ${e.message}`);
        return { original: originalText, translated: 'Eroare la traducere: ' + e.message };
    }
};

// ══════════════════════════════════════════════════════════════
// ██ AI33 VOICE HELPERS
// ══════════════════════════════════════════════════════════════
function downloadVoiceFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (response) => {
            if (response.statusCode === 301 || response.statusCode === 302) {
                file.close();
                return downloadVoiceFile(response.headers.location, dest).then(resolve).catch(reject);
            }
            response.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
        }).on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
    });
}

async function pollAI33Task(taskId, maxWait = 60000) {
    const interval = 3000;
    const maxAttempts = Math.floor(maxWait / interval);
    for (let i = 0; i < maxAttempts; i++) {
        await new Promise(r => setTimeout(r, interval));
        let resp;
        try {
            resp = await fetch(`${AI33_BASE_URL}/v1/task/${taskId}`, { headers: { 'xi-api-key': AI33_API_KEY }, signal: AbortSignal.timeout(10000) });
        } catch (e) { console.warn(`⚠️ AI33 poll ${i + 1}: ${e.message}`); continue; }
        if (resp.status === 503 || resp.status === 502) { console.warn(`⚠️ AI33 poll ${resp.status} retry...`); continue; }
        if (!resp.ok) throw new Error(`Polling fail: ${resp.status}`);
        const task = await resp.json();
        if (task.status === 'done') {
            const audioUrl = task.metadata?.audio_url || task.output_uri || task.metadata?.output_uri;
            if (!audioUrl) throw new Error('Task done dar fără URL audio.');
            return audioUrl;
        }
        if (task.status === 'error' || task.status === 'failed') throw new Error(task.error_message || 'Eroare AI33.');
    }
    throw new Error('Timeout: generarea a durat prea mult (60s).');
}

// ══════════════════════════════════════════════════════════════
// ██ AUTH ROUTES
// ══════════════════════════════════════════════════════════════
app.post('/api/auth/google', async (req, res) => {
    try {
        const r = await fetch(`${process.env.HUB_URL}/api/auth/google`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body) });
        res.status(r.status).json(await r.json());
    } catch (e) { res.status(500).json({ error: 'Nu pot comunica cu serverul principal.' }); }
});
app.get('/api/auth/me', authenticate, (req, res) => res.json({ user: req.user }));

// ══════════════════════════════════════════════════════════════
// ██ /api/download — endpoint pentru pipeline HTML
// POST { url, format, quality, transcript }
// Răspuns: { videoUrl, audioUrl, transcript, creditsLeft }
// ══════════════════════════════════════════════════════════════
app.post('/api/download', authenticate, async (req, res) => {
    const t0 = Date.now();
    const { url, format = 'mp4', quality, transcript: wantTranscript = true } = req.body;
    if (!url) return res.status(400).json({ error: 'URL lipsă' });

    const parsed = sanitizeYouTubeUrl(url);
    if (!parsed) return res.status(400).json({ error: 'Link YouTube invalid.' });

    const { cleanUrl, videoId } = parsed;
    const videoPath = path.join(DOWNLOAD_DIR, `${videoId}.mp4`);
    const audioPath = path.join(DOWNLOAD_DIR, `${videoId}_audio.mp3`);

    console.log(`\n${ts()} ══ /api/download | ID: ${videoId} | format: ${format}`);

    let creditResult;
    try {
        // ── CACHE HIT ──
        const cached = await VideoCache.findOne({ videoId }).catch(() => null);
        const videoExists = fs.existsSync(videoPath) && fs.statSync(videoPath).size > 100 * 1024;
        const audioExists = fs.existsSync(audioPath) && fs.statSync(audioPath).size > 1000;

        if (cached && (videoExists || audioExists)) {
            console.log(`${ts()} ⚡ CACHE HIT: ${videoId}`);
            const balance = await hubAPI.checkCredits(req.userId);
            return res.json({
                videoUrl: videoExists ? `/download/${videoId}.mp4` : null,
                audioUrl: audioExists ? `/download/${videoId}_audio.mp3` : null,
                transcript: cached.translatedText || cached.originalText || null,
                creditsLeft: balance.credits,
            });
        }

        // ── SCADE CREDIT ──
        try { creditResult = await hubAPI.useCredits(req.userId, 1); }
        catch (e) { return res.status(403).json({ error: 'Nu mai ai credite! Cumpără un pachet.' }); }

        const tasks = [];
        let transcriptResult = null;

        // ── Descarcă în funcție de format ──
        if (format === 'mp3') {
            // doar audio
            tasks.push(downloadAudio(cleanUrl, audioPath));
        } else if (format === 'both') {
            // video + audio separat (pentru Whisper ulterior)
            tasks.push(downloadVideo(cleanUrl, videoPath));
            tasks.push(downloadAudio(cleanUrl, audioPath));
        } else {
            // mp4 default
            tasks.push(downloadVideo(cleanUrl, videoPath));
        }

        // ── Transcriere în paralel dacă e cerută ──
        if (wantTranscript) {
            tasks.push(
                getTranscriptAndTranslation(cleanUrl, videoId)
                    .then(r => { transcriptResult = r; })
                    .catch(e => { console.warn(`${ts()} ⚠️ Transcriere paralel fail: ${e.message}`); })
            );
        }

        await Promise.all(tasks);

        // ── Cache ──
        if (transcriptResult) {
            await VideoCache.create({ videoId, originalText: transcriptResult.original, translatedText: transcriptResult.translated }).catch(() => {});
        }

        console.log(`${ts()} ✅ /api/download OK | ${elapsed(t0)}`);

        res.json({
            videoUrl: fs.existsSync(videoPath) && fs.statSync(videoPath).size > 100 * 1024 ? `/download/${videoId}.mp4` : null,
            audioUrl: fs.existsSync(audioPath) && fs.statSync(audioPath).size > 1000 ? `/download/${videoId}_audio.mp3` : null,
            transcript: transcriptResult?.translated || transcriptResult?.original || null,
            creditsLeft: creditResult.credits,
        });

    } catch (e) {
        console.error(`${ts()} ❌ /api/download FAIL [${videoId}] (${elapsed(t0)}): ${e.message.slice(0, 300)}`);
        // Refund credit
        if (creditResult) {
            try {
                const r = await fetch(`${process.env.HUB_URL}/api/internal/refund-credits`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-key': process.env.INTERNAL_API_KEY },
                    body: JSON.stringify({ userId: req.userId, amount: 1 }),
                });
                if (r.ok) { const rd = await r.json(); console.log(`${ts()} 🔄 Refund OK → credite: ${rd.credits}`); }
            } catch (refErr) { console.error(`${ts()} ⚠️ Refund fail: ${refErr.message}`); }
        }
        res.status(500).json({ error: 'Serverul nu a putut procesa acest video. Încearcă alt link.' });
    }
});

// ══════════════════════════════════════════════════════════════
// ██ /api/transcribe — Whisper pe fișier audio uploadat
// POST multipart: audio (File)
// Răspuns: { transcript }
// ══════════════════════════════════════════════════════════════
app.post('/api/transcribe', authenticate, uploadTmp.single('audio'), async (req, res) => {
    const tmpPath = req.file?.path;
    try {
        if (!req.file) return res.status(400).json({ error: 'Fișier audio lipsă.' });

        // Redenumim cu extensie .mp3 ca Whisper să fie fericit
        const mp3Path = tmpPath + '.mp3';
        fs.renameSync(tmpPath, mp3Path);

        console.log(`${ts()} 🧠 Whisper upload (${(req.file.size / 1024 / 1024).toFixed(2)} MB)...`);
        const t0 = Date.now();

        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(mp3Path),
            model: 'whisper-1',
        });

        try { fs.unlinkSync(mp3Path); } catch (e) {}
        console.log(`${ts()} ✅ Whisper OK (${elapsed(t0)}) · ${transcription.text.length} chars`);

        res.json({ transcript: transcription.text });

    } catch (e) {
        console.error(`${ts()} ❌ /api/transcribe fail:`, e.message);
        if (tmpPath && fs.existsSync(tmpPath)) try { fs.unlinkSync(tmpPath); } catch (_) {}
        res.status(500).json({ error: 'Eroare la transcriere: ' + e.message });
    }
});

// ══════════════════════════════════════════════════════════════
// ██ /api/translate — traducere text în română via GPT
// POST { text }
// Răspuns: { translated }
// ══════════════════════════════════════════════════════════════
app.post('/api/translate', authenticate, async (req, res) => {
    try {
        const { text } = req.body;
        if (!text) return res.status(400).json({ error: 'Text lipsă.' });

        console.log(`${ts()} 🌍 /api/translate · ${text.length} chars`);
        const t0 = Date.now();

        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: 'Ești un traducător profesionist. Traduce textul primit perfect, natural și cursiv în ROMÂNĂ. Dacă e deja în română, returnează-l exact. Returnează DOAR textul tradus, fără comentarii sau explicații.' },
                { role: 'user', content: text.substring(0, 10000) }
            ],
        });

        const translated = completion.choices[0].message.content;
        console.log(`${ts()} ✅ /api/translate OK (${elapsed(t0)})`);
        res.json({ translated });

    } catch (e) {
        console.error(`${ts()} ❌ /api/translate fail:`, e.message);
        res.status(500).json({ error: 'Eroare la traducere: ' + e.message });
    }
});

// ══════════════════════════════════════════════════════════════
// ██ PROCESARE YT (endpoint vechi — păstrat pentru compatibilitate)
// POST /api/process-yt  →  { url }
// ══════════════════════════════════════════════════════════════
app.post('/api/process-yt', authenticate, async (req, res) => {
    const t0 = Date.now();
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL lipsă' });

    const parsed = sanitizeYouTubeUrl(url);
    if (!parsed) return res.status(400).json({ error: 'Link YouTube invalid.' });

    const { cleanUrl, videoId } = parsed;
    const outputPath = path.join(DOWNLOAD_DIR, `${videoId}.mp4`);

    console.log(`\n${ts()} ══════════════════════════════════`);
    console.log(`${ts()} 📌 YT | ID: ${videoId} | ${cleanUrl}`);

    let creditResult;
    try {
        const cached = await VideoCache.findOne({ videoId }).catch(() => null);
        if (cached && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 100 * 1024) {
            console.log(`${ts()} ⚡ CACHE HIT: ${videoId}`);
            const balance = await hubAPI.checkCredits(req.userId);
            return res.json({ status: 'ok', downloadUrl: `/download/${videoId}.mp4`, originalText: cached.originalText, translatedText: cached.translatedText, creditsLeft: balance.credits });
        }
        if (fs.existsSync(outputPath)) try { fs.unlinkSync(outputPath); } catch (e) {}

        try { creditResult = await hubAPI.useCredits(req.userId, 1); }
        catch (e) { return res.status(403).json({ error: 'Nu mai ai credite! Cumpără un pachet.' }); }

        console.log(`${ts()} ⏳ START paralel (video + transcriere)...`);
        const [aiData] = await Promise.all([
            getTranscriptAndTranslation(cleanUrl, videoId),
            downloadVideo(cleanUrl, outputPath),
        ]);
        console.log(`${ts()} ✅ TOTAL YT: ${elapsed(t0)}`);

        await VideoCache.create({ videoId, originalText: aiData.original, translatedText: aiData.translated }).catch(() => {});
        res.json({ status: 'ok', downloadUrl: `/download/${videoId}.mp4`, originalText: aiData.original, translatedText: aiData.translated, creditsLeft: creditResult.credits });

    } catch (e) {
        console.error(`${ts()} ❌ YT FAIL [${videoId}] (${elapsed(t0)}): ${e.message.slice(0, 300)}`);
        if (fs.existsSync(outputPath)) try { fs.unlinkSync(outputPath); } catch (e2) {}
        if (creditResult) {
            try {
                const r = await fetch(`${process.env.HUB_URL}/api/internal/refund-credits`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-key': process.env.INTERNAL_API_KEY },
                    body: JSON.stringify({ userId: req.userId, amount: 1 }),
                });
                if (r.ok) { const rd = await r.json(); console.log(`${ts()} 🔄 Refund OK → credite: ${rd.credits}`); }
            } catch (refErr) { console.error(`${ts()} ⚠️ Refund fail: ${refErr.message}`); }
        }
        res.status(500).json({ error: 'Serverul nu a putut procesa acest video. Încearcă alt link.' });
    }
});

// ══════════════════════════════════════════════════════════════
// ██ VOICE GENERATION — AI33 (ElevenLabs)
// POST /api/generate  →  { text, voiceId, voice, stability, similarity_boost, speed }
// ══════════════════════════════════════════════════════════════
app.post('/api/generate', authenticate, async (req, res) => {
    try {
        const { text, voiceId, voice, stability, similarity_boost, speed } = req.body;
        if (!text) return res.status(400).json({ error: 'Text lipsă.' });

        const cost = text.replace(/\s+/g, '').length;
        const balance = await hubAPI.checkCredits(req.userId);
        if ((balance.voice_characters || 0) < cost) {
            return res.status(403).json({ error: `Caractere insuficiente. Ai nevoie de ${cost}.` });
        }

        const resolvedVoiceId = voiceId || 'nPczCjzI2devNBz1zQrb';
        console.log(`${ts()} 🎙 Voice: ${voice || resolvedVoiceId} · ${cost} chars`);

        let ai33Resp;
        try {
            ai33Resp = await fetch(`${AI33_BASE_URL}/v1/text-to-speech/${resolvedVoiceId}?output_format=mp3_44100_128`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'xi-api-key': AI33_API_KEY },
                body: JSON.stringify({
                    text, model_id: 'eleven_multilingual_v2',
                    voice_settings: { stability: parseFloat(stability) || 0.5, similarity_boost: parseFloat(similarity_boost) || 0.75, speed: parseFloat(speed) || 1.0 },
                    with_transcript: false,
                }),
                signal: AbortSignal.timeout(15000),
            });
        } catch (fetchErr) {
            if (fetchErr.name === 'TimeoutError' || fetchErr.name === 'AbortError')
                return res.status(503).json({ error: 'Serverul de voce nu răspunde. Încearcă din nou.' });
            throw fetchErr;
        }

        if (!ai33Resp.ok) {
            const errBody = await ai33Resp.text();
            console.error(`${ts()} ❌ AI33 ${ai33Resp.status}:`, errBody.slice(0, 200));
            if (ai33Resp.status === 429) return res.status(429).json({ error: 'Suprasolicitat. Așteaptă câteva secunde.' });
            if (ai33Resp.status === 503 || ai33Resp.status === 502) return res.status(503).json({ error: 'Serviciul de voce indisponibil. Reîncearcă.' });
            throw new Error(`AI33 eroare ${ai33Resp.status}`);
        }

        const ai33Data = await ai33Resp.json();
        if (!ai33Data.success || !ai33Data.task_id) throw new Error('AI33 nu a returnat task_id.');
        console.log(`${ts()} ✅ AI33 task: ${ai33Data.task_id}`);

        const outputUrl = await pollAI33Task(ai33Data.task_id);
        const fileName = `voice_${Date.now()}.mp3`;
        await downloadVoiceFile(outputUrl, path.join(DOWNLOAD_DIR, fileName));

        try { await hubAPI.useVoiceChars(req.userId, cost); } catch (e) { console.warn(`⚠️ useVoiceChars fail: ${e.message}`); }

        console.log(`${ts()} ✅ Voice OK: ${fileName}`);
        res.json({ audioUrl: `/download/${fileName}`, remaining_chars: (balance.voice_characters || 0) - cost });

    } catch (error) {
        console.error(`${ts()} ❌ Voice fail:`, error.message);
        res.status(500).json({ error: error.message || 'Eroare la generarea vocii.' });
    }
});

// ══════════════════════════════════════════════════════════════
// ██ SMART CUT — ffmpeg silence remove
// POST /api/smart-cut  →  multipart: file, minSilence, threshold
// ══════════════════════════════════════════════════════════════
app.post('/api/smart-cut', authenticate, uploadTmp.single('file'), async (req, res) => {
    try {
        const balance = await hubAPI.checkCredits(req.userId);
        if (balance.credits < 0.5) {
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(403).json({ error: 'Cost: 0.5 Credite. Fonduri insuficiente.' });
        }
        if (!req.file) return res.status(400).json({ error: 'Fișier lipsă.' });

        const inputFile = req.file.path;
        const outputFile = path.join(PROCESSED_DIR, `cut_${Date.now()}.mp3`);
        const threshold = req.body.threshold || '-45dB';
        const minSilence = req.body.minSilence || '0.35';
        const af = `silenceremove=start_periods=1:start_duration=0.1:start_threshold=${threshold}:stop_periods=-1:stop_duration=${minSilence}:stop_threshold=${threshold}`;

        console.log(`${ts()} ✂️ Smart Cut (thresh: ${threshold}, min: ${minSilence}s)`);

        exec(`ffmpeg -y -i "${inputFile}" -af "${af}" "${outputFile}"`, async (error) => {
            if (fs.existsSync(inputFile)) try { fs.unlinkSync(inputFile); } catch (e) {}
            if (error) { console.error(`${ts()} ❌ Smart Cut fail:`, error.message.slice(0, 200)); return res.status(500).json({ error: 'Eroare la procesarea audio.' }); }
            console.log(`${ts()} ✅ Smart Cut OK: ${path.basename(outputFile)}`);
            try {
                const result = await hubAPI.useCredits(req.userId, 0.5);
                res.json({ status: 'ok', downloadUrl: `/download/${path.basename(outputFile)}`, creditsLeft: result.credits });
            } catch (e) {
                res.json({ status: 'ok', downloadUrl: `/download/${path.basename(outputFile)}`, creditsLeft: 0 });
            }
        });
    } catch (e) {
        if (req.file && fs.existsSync(req.file.path)) try { fs.unlinkSync(req.file.path); } catch (e2) {}
        res.status(500).json({ error: e.message });
    }
});

// ══════════════════════════════════════════════════════════════
// ██ CAPTION REMOVER — ffmpeg delogo
// POST /api/remove-caption  →  multipart: video, boxX, boxY, boxW, boxH (%)
// ══════════════════════════════════════════════════════════════
app.post('/api/remove-caption', authenticate, uploadTmp.single('video'), async (req, res) => {
    try {
        const balance = await hubAPI.checkCredits(req.userId);
        if (balance.credits < 0.5) {
            if (req.file) try { fs.unlinkSync(req.file.path); } catch (e) {}
            return res.status(403).json({ error: 'Cost: 0.5 Credite. Fonduri insuficiente.' });
        }
        if (!req.file) return res.status(400).json({ error: 'Video lipsă.' });

        const inputPath = req.file.path;
        const videoId = Date.now();
        const outputPath = path.join(DOWNLOAD_DIR, `clean_${videoId}.mp4`);

        const boxY = parseInt(req.body.boxY ?? 70);
        const boxH = parseInt(req.body.boxH ?? 20);
        const boxX = parseInt(req.body.boxX ?? 10);
        const boxW = parseInt(req.body.boxW ?? 80);

        console.log(`${ts()} 🎬 Caption Remover (x=${boxX}% y=${boxY}% w=${boxW}% h=${boxH}%)`);

        exec(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${inputPath}"`, (probeErr, probeOut) => {
            if (probeErr) {
                if (fs.existsSync(inputPath)) try { fs.unlinkSync(inputPath); } catch (e) {}
                return res.status(500).json({ error: 'Eroare la analiza video.' });
            }

            const [width, height] = probeOut.trim().split('x').map(Number);
            let pY = Math.max(2, Math.floor((boxY / 100) * height));
            let pH = Math.max(2, Math.floor((boxH / 100) * height));
            let pX = Math.max(2, Math.floor((boxX / 100) * width));
            let pW = Math.max(2, Math.floor((boxW / 100) * width));
            if (pY + pH > height - 2) pH = height - pY - 2;
            if (pX + pW > width - 2) pW = width - pX - 2;

            const cmd = `ffmpeg -y -i "${inputPath}" -vf "delogo=x=${pX}:y=${pY}:w=${pW}:h=${pH}" -map 0:v:0 -map 0:a? -c:v libx264 -preset ultrafast -crf 23 -c:a copy "${outputPath}"`;

            exec(cmd, async (error, _stdout, stderr) => {
                if (fs.existsSync(inputPath)) try { fs.unlinkSync(inputPath); } catch (e) {}
                if (error) {
                    console.error(`${ts()} ❌ Caption Remover fail:`, stderr?.slice(0, 200));
                    return res.status(500).json({ error: 'Eroare video. Încearcă o zonă puțin mai mică.' });
                }
                console.log(`${ts()} ✅ Caption Remover OK: clean_${videoId}.mp4`);
                try {
                    const result = await hubAPI.useCredits(req.userId, 0.5);
                    res.json({ status: 'ok', downloadUrl: `/download/clean_${videoId}.mp4`, creditsLeft: result.credits });
                } catch (e) {
                    res.json({ status: 'ok', downloadUrl: `/download/clean_${videoId}.mp4`, creditsLeft: 0 });
                }
            });
        });
    } catch (e) {
        if (req.file && fs.existsSync(req.file.path)) try { fs.unlinkSync(req.file.path); } catch (e2) {}
        res.status(500).json({ error: e.message });
    }
});

// ══════════════════════════════════════════════════════════════
// ██ DOWNLOAD FILE — caută în ambele foldere
// ══════════════════════════════════════════════════════════════
app.get('/download/:filename', (req, res) => {
    const filename = path.basename(req.params.filename);
    for (const dir of [DOWNLOAD_DIR, PROCESSED_DIR]) {
        const filePath = path.resolve(dir, filename);
        if (filePath.startsWith(dir) && fs.existsSync(filePath)) return res.download(filePath);
    }
    res.status(404).send('Fișierul nu mai există sau a expirat.');
});

// ══════════════════════════════════════════════════════════════
// ██ CURĂȚARE AUTOMATĂ — 24h
// ══════════════════════════════════════════════════════════════
setInterval(() => {
    const now = Date.now();
    const exts = ['.mp4', '.mp3', '.tmp', '.m4a', '.vtt'];
    for (const dir of [DOWNLOAD_DIR, PROCESSED_DIR]) {
        try {
            fs.readdirSync(dir).forEach(file => {
                if (exts.some(e => file.endsWith(e))) {
                    const fp = path.join(dir, file);
                    try { if (now - fs.statSync(fp).mtimeMs > 86400000) fs.unlinkSync(fp); } catch (e) {}
                }
            });
        } catch (e) { console.error('Eroare curățare:', e.message); }
    }
}, 3600000);

app.listen(PORT, () => {
    console.log(`\n🚀 Viralio All-in-One · port ${PORT}`);
    console.log(`   ✅ /api/download        — YT Download (video/audio/both) + Transcriere`);
    console.log(`   ✅ /api/transcribe      — Whisper pe fișier audio uploadat`);
    console.log(`   ✅ /api/translate       — Traducere română (GPT-4o-mini)`);
    console.log(`   ✅ /api/process-yt      — YT legacy (compatibilitate)`);
    console.log(`   ✅ /api/generate        — Voice Generation (AI33/ElevenLabs)`);
    console.log(`   ✅ /api/smart-cut       — Smart Cut (silence remove)`);
    console.log(`   ✅ /api/remove-caption  — Caption Remover (delogo)\n`);
});