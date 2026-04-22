require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');

const app = express();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
const PORT = process.env.PORT || 3000;
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ── API KEY pentru comunicare inter-servicii ──
// Adaugă în .env: INTERNAL_API_KEY=un_string_random_lung_32+_caractere
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Conectat la MongoDB!'))
    .catch(err => console.error('❌ Eroare MongoDB:', err));

const UserSchema = new mongoose.Schema({
    googleId:           { type: String, required: true, unique: true },
    email:              { type: String, required: true },
    name:               String,
    picture:            String,
    credits:            { type: Number, default: 10 },
    voice_characters:   { type: Number, default: 3000 },
    stripeCustomerId:   { type: String, default: null },
    subscriptionId:     { type: String, default: null },
    subscriptionPlan:   { type: String, enum: ['none','starter','creator','agency'], default: 'none' },
    subscriptionStatus: { type: String, default: 'inactive' },
    currentPeriodEnd:   { type: Date, default: null },
    createdAt:          { type: Date, default: Date.now }
});
const User = mongoose.models.User || mongoose.model('User', UserSchema);

const WaitlistSchema = new mongoose.Schema({
    email: String, name: String, date: { type: Date, default: Date.now }
});
const Waitlist = mongoose.models.Waitlist || mongoose.model('Waitlist', WaitlistSchema);

const PLANS = {
    [process.env.STRIPE_PRICE_STARTER]:        { plan: 'starter', credits: 150,  chars: 50000  },
    [process.env.STRIPE_PRICE_CREATOR]:        { plan: 'creator', credits: 400,  chars: 150000 },
    [process.env.STRIPE_PRICE_AGENCY]:         { plan: 'agency',  credits: 1500, chars: 500000 },
    [process.env.STRIPE_PRICE_STARTER_YEARLY]: { plan: 'starter', credits: 150,  chars: 50000  },
    [process.env.STRIPE_PRICE_CREATOR_YEARLY]: { plan: 'creator', credits: 400,  chars: 150000 },
    [process.env.STRIPE_PRICE_AGENCY_YEARLY]:  { plan: 'agency',  credits: 1500, chars: 500000 },
};

const TOPUP = {
    [process.env.STRIPE_PRICE_TOPUP_50]:  50,
    [process.env.STRIPE_PRICE_TOPUP_150]: 150,
    [process.env.STRIPE_PRICE_TOPUP_400]: 400,
};

console.log('📋 PLANS:', JSON.stringify(PLANS));
console.log('📋 TOPUP:', JSON.stringify(TOPUP));
console.log('📋 WEBHOOK_SECRET:', endpointSecret ? endpointSecret.substring(0, 12) + '...' : 'LIPSESTE!');

// ══════════════════════════════════════════════════════════════
// ██ WEBHOOK STRIPE (trebuie ÎNAINTE de express.json!)
// ══════════════════════════════════════════════════════════════
app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
        console.error('❌ WEBHOOK SIGNATURE ERROR:', err.message);
        return res.status(400).send('Webhook Error: ' + err.message);
    }

    console.log('📨 WEBHOOK PRIMIT:', event.type);

    try {
        if (event.type === 'invoice.payment_succeeded') {
            const invoice = event.data.object;
            const subId = invoice.subscription
                || invoice.parent?.subscription_details?.subscription
                || invoice.lines?.data?.[0]?.subscription;

            console.log('💳 amount_paid=' + invoice.amount_paid + ' | subId=' + subId);

            if (invoice.amount_paid === 0) { console.log('⏭️ Skip: amount=0'); return res.sendStatus(200); }
            if (!subId) { console.log('⏭️ Skip: nu e subscription'); return res.sendStatus(200); }

            const sub = await stripe.subscriptions.retrieve(subId);
            const priceId = sub.items.data[0]?.price?.id;
            const planCfg = PLANS[priceId];
            if (!planCfg) { console.error('❌ PRICE ID NECUNOSCUT: ' + priceId); return res.sendStatus(200); }

            const customer = await stripe.customers.retrieve(invoice.customer);
            const email = customer.email;

            const user = await User.findOneAndUpdate(
                { email },
                {
                    credits: planCfg.credits, voice_characters: planCfg.chars,
                    stripeCustomerId: invoice.customer, subscriptionId: subId,
                    subscriptionPlan: planCfg.plan, subscriptionStatus: 'active',
                    currentPeriodEnd: new Date(sub.current_period_end * 1000),
                },
                { new: true }
            );
            if (user) console.log('✅ SUCCES: ' + email + ' plan=' + planCfg.plan);
            else console.error('❌ USER NEGASIT pentru: ' + email);
        }

        else if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            if (session.mode !== 'payment') { return res.sendStatus(200); }

            const topupPriceId = session.metadata?.topup_price_id;
            const creditsToAdd = topupPriceId ? TOPUP[topupPriceId] : null;
            if (!creditsToAdd) { console.error('❌ TOPUP metadata lipsa'); return res.sendStatus(200); }

            const email = session.customer_details?.email;
            if (!email) { console.error('❌ TOPUP email lipsa'); return res.sendStatus(200); }

            const user = await User.findOneAndUpdate(
                { email }, { $inc: { credits: creditsToAdd } }, { new: true }
            );
            if (user) console.log('✅ TOPUP +' + creditsToAdd + ' pentru ' + email + ' total=' + user.credits);
            else console.error('❌ TOPUP negasit: ' + email);
        }

        else if (event.type === 'customer.subscription.deleted') {
            const sub = event.data.object;
            const customer = await stripe.customers.retrieve(sub.customer);
            await User.findOneAndUpdate(
                { email: customer.email },
                { subscriptionId: null, subscriptionPlan: 'none', subscriptionStatus: 'canceled', currentPeriodEnd: null }
            );
            console.log('❌ SUB CANCELED: ' + customer.email);
        }

        else if (event.type === 'invoice.payment_failed') {
            const invoice = event.data.object;
            if (invoice.subscription) {
                const customer = await stripe.customers.retrieve(invoice.customer);
                await User.findOneAndUpdate({ email: customer.email }, { subscriptionStatus: 'past_due' });
                console.warn('⚠️ PAYMENT FAILED: ' + customer.email);
            }
        }
    } catch (err) {
        console.error('❌ EROARE WEBHOOK:', err.message);
    }

    res.sendStatus(200);
});

// ── MIDDLEWARE ───────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());
app.get('/open-in-browser', (req, res) => {
    res.sendFile(path.join(__dirname, 'tiktok-redirect.html'));
});
app.use(express.static(path.join(__dirname, 'public')));

const authenticate = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Trebuie să fii logat!' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = decoded.userId;
        next();
    } catch (e) {
        return res.status(401).json({ error: 'Sesiune expirată.' });
    }
};

// Middleware pentru apeluri interne (de la celelalte app-uri)
const authenticateInternal = (req, res, next) => {
    const apiKey = req.headers['x-internal-key'];
    if (!apiKey || apiKey !== INTERNAL_API_KEY) {
        return res.status(403).json({ error: 'Acces interzis.' });
    }
    next();
};

// ══════════════════════════════════════════════════════════════
// ██ AUTH — GOOGLE LOGIN (SINGURA SURSĂ!)
// ══════════════════════════════════════════════════════════════
app.post('/api/auth/google', async (req, res) => {
    try {
        const ticket = await googleClient.verifyIdToken({
            idToken: req.body.credential,
            audience: process.env.GOOGLE_CLIENT_ID
        });
        const payload = ticket.getPayload();
        let user = await User.findOne({ googleId: payload.sub });

        if (!user) {
            const userCount = await User.countDocuments();
            if (userCount >= 650) {
                const dejaInLista = await Waitlist.findOne({ email: payload.email });
                if (!dejaInLista) await Waitlist.create({ email: payload.email, name: payload.name });
                return res.status(403).json({
                    error: 'BETA_FULL',
                    message: 'Locurile limitate pentru Beta s-au epuizat! Te-am adăugat pe lista de așteptare.',
                    discordLink: 'https://discord.gg/h8Ah6VKDzm'
                });
            }
            user = new User({
                googleId: payload.sub, email: payload.email,
                name: payload.name, picture: payload.picture,
                credits: 10, voice_characters: 3000
            });
            await user.save();
        }

        const sessionToken = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
        res.json({
            token: sessionToken,
            user: {
                name: user.name, picture: user.picture,
                credits: user.credits, voice_characters: user.voice_characters,
                email: user.email, subscriptionPlan: user.subscriptionPlan,
                subscriptionStatus: user.subscriptionStatus,
            }
        });
    } catch (error) {
        console.error(error);
        res.status(400).json({ error: 'Eroare Google' });
    }
});

app.get('/api/auth/me', authenticate, async (req, res) => {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User inexistent.' });
    res.json({
        user: {
            name: user.name, picture: user.picture,
            credits: user.credits, voice_characters: user.voice_characters,
            email: user.email, subscriptionPlan: user.subscriptionPlan,
            subscriptionStatus: user.subscriptionStatus,
            currentPeriodEnd: user.currentPeriodEnd,
        }
    });
});

// ══════════════════════════════════════════════════════════════
// ██ ENDPOINTURI INTER-SERVICII (apelate de celelalte app-uri)
// ══════════════════════════════════════════════════════════════

// 1. Verificare token — celelalte app-uri trimit JWT-ul userului, HUB-ul îl validează
app.post('/api/internal/verify-token', authenticateInternal, async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token lipsă.' });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.userId);
        if (!user) return res.status(404).json({ error: 'User inexistent.' });

        res.json({
            userId: user._id,
            user: {
                name: user.name, picture: user.picture,
                credits: user.credits, voice_characters: user.voice_characters,
                email: user.email, subscriptionPlan: user.subscriptionPlan,
                subscriptionStatus: user.subscriptionStatus,
            }
        });
    } catch (e) {
        return res.status(401).json({ error: 'Token invalid sau expirat.' });
    }
});

// 2. Scade credite — atomic, cu verificare $gte
app.post('/api/internal/use-credits', authenticateInternal, async (req, res) => {
    const { userId, amount } = req.body;
    if (!userId || !amount || amount <= 0) return res.status(400).json({ error: 'userId și amount sunt obligatorii.' });

    const user = await User.findOneAndUpdate(
        { _id: userId, credits: { $gte: amount } },
        { $inc: { credits: -amount } },
        { new: true }
    );

    if (!user) {
        const exists = await User.findById(userId);
        if (!exists) return res.status(404).json({ error: 'User inexistent.' });
        return res.status(403).json({ error: 'Credite insuficiente.', credits: exists.credits });
    }

    res.json({ credits: user.credits });
});

// 2b. Refund credite — adaugă înapoi credite după o procesare eșuată
app.post('/api/internal/refund-credits', authenticateInternal, async (req, res) => {
    const { userId, amount } = req.body;
    if (!userId || !amount || amount <= 0) return res.status(400).json({ error: 'userId și amount sunt obligatorii.' });

    const user = await User.findByIdAndUpdate(
        userId,
        { $inc: { credits: amount } },
        { new: true }
    );

    if (!user) return res.status(404).json({ error: 'User inexistent.' });

    console.log(`🔄 Refund ${amount} credit(e) pentru ${userId} → total: ${user.credits}`);
    res.json({ credits: user.credits });
});

// 3. Scade voice_characters — atomic
app.post('/api/internal/use-voice-chars', authenticateInternal, async (req, res) => {
    const { userId, amount } = req.body;
    if (!userId || !amount || amount <= 0) return res.status(400).json({ error: 'userId și amount sunt obligatorii.' });

    const user = await User.findOneAndUpdate(
        { _id: userId, voice_characters: { $gte: amount } },
        { $inc: { voice_characters: -amount } },
        { new: true }
    );

    if (!user) {
        const exists = await User.findById(userId);
        if (!exists) return res.status(404).json({ error: 'User inexistent.' });
        return res.status(403).json({ error: 'Caractere voce insuficiente.', voice_characters: exists.voice_characters });
    }

    res.json({ voice_characters: user.voice_characters });
});

// 4. Verifică credite (fără a le scădea)
app.post('/api/internal/check-credits', authenticateInternal, async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId obligatoriu.' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User inexistent.' });

    res.json({ credits: user.credits, voice_characters: user.voice_characters });
});

// 5. Returnează info user complet (pentru /api/auth/me pe sub-app-uri)
app.post('/api/internal/user-info', authenticateInternal, async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId obligatoriu.' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User inexistent.' });

    res.json({
        user: {
            name: user.name, picture: user.picture,
            credits: user.credits, voice_characters: user.voice_characters,
            email: user.email, subscriptionPlan: user.subscriptionPlan,
            subscriptionStatus: user.subscriptionStatus,
            currentPeriodEnd: user.currentPeriodEnd,
        }
    });
});

// ══════════════════════════════════════════════════════════════
// ██ STRIPE ROUTES
// ══════════════════════════════════════════════════════════════
app.post('/api/stripe/subscribe', authenticate, async (req, res) => {
    const { plan } = req.body;
    const interval = req.body.interval || 'monthly';
    const priceMap = {
        starter: interval === 'yearly' ? process.env.STRIPE_PRICE_STARTER_YEARLY : process.env.STRIPE_PRICE_STARTER,
        creator: interval === 'yearly' ? process.env.STRIPE_PRICE_CREATOR_YEARLY : process.env.STRIPE_PRICE_CREATOR,
        agency:  interval === 'yearly' ? process.env.STRIPE_PRICE_AGENCY_YEARLY  : process.env.STRIPE_PRICE_AGENCY,
    };
    const priceId = priceMap[plan];
    if (!priceId) return res.status(400).json({ error: 'Plan invalid' });

    const user = await User.findById(req.userId);
    try {
        const sessionParams = {
            mode: 'subscription',
            line_items: [{ price: priceId, quantity: 1 }],
            success_url: process.env.APP_URL + '/?subscribed=1',
            cancel_url:  process.env.APP_URL + '/#pricing',
            metadata: { userId: user._id.toString() },
            subscription_data: { metadata: { userId: user._id.toString() } },
        };
        if (user.stripeCustomerId) sessionParams.customer = user.stripeCustomerId;
        else sessionParams.customer_email = user.email;

        const session = await stripe.checkout.sessions.create(sessionParams);
        res.json({ url: session.url });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Eroare Stripe' });
    }
});

app.post('/api/stripe/topup', authenticate, async (req, res) => {
    const { package: pkg } = req.body;
    const topupMap = {
        micro:    { priceId: process.env.STRIPE_PRICE_TOPUP_50,  credits: 50  },
        standard: { priceId: process.env.STRIPE_PRICE_TOPUP_150, credits: 150 },
        pro:      { priceId: process.env.STRIPE_PRICE_TOPUP_400, credits: 400 },
    };
    const topup = topupMap[pkg];
    if (!topup) return res.status(400).json({ error: 'Pachet invalid' });

    const user = await User.findById(req.userId);
    const isSubscriber = user.subscriptionStatus === 'active';
    try {
        const sessionParams = {
            mode: 'payment',
            line_items: [{ price: topup.priceId, quantity: 1 }],
            success_url: process.env.APP_URL + '/?topup=1',
            cancel_url:  process.env.APP_URL + '/',
            metadata: { topup_price_id: topup.priceId, userId: user._id.toString() },
            payment_intent_data: { metadata: { topup_price_id: topup.priceId } },
        };
        if (user.stripeCustomerId) sessionParams.customer = user.stripeCustomerId;
        else sessionParams.customer_email = user.email;
        if (isSubscriber) sessionParams.discounts = [{ coupon: process.env.STRIPE_COUPON_SUBSCRIBER_10 }];

        const session = await stripe.checkout.sessions.create(sessionParams);
        res.json({ url: session.url, discount: isSubscriber });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Eroare Stripe' });
    }
});

app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log('🚀 HUB rulează pe portul ' + PORT));