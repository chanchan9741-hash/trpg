const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const mongoose = require('mongoose');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
const { OpenAI } = require('openai');

// 1. 순천향대 AI Hub 설정
// 주의: .env 파일에 SCH_AIHUB_API_KEY가 정확히 입력되어 있어야 합니다.
const openai = new OpenAI({
    apiKey: process.env.SCH_AIHUB_API_KEY,
    baseURL: "https://factchat-cloud.mindlogic.ai/v1/gateway"
});

const app = express();

// 2. MongoDB 연결
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ MongoDB 연결 성공!"))
    .catch(err => console.error("❌ MongoDB 연결 실패:", err));

// 3. 모델 정의
const User = mongoose.models.User || mongoose.model('User', new mongoose.Schema({
    googleId: String, username: String, email: String
}));

const Scenario = mongoose.models.Scenario || mongoose.model('Scenario', new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    title: String,
    worldSetting: String,
    characterInfo: String,
    createdAt: { type: Date, default: Date.now }
}));

const Message = mongoose.models.Message || mongoose.model('Message', new mongoose.Schema({
    scenarioId: { type: mongoose.Schema.Types.ObjectId, ref: 'Scenario' },
    role: String,
    content: String,
    createdAt: { type: Date, default: Date.now }
}));

// 4. 미들웨어 설정
app.use(express.static('public')); 
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'trpg_secret',
    resave: false,
    saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());

// 5. Passport 구글 로그인
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: "/auth/google/callback",
    proxy: true 
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
        let user = await User.findOne({ googleId: profile.id });
        if (!user) {
            user = await User.create({
                googleId: profile.id,
                username: profile.displayName,
                email: profile.emails[0].value
            });
        }
        return done(null, user);
    } catch (err) { return done(err, null); }
  }
));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
    try {
        const user = await User.findById(id);
        done(null, user);
    } catch (err) { done(err, null); }
});

// 6. 페이지 라우트
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/create', (req, res) => req.user ? res.sendFile(__dirname + '/create.html') : res.redirect('/auth/google'));
app.get('/game/:id', (req, res) => req.user ? res.sendFile(__dirname + '/game.html') : res.redirect('/auth/google'));

// 7. API 라우트
app.get('/api/user', (req, res) => res.json(req.user || null));
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/' }), (req, res) => res.redirect('/'));
app.get('/auth/logout', (req, res) => {
    req.logout(() => res.redirect('/'));
});

app.get('/api/my-scenarios', async (req, res) => {
    if (!req.user) return res.json([]);
    const scenarios = await Scenario.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.json(scenarios);
});

app.post('/api/scenarios', async (req, res) => {
    if (!req.user) return res.status(401).send("Unauthorized");
    const newScenario = new Scenario({
        userId: req.user._id,
        title: req.body.title,
        worldSetting: req.body.worldSetting,
        characterInfo: req.body.characterInfo
    });
    await newScenario.save();
    res.json({ success: true });
});
app.post('/api/chat', async (req, res) => {
    if (!req.user) return res.status(401).send("로그인 필요");
    const { scenarioId, userMessage, model } = req.body;
    
    try {
        const scenario = await Scenario.findById(scenarioId);
        if (!scenario) return res.status(404).send("시나리오 없음");

        await Message.create({ scenarioId, role: 'user', content: userMessage || "게임 시작" });

        // 선택한 모델이 없으면 가장 밸런스 좋은 mini 사용
        const targetModel = model || "gpt-5.4-mini";
        console.log(`🎲 마스터 출격: ${targetModel}`);

        const response = await openai.chat.completions.create({
            model: targetModel,
            messages: [
                { 
                    role: "user", 
                    content: `[시스템: 당신은 노련한 TRPG 마스터입니다. 세계관: ${scenario.worldSetting}, 캐릭터: ${scenario.characterInfo}. 상황에 맞춰 몰입감 있게 한국어로 대답하세요.]\n\n현재 상황: ${userMessage || "게임을 시작해줘."}` 
                }
            ],
            max_tokens: 1000,
            temperature: 0.8 // 마스터의 창의력을 위해 살짝 높임
        });

        const aiReply = response.choices[0].message.content;
        await Message.create({ scenarioId, role: 'assistant', content: aiReply });
        
        res.send(aiReply);

    } catch (error) {
        console.error("❌ 마스터 응답 에러:", error.message);
        res.status(500).send("마스터가 주사위를 굴리다 넘어졌습니다. 다시 시도해 주세요!");
    }
});
// [추가] 시나리오의 이전 대화 로그 불러오기 API
app.get('/api/chat/:scenarioId', async (req, res) => {
    try {
        const messages = await Message.find({ scenarioId: req.params.scenarioId }).sort('createdAt');
        res.json(messages);
    } catch (err) {
        res.status(500).send("로그를 불러오는데 실패했습니다.");
    }
});

// [추가] 시나리오의 대화 로그 초기화(삭제) API
app.delete('/api/chat/:scenarioId', async (req, res) => {
    try {
        await Message.deleteMany({ scenarioId: req.params.scenarioId });
        res.send("대화 로그가 초기화되었습니다.");
    } catch (err) {
        res.status(500).send("초기화 실패");
    }
});

// 9. 서버 실행
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log("-----------------------------------------");
    console.log(`서버 실행 중: http://localhost:${PORT}`);
    console.log("-----------------------------------------");
});