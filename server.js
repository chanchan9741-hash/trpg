const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const mongoose = require('mongoose');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');

// 최신 라이브러리 방식 적용
const { GoogleGenAI } = require("@google/genai");
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const app = express();

// 1. MongoDB 연결
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("MongoDB 연결 성공!"))
    .catch(err => console.error("MongoDB 연결 실패:", err));

// 2. 모델 정의
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

// 3. 미들웨어 설정
app.use(express.static('public')); 
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'trpg_secret',
    resave: false,
    saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());

// 4. Passport 구글 로그인 설정
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: "/auth/google/callback"
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
    const user = await User.findById(id);
    done(null, user);
});

// 5. 페이지 라우트
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/create', (req, res) => req.user ? res.sendFile(__dirname + '/create.html') : res.redirect('/auth/google'));
app.get('/game/:id', (req, res) => req.user ? res.sendFile(__dirname + '/game.html') : res.redirect('/auth/google'));

// 6. 인증 API
app.get('/api/user', (req, res) => res.json(req.user || null));
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/' }), (req, res) => res.redirect('/'));
app.get('/auth/logout', (req, res) => {
    req.logout(() => res.redirect('/'));
});

// 7. 시나리오 관련 API
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

// 8. ★ 중복 제거된 단 하나의 채팅 API (스트리밍 + 자동 우회 적용) ★
app.post('/api/chat', async (req, res) => {
    if (!req.user) return res.status(401).send("로그인 필요");
    const { scenarioId, userMessage } = req.body;
    
    try {
        const scenario = await Scenario.findById(scenarioId);
        if (!scenario) return res.status(404).send("시나리오 없음");

        // 호출용 함수 (재사용 목적)
        const callMaster = async (modelName) => {
            return await ai.models.generateContentStream({
                model: modelName,
                contents: [{
                    role: "user",
                    parts: [{ 
                        text: `[시스템] 너는 TRPG 마스터야. 세계관: ${scenario.worldSetting}, 캐릭터: ${scenario.characterInfo}. 한국어로 짧고 몰입감 있게 대답해줘. 상황/행동: ${userMessage || "게임을 시작해줘."}` 
                    }]
                }],
                generationConfig: { maxOutputTokens: 300, temperature: 0.8 }
            });
        };

        let response;

        try {
            // 🚀 1차 시도: 빠르고 똑똑한 Gemini 2.5 Flash
            console.log("1차 모델(Gemini 2.5) 호출 중...");
            response = await callMaster("gemma-4-31b-it"); 
        } catch (firstError) {
            console.log(`⚠️ 1차 모델 실패 (${firstError.message}). 예비 모델(Gemma 4)로 우회합니다!`);
            // 🚀 2차 시도: 구글 서버 과부하 시 Gemma 4 31B로 우회
            response = await callMaster("gemma-3-27b-it"); 
        }

        // 스트리밍을 위한 헤더 설정
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Transfer-Encoding', 'chunked');

        // 최신 라이브러리 방식: response에서 직접 스트림 추출
        for await (const chunk of response) {
            const chunkText = chunk.text; 
            if (chunkText) {
                res.write(chunkText); // 글자 조각 실시간 전송
            }
        }
        
        res.end(); // 전송 완료

    } catch (err) {
        console.error("❌ 모든 AI 모델 응답 실패:", err);
        if (!res.headersSent) {
            res.status(500).send("현재 모든 마스터가 바쁩니다. 잠시 후 다시 시도해주세요.");
        } else {
            res.write("\n[시스템: 연결이 완전히 끊겼습니다.]");
            res.end();
        }
    }
});

// 9. 서버 시작
app.listen(8080, () => {
    console.log("-----------------------------------------");
    console.log("서버 실행 중: http://localhost:8080");
    console.log("-----------------------------------------");
});