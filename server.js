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
    questLines: [String],
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

app.get('/api/chat/:scenarioId', async (req, res) => {
    try {
        const { scenarioId } = req.params;
        console.log("🔍 요청받은 시나리오 ID:", scenarioId); // 터미널에 찍힘

        const messages = await Message.find({ scenarioId }).sort({ createdAt: 1 });
        console.log(`📦 찾은 메시지 개수: ${messages.length}개`); // 개수 확인

        res.json(messages); 
    } catch (err) {
        console.error("❌ 로그 불러오기 실패:", err);
        res.status(500).send("로그 실패");
    }
});

app.get('/api/scenario/:id', async (req, res) => {
    try {
        const scenario = await Scenario.findById(req.params.id);
        if (!scenario) return res.status(404).send("시나리오를 찾을 수 없습니다.");
        res.json(scenario); // 여기서 JSON을 정확히 보내줘야 에러가 안 납니다!
    } catch (err) {
        res.status(500).send(err.message);
    }
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

        // [핵심] 1. DB에서 최근 대화 로그 10개를 불러와 AI에게 전달할 준비를 합니다.
        const prevMessages = await Message.find({ scenarioId })
            .sort({ createdAt: -1 })
            .limit(10);
        const history = prevMessages.reverse().map(msg => ({
            role: msg.role,
            content: msg.content
        }));

        // 2. 현재 유저 메시지를 DB에 저장합니다.
        await Message.create({ scenarioId, role: 'user', content: userMessage || "게임 시작" });

        const questStatus = scenario.questLines && scenario.questLines.length > 0 
            ? `\n[지금까지의 주요 사건들: ${scenario.questLines.join(', ')}]` 
            : "\n[아직 발생한 주요 사건이 없습니다.]";

        const targetModel = model || "gpt-5.4-mini";
        console.log ('${targetModel}');
        

        const response = await openai.chat.completions.create({
            model: targetModel,
            messages: [
                { 
                    role: "system", 
                    content: `당신은 TRPG 마스터입니다. 세계관: ${scenario.worldSetting}, 캐릭터: ${scenario.characterInfo}.${questStatus}
                    상황에 맞춰 몰입감 있게 한국어로 대답하세요. 
                    새로운 중요 사건이 발생했다면 답변 끝에 [요약: 사건내용] 형식으로 딱 한 줄만 추가하세요.` 
                },
                ...history, // [기억 이식] 이전 대화들을 AI에게 전달합니다.
                { role: "user", content: userMessage || "게임을 시작해줘." }
            ],
            max_tokens: 1000,
            temperature: 0.8
        });

  // server.js의 채팅 API 응답 부분
const aiReply = response.choices[0].message.content;

// [요약: ...] 추출 및 DB 저장
const questMatch = aiReply.match(/\[요약: (.*?)\]/);
let updatedQuestLines = scenario.questLines; // 기본값은 기존 기록

if (questMatch) {
    const newQuest = questMatch[1];
    const updated = await Scenario.findByIdAndUpdate(
        scenarioId, 
        { $push: { questLines: newQuest } },
        { new: true }
    );
    updatedQuestLines = updated.questLines;
}

// 중요: 화면에 보여줄 텍스트에서 [요약: ...] 부분을 완전히 삭제합니다.
const cleanReply = aiReply.replace(/\[요약: .*?\]/g, "").trim();

// JSON으로 깔끔하게 응답
return res.json({ 
    reply: cleanReply, 
    questLines: updatedQuestLines 
});

    } catch (error) {
        console.error("❌ 마스터 응답 에러:", error.message);
        if (!res.headersSent) {
            return res.status(500).send("마스터가 주사위를 굴리다 넘어졌습니다.");
        }
    }
});
// [추가] 시나리오의 이전 대화 로그 불러오기 API
// [✅ 백엔드 수정] 


// [추가] 시나리오의 대화 로그 초기화(삭제) API
// server.js의 삭제 API
app.delete('/api/chat/:scenarioId', async (req, res) => {
    try {
        const { scenarioId } = req.params;

        // 1. 해당 시나리오의 모든 채팅 메시지 삭제
        await Message.deleteMany({ scenarioId });

        // 2. [추가] 해당 시나리오의 주요 사건 기록(questLines) 초기화
        await Scenario.findByIdAndUpdate(scenarioId, {
            $set: { questLines: [] } // 배열을 텅 비웁니다.
        });

        console.log(`🧹 시나리오 ${scenarioId}의 모든 기록이 초기화되었습니다.`);
        res.send("모든 기록이 초기화되었습니다.");
    } catch (err) {
        console.error("❌ 초기화 중 에러:", err);
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