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
    quests: { type: Map, of: String, default: {} },
    inventory: { type: [String], default: [] }, // 아이템 리스트 추가
    createdAt: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now }
}));

const Message = mongoose.models.Message || mongoose.model('Message', new mongoose.Schema({
    scenarioId: { type: mongoose.Schema.Types.ObjectId, ref: 'Scenario' },
    role: String,
    content: String,
    createdAt: { type: Date, default: Date.now }
}));

// 4. 미들웨어 설정
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));
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

        // 1. 현재까지의 메시지 개수 확인
        const messageCount = await Message.countDocuments({ scenarioId });
        const isFirstMessage = (messageCount === 0);
        const isRefreshTurn = (messageCount > 0 && (messageCount % 10 === 0 || messageCount % 10 === 1));

        // 2. 최근 대화 로그 불러오기 (최근 10개)
        const prevMessages = await Message.find({ scenarioId })
            .sort({ createdAt: -1 })
            .limit(5);
        const history = prevMessages.reverse()
        .filter(msg => !msg.content.startsWith('data:image') && !msg.content.startsWith('http'))
        .map(msg => ({
            role: msg.role,
            content: msg.content
        }));

        // 3. 상황 요약본(Snapshot) 만들기 - 세계관, 퀘스트, 인벤토리 합치기
        let currentQuests = scenario.quests.size > 0 
            ? Array.from(scenario.quests.entries()).map(([k, v]) => `${k}(${v})`).join(', ') 
            : "없음";
        
        const statusSnapshot = `
            [현재 상황 요약]
            - 세계관: ${scenario.worldSetting}
            - 캐릭터: ${scenario.characterInfo}
            - 주요 사건: ${scenario.questLines.join(' -> ') || '없음'}
            - 진행중인 퀘스트: ${currentQuests}
            - 보유 아이템: ${scenario.inventory.join(', ') || '없음'}`;

        // 4. 시스템 지시문 (매우 짧게 유지하여 크레딧 절약)
        const systemMessage = { 
            role: "system", 
            content: `"당신은 TRPG 마스터입니다.몰입감 있게 한국어로 대답하세요. 새로운 중요 사건이 발생했다면 답변 끝에 [요약: 사건내용] 형식으로 딱 한 줄만 추가.퀘스트 변동/생성은 [퀘스트: 이름 | 내용] 형식으로 답변 끝에 추가-퀘스트 생성/변동 시 끝에 [퀘스트: 이름 | 내용] 추가.-퀘스트가 완료되었다면 답변 끝에 [완료: 퀘스트이름] 형식을 반드시 추가.-새로운 아이템을 획득하면 답변 끝에 [아이템: 아이템명]을 추가.`
        };

        // 5. AI에게 보낼 메시지 조립
        let finalMessages = [systemMessage];

        if (isFirstMessage) {
            // [첫 시작] 시나리오 내용을 유저 메시지처럼 위장해서 던짐 -> 웅장한 오프닝 유도
            finalMessages.push({ 
                role: "user", 
                content: `[모험 시작] 아래 설정을 바탕으로 오프닝 서술을 시작해줘. \n${statusSnapshot}` 
            });
            console.log("🎬 [시스템] 시나리오 기반 오프닝을 시작합니다.");
        } else {
            // [평소] 10번마다 한 번씩 대화 로그 맨 앞에 상황 요약본 주입
            if (isRefreshTurn) {
                finalMessages.push({ role: "user", content: `(마스터, 상황 복습: ${statusSnapshot})` });
                console.log("📝 [시스템] 10턴 주기가 되어 기억을 새로고침합니다.");
            }
            // 기존 대화 기록 합치기
            finalMessages = finalMessages.concat(history);
            // 현재 유저가 입력한 메시지 추가
            finalMessages.push({ role: "user", content: userMessage || "계임을 계속해줘." });
        }

        console.log(JSON.stringify(finalMessages, null, 2));
        // 6. AI 호출
        const targetModel = model || "gpt-5.4-mini";
        const response = await openai.chat.completions.create({
            model: targetModel,
            messages: finalMessages,
            max_tokens: 1000,
            temperature: 0.8
        });

        // 7. 토큰 및 크레딧 로그 출력
        const usage = response.usage;
        console.log("-----------------------------------------");
        console.log(`📊 사용 모델: ${targetModel} (총 메시지 수: ${messageCount})`);
        console.log(`- Prompt: ${usage.prompt_tokens} / Completion: ${usage.completion_tokens}`);
        console.log(`- Total: ${usage.total_tokens}`);
        if (usage.total_credits) console.log(`- 소모 크레딧: ${usage.total_credits} CR`);
        console.log("-----------------------------------------");

        const aiReply = response.choices[0].message.content;

        // 8. DB 저장 (유저 메시지와 AI 응답 저장)
        if (!isFirstMessage) {
            await Message.create({ scenarioId, role: 'user', content: userMessage });
        }
        await Message.create({ scenarioId, role: 'assistant', content: aiReply });

        // 9. 데이터 추출 (퀘스트, 아이템, 요약 등)
        const questMatches = aiReply.matchAll(/\[퀘스트: (.*?) \| (.*?)\]/g);
        const eventMatch = aiReply.match(/\[요약: (.*?)\]/);
        const completedMatches = aiReply.matchAll(/\[완료: (.*?)\]/g);
        const itemMatch = aiReply.match(/\[아이템: (.*?)\]/);

        let isUpdated = false;
        if (itemMatch) {
            const newItem = itemMatch[1].trim();
            if (!scenario.inventory.includes(newItem)) {
                scenario.inventory.push(newItem);
                isUpdated = true;
            }
        }
        for (const match of questMatches) {
            scenario.quests.set(match[1].trim(), match[2].trim());
            isUpdated = true;
        }
        for (const match of completedMatches) {
            const qName = match[1].trim();
            if (scenario.quests.has(qName)) {
                const currentContent = scenario.quests.get(qName);
                if (!currentContent.startsWith('✅')) {
                    scenario.quests.set(qName, `✅ 완료됨: ${currentContent}`);
                    isUpdated = true;
                }
            }
        }
        if (eventMatch) {
            scenario.questLines.push(eventMatch[1].trim());
            isUpdated = true;
        }

        if (isUpdated) {
        await Scenario.findByIdAndUpdate(scenarioId, {
        $set: { 
            quests: scenario.quests, 
            inventory: scenario.inventory,
            questLines: scenario.questLines 
        }
    });
        }

        // 10. 클라이언트에 응답 (태그 제거)
        const cleanReply = aiReply.replace(/\[.*?\]/g, "").trim();
        return res.json({ 
            reply: cleanReply, 
            questLines: scenario.questLines,
            quests: Object.fromEntries(scenario.quests),
            inventory: scenario.inventory
        });

    } catch (error) {
        console.error("❌ 에러 발생:", error.message);
        if (!res.headersSent) res.status(500).send("서버 에러");
    }
});
// [추가] 시나리오의 이전 대화 로그 불러오기 API
// [✅ 백엔드 수정] 


// [추가] 시나리오의 대화 로그 초기화(삭제) API
// server.js의 삭제 API
app.delete('/api/scenarios/:id', async (req, res) => {
    try {
        if (!req.user) return res.status(401).send("로그인이 필요합니다.");
        const scenarioId = req.params.id;

        // 1. 시나리오 삭제
        const deletedScenario = await Scenario.findOneAndDelete({ 
            _id: scenarioId, 
            userId: req.user._id 
        });

        if (!deletedScenario) return res.status(404).send("삭제 권한이 없습니다.");

        // 2. 연결된 메시지들도 삭제
        await Message.deleteMany({ scenarioId: scenarioId });

        res.status(200).send("삭제 성공");
    } catch (error) {
        res.status(500).send("삭제 실패: " + error.message);
    }
});
app.delete('/api/chat/:scenarioId', async (req, res) => {
    try {
        const { scenarioId } = req.params;
        await Message.deleteMany({ scenarioId }); // 메시지만 삭제
        await Scenario.findByIdAndUpdate(scenarioId, {
            $set: { questLines: [], quests: {} , inventory: []} // 퀘스트 기록도 초기화
        });
        res.send("초기화 완료");
    } catch (err) { res.status(500).send(err.message); }
});

app.post('/api/generate-image', async (req, res) => {
    try {
        const { scenarioId } = req.body;
        const scenario = await Scenario.findById(scenarioId);
        if (!scenario) return res.status(404).send("시나리오 없음");

        // ✅ 1. 진짜 팩트챗 클라우드 주소
        const SCH_GATEWAY_URL = "https://factchat-cloud.mindlogic.ai/v1/gateway/images/generate/";
        const apiKey = process.env.OPENAI_API_KEY;

        // ✅ 2. [풍부한 프롬프트 조립]
        // 세계관 배경 정보(worldSetting)와 지금까지의 주요 사건들(questLines)을 합칩니다.
        const worldContext = scenario.worldSetting; 
        const recentEvents = scenario.questLines.length > 0 
            ? scenario.questLines.slice(-3).join('. ') // 최근 3개 사건만 가져와서 문맥 연결
            : "모험이 막 시작된 상황";

        // AI가 상황을 한 장의 삽화로 묘사할 수 있게 문장을 만듭니다.
        const richPrompt = `배경 세계관: ${worldContext}. 현재 벌어지고 있는 구체적인 상황: ${recentEvents}. 위 상황을 묘사하는 삽화를 그려줘.`;

        console.log(`🎨 [그림 생성 요청 전체 내용]: ${richPrompt}`);

        // ✅ 3. 학교 API 규격에 맞춰 전송
        const response = await fetch(SCH_GATEWAY_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                "model": "gemini-2.5-flash-image",
                "prompt": richPrompt, // 👈 배경과 사건이 합쳐진 풍부한 묘사문
                "response_format": "url"
            })
        });

        

        const responseText = await response.text();
        if (!response.ok) {
            return res.status(response.status).send(responseText);
        }

        const data = JSON.parse(responseText);

        
        // ✅ [수정] url로 오든 b64_json으로 오든 다 잡아냅니다.
        let extractedImage = (data.data && data.data[0] && (data.data[0].url || data.data[0].b64_json)) || data.url || data.b64_json;

        if (extractedImage) {
            // ✅ [수정] 만약 짧은 http 링크가 아니라면, HTML이 바로 인식할 수 있는 형태로 조립합니다.
            if (!extractedImage.startsWith('http') && !extractedImage.startsWith('data:image')) {
                extractedImage = `data:image/png;base64,${extractedImage}`;
            }

            console.log("✅ 이미지 생성 및 데이터 파싱 완료!");
            // 프론트엔드로 조립된 데이터를 보냅니다.
            res.json({ imageUrl: extractedImage });
        } else {
            throw new Error("이미지 URL 또는 데이터 추출 실패");
        }

    } catch (error) {
        console.error("❌ 이미지 생성 실패:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// [추가] 생성된 이미지 URL을 DB에 저장하는 API
app.post('/api/chat/save-image', async (req, res) => {
    try {
        const { scenarioId, role, content } = req.body;
        // 채팅 저장과 동일하게 Message 모델을 사용합니다 [cite: 7, 1325]
        await Message.create({
            scenarioId,
            role: role || 'assistant',
            content: content // 이미지 URL 주소가 들어갑니다
        });
        res.json({ success: true });
    } catch (err) {
        console.error("❌ 이미지 저장 실패:", err);
        res.status(500).send("이미지 저장 중 오류 발생");
    }
});




// 9. 서버 실행
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log("-----------------------------------------");
    console.log(`서버 실행 중: http://localhost:${PORT}`);
    console.log("-----------------------------------------");
});