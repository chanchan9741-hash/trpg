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
    currentLocation: { type: String, default: '시작 지점' },
    discoveredLocations: { type: [String], default: ['시작 지점'] },
    hp: { type: Number, default: 100 },
    maxHp: { type: Number, default: 100 },
    gold: { type: Number, default: 0 },
    skills: { type: [String], default: ['기본 공격'] },
    playerImageUrl: { type: String, default: null },
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

        // 1. 현재까지의 메시지 개수 확인 및 요약 주기 판정
        const messageCount = await Message.countDocuments({ scenarioId });
        const isFirstMessage = (messageCount === 0);
        const shouldSummarize = (messageCount + 1) % 5 === 0;
        const isRefreshTurn = (messageCount > 0 && (messageCount % 10 === 0 || messageCount % 10 === 1));

        // 2. 주사위 판정 로직
        const actionKeywords = ["공격", "조사", "열기", "설득", "훔치기", "사용", "회피", "방어"];
        const isAction = userMessage && actionKeywords.some(k => userMessage.includes(k));
        let diceResultText = "";
        let diceRoll = 0;

        if (isAction) {
            diceRoll = Math.floor(Math.random() * 20) + 1;
            let success = diceRoll >= 10 ? "성공" : "실패";
            if (diceRoll === 20) success = "대성공(크리티컬!)";
            if (diceRoll === 1) success = "대실패(펌블!)";
            diceResultText = `\n[판정 시스템: 플레이어 행동 시도. 주사위 결과: ${diceRoll} (${success}). 이 결과를 바탕으로 묘사하세요.]`;
        }

        // 3. 상황 요약본(Snapshot) 생성 (상태창 정보 추가됨!)
        let currentQuests = scenario.quests.size > 0 
            ? Array.from(scenario.quests.entries()).map(([k, v]) => `${k}(${v})`).join(', ') 
            : "없음";
        
        const statusSnapshot = `
            [현재 상황 요약]
            - 세계관: ${scenario.worldSetting}
            - 캐릭터: ${scenario.characterInfo}
            - 주요 사건: ${scenario.questLines.join(' -> ') || '없음'}
            - 현재 위치: ${scenario.currentLocation || '시작 지점'}
            - 발견한 지역: ${scenario.discoveredLocations && scenario.discoveredLocations.length > 0 ? scenario.discoveredLocations.join(', ') : '없음'}
            - 진행중인 퀘스트: ${currentQuests}
            - 보유 아이템: ${scenario.inventory.join(', ') || '없음'}
            - 체력: ${scenario.hp || 100} / ${scenario.maxHp || 100}
            - 금화: ${scenario.gold || 0} G
            - 보유 스킬: ${(scenario.skills || ['기본 공격']).join(', ')}`;

        // 4. 시스템 지시문 (상태창 조작 태그 추가)
        const systemInstruction = `당신은 TRPG 마스터입니다. 몰입감 있게 한국어로 대답하세요.
        ${shouldSummarize ? "중요: 현재까지 5턴의 대화가 진행되었습니다. 답변 끝에 [요약: 내용] 내용에 지난 5턴간의 주요 사건을 정리한 문장을 넣어 반드시 추가하세요." : ""}
        
        [시스템 태그 사용법 - 변화가 있을 때만 대답 맨 끝에 추가하세요]
        - 퀘스트 생성/변동: [퀘스트: 이름 | 내용]
        - 퀘스트 완료: [완료: 퀘스트이름]
        - 아이템 획득: [아이템: 아이템명]
        - 장소 이동: [이동: 새로운 장소명]
        - 체력 증감 시: [체력: 남은체력숫자] (예: 플레이어가 맞아 체력이 80이 되면 [체력: 80])
        - 최대 체력 증가 시: [최대체력: 숫자] (예: 레벨업 시 [최대체력: 120])
        - 금화 획득/소비 시: [금화: 변경된총금화] (예: 50골드를 얻어 총 150이 되면 [금화: 150])
        - 스킬 획득 시: [스킬추가: 스킬명]
        `;

        const systemMessage = { 
            role: "system", 
            content: systemInstruction + "\n" + statusSnapshot + (diceResultText || "")
        };

        // 5. 최근 대화 로그 불러오기
        const prevMessages = await Message.find({ scenarioId }).sort({ createdAt: -1 }).limit(5);
        const history = prevMessages.reverse()
            .filter(msg => msg.content && !msg.content.startsWith('data:image') && !msg.content.startsWith('http'))
            .map(msg => ({ role: msg.role, content: msg.content }));

        // 6. AI에게 보낼 메시지 조립
        let finalMessages = [systemMessage];
        if (isFirstMessage) {
            finalMessages.push({ 
                role: "user", 
                content: `[모험 시작] 아래 설정을 바탕으로 오프닝을 시작해줘.\n${statusSnapshot}` 
            });
        } else {
            if (isRefreshTurn) {
                finalMessages.push({ role: "user", content: `(마스터, 상황 복습: ${statusSnapshot})` });
            }
            finalMessages = finalMessages.concat(history);
            finalMessages.push({ role: "user", content: userMessage || "게임을 계속해줘." });
        }

        console.log("\n================ [🤖 AI 호출 프롬프트] ================");
        console.log(`순번: ${messageCount + 1} / 주사위: ${diceRoll || '없음'} / 요약요청: ${shouldSummarize}`);

        // 7. AI 호출
        const targetModel = model || "gpt-4o-mini";
        const response = await openai.chat.completions.create({
            model: targetModel,
            messages: finalMessages,
            max_tokens: 1000,
            temperature: 0.8
        });

        // 8. 응답 처리 및 주사위 표시
        let rawReply = response.choices[0].message.content;
        let aiReplyWithDice = isAction ? `🎲 주사위 판정: ${diceRoll}\n\n${rawReply}` : rawReply;

        // 9. 대화 DB 저장
        if (!isFirstMessage && userMessage) {
            await Message.create({ scenarioId, role: 'user', content: userMessage });
        }
        await Message.create({ scenarioId, role: 'assistant', content: aiReplyWithDice });

        // 10. AI 응답에서 데이터 추출 (상태창 데이터 파싱 추가!)
        const questMatches = Array.from(rawReply.matchAll(/\[퀘스트: (.*?) \| (.*?)\]/g));
        const eventMatch = rawReply.match(/\[요약: (.*?)\]/);
        const completedMatches = Array.from(rawReply.matchAll(/\[완료: (.*?)\]/g));
        const itemMatch = rawReply.match(/\[아이템: (.*?)\]/);
        const locationMatch = rawReply.match(/\[이동: (.*?)\]/);
        
        const hpMatch = rawReply.match(/\[체력:\s*(\d+)\]/);
        const maxHpMatch = rawReply.match(/\[최대체력:\s*(\d+)\]/);
        const goldMatch = rawReply.match(/\[금화:\s*(\d+)\]/);
        const skillMatch = rawReply.match(/\[스킬추가:\s*(.*?)\]/);

        let isUpdated = false;

        if (locationMatch) {
            const newLocation = locationMatch[1].trim();
            scenario.currentLocation = newLocation;
            if (!scenario.discoveredLocations) scenario.discoveredLocations = [];
            if (!scenario.discoveredLocations.includes(newLocation)) {
                scenario.discoveredLocations.push(newLocation);
            }
            isUpdated = true;
        }

        if (itemMatch) {
            const newItem = itemMatch[1].trim();
            if (!scenario.inventory.includes(newItem)) {
                scenario.inventory.push(newItem);
                isUpdated = true;
            }
        }

        // --- 새로 추가된 상태창 업데이트 로직 ---
        if (hpMatch) {
            scenario.hp = parseInt(hpMatch[1], 10);
            isUpdated = true;
        }
        if (maxHpMatch) {
            scenario.maxHp = parseInt(maxHpMatch[1], 10);
            isUpdated = true;
        }
        if (goldMatch) {
            scenario.gold = parseInt(goldMatch[1], 10);
            isUpdated = true;
        }
        if (skillMatch) {
            const newSkill = skillMatch[1].trim();
            if (!scenario.skills) scenario.skills = ['기본 공격'];
            if (!scenario.skills.includes(newSkill)) {
                scenario.skills.push(newSkill);
                isUpdated = true;
            }
        }
        // ------------------------------------

        questMatches.forEach(m => {
            scenario.quests.set(m[1].trim(), m[2].trim());
            isUpdated = true;
        });
        
        completedMatches.forEach(m => {
            const qName = m[1].trim();
            if (scenario.quests.has(qName)) {
                const content = scenario.quests.get(qName);
                if (!content.startsWith('✅')) {
                    scenario.quests.set(qName, `✅ 완료됨: ${content}`);
                    isUpdated = true;
                }
            }
        });
        
        if (eventMatch) {
            scenario.questLines.push(eventMatch[1].trim());
            isUpdated = true;
        }

        // DB 최종 업데이트 (중복되어 있던 코드 하나로 합침)
        if (isUpdated) {
            await Scenario.findByIdAndUpdate(scenarioId, {
                $set: { 
                    quests: scenario.quests, 
                    inventory: scenario.inventory,
                    questLines: scenario.questLines,
                    currentLocation: scenario.currentLocation,
                    discoveredLocations: scenario.discoveredLocations,
                    hp: scenario.hp,
                    maxHp: scenario.maxHp,
                    gold: scenario.gold,
                    skills: scenario.skills
                }
            });
        }

        // 11. 클라이언트에 보낼 때 시스템 태그 싹 다 지우기 (정규식 업데이트)
        const cleanReply = aiReplyWithDice.replace(/\[(요약|퀘스트|완료|아이템|이동|체력|최대체력|금화|스킬추가): .*?\]/g, "").trim();
        
        // 💡 에러났던 부분 수정 완료! (discoveredLocations 뒤에 쉼표 추가)
        return res.json({ 
            reply: cleanReply, 
            diceValue: diceRoll,
            questLines: scenario.questLines,
            quests: Object.fromEntries(scenario.quests),
            inventory: scenario.inventory,
            currentLocation: scenario.currentLocation, 
            discoveredLocations: scenario.discoveredLocations, 
            hp: scenario.hp !== undefined ? scenario.hp : 100,
            maxHp: scenario.maxHp !== undefined ? scenario.maxHp : 100,
            gold: scenario.gold !== undefined ? scenario.gold : 0,
            playerImageUrl: scenario.playerImageUrl,
            skills: scenario.skills || ['기본 공격']
        });

    } catch (error) {
        console.error("❌ 에러 발생:", error);
        if (!res.headersSent) res.status(500).send("서버 에러: " + error.message);
    }
});


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
        
        await Message.deleteMany({ scenarioId }); // 메시지 전체 삭제
        
        // 💡 퀘스트, 가방뿐만 아니라 상태창과 지도 데이터도 기본값으로 덮어씌웁니다!
        await Scenario.findByIdAndUpdate(scenarioId, {
            $set: { 
                questLines: [], 
                quests: {}, 
                inventory: [],
                hp: 100,                     // 체력 100으로 리셋
                maxHp: 100,                  // 최대 체력도 100으로 리셋
                gold: 0,                     // 금화 0으로 탕진
                skills: ['기본 공격'],         // 스킬 초기화
                currentLocation: "시작 지점",  // 장소 초기화
                discoveredLocations: []      // 발견한 지역 초기화
            } 
        });
        
        res.send("초기화 완료");
    } catch (err) { 
        res.status(500).send(err.message); 
    }
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
        const characterInfo = scenario.characterInfo;
        const worldContext = scenario.worldSetting; 
        const recentEvents = scenario.questLines.length > 0 
            ? scenario.questLines.slice(-3).join('. ') // 최근 3개 사건만 가져와서 문맥 연결
            : "모험이 막 시작된 상황";

        // AI가 상황을 한 장의 삽화로 묘사할 수 있게 문장을 만듭니다.
        const richPrompt = `캐릭터 설정 : ${characterInfo}배경 세계관: ${worldContext}. 현재 벌어지고 있는 구체적인 상황: ${recentEvents}. 위 상황을 묘사하는 삽화를 아니메 스타일로 그려줘.`;

        console.log(`🎨 [그림 생성 요청 전체 내용]: ${richPrompt}`);

        // ✅ 3. 학교 API 규격에 맞춰 전송
        const response = await fetch(SCH_GATEWAY_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                "model": "gpt-image-1.5",
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

// 🖼️ 플레이어 초상화 생성 API (팩트챗 클라우드 호환 버전)
app.post('/api/generate-player-image', async (req, res) => {
    try {
        const { scenarioId } = req.body;
        const scenario = await Scenario.findById(scenarioId);
        
        if (!scenario || !scenario.characterInfo) {
            return res.status(404).json({ error: "시나리오 또는 주인공 설정이 없습니다." });
        }

        // ✅ 1. 진짜 팩트챗 클라우드 주소 (기존 성공 코드 적용)
        const SCH_GATEWAY_URL = "https://factchat-cloud.mindlogic.ai/v1/gateway/images/generate/";
        const apiKey = process.env.OPENAI_API_KEY;

        // ✅ 2. 주인공 설정을 바탕으로 프롬프트 조립
        const characterInfo = scenario.characterInfo;
        const imagePrompt = `다음 캐릭터 설정을 바탕으로 플레이어 초상화(얼굴 위주의 프로필 일러스트)를 애니메 스타일로 1장 그려줘. 설정: ${characterInfo}`;

        console.log(`\n================ [🖼️ 플레이어 사진 생성 요청] ================`);
        console.log(`요청 프롬프트: ${imagePrompt}`);

        // ✅ 3. 학교 API 규격에 맞춰 전송
        const response = await fetch(SCH_GATEWAY_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                "model": "gpt-image-1.5", // 성공했던 모델명 그대로 사용
                "prompt": imagePrompt,
                "response_format": "url"
            })
        });

        const responseText = await response.text();
        if (!response.ok) {
            return res.status(response.status).json({ error: responseText });
        }

        const data = JSON.parse(responseText);

        // ✅ 4. 이미지 데이터 추출 (URL 또는 Base64 파싱)
        let extractedImage = (data.data && data.data[0] && (data.data[0].url || data.data[0].b64_json)) || data.url || data.b64_json;

        if (extractedImage) {
            // 짧은 문자가 왔을 경우 Base64 이미지로 조립
            if (!extractedImage.startsWith('http') && !extractedImage.startsWith('data:image')) {
                extractedImage = `data:image/png;base64,${extractedImage}`;
            }

            // ✅ 5. DB에 저장 및 프론트엔드로 전송
            scenario.playerImageUrl = extractedImage;
            await scenario.save();

            console.log("✅ 플레이어 초상화 생성 및 저장 완료!");
            res.json({ playerImageUrl: extractedImage }); // 프론트로 전달
        } else {
            throw new Error("이미지 URL 또는 데이터 추출 실패");
        }

    } catch (error) {
        console.error("❌ 초상화 생성 실패:", error.message);
        res.status(500).json({ error: error.message });
    }
});




// 9. 서버 실행
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log("-----------------------------------------");
    console.log(`서버 실행 중: http://localhost:${PORT}`);
    console.log("-----------------------------------------");
});