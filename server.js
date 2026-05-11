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
    inventory: { type: Map, of: Number, default: {} }, // 아이템 리스트 추가
    currentLocation: { type: String, default: '시작 지점' },
    discoveredLocations: { type: [String], default: ['시작 지점'] },
    hp: { type: Number, default: 100 },
    maxHp: { type: Number, default: 100 },
    gold: { type: Number, default: 0 },
    skills: { type: [String], default: ['기본 공격'] },
    playerImageUrl: { type: String, default: null },
    equipment: { 
    type: Map, 
    of: String, 
    default: { "투구": "없음", "갑옷": "없음", "상의": "없음", "하의": "없음", "악세사리": "없음", "무기": "없음" },
    characters: { type: Map, of: String, default: {} }
},
    createdAt: { type: Date, default: Date.now },
    appearance: { type: String, default: "" },                                   // 👈 추가
    artStyle: { type: String, default: "고품질의 다크 판타지 유화 스타일, 걸작" }, // 👈 추가
    bestiary: { type: Map, of: mongoose.Schema.Types.Mixed, default: {} },
    currentEnemy: { type: mongoose.Schema.Types.Mixed, default: null },
    
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

// ⚔️ 전투 팝업창 HTML을 제공하는 라우터 추가
app.get('/combat.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'combat.html'));
});

// 6. 페이지 라우트
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/create', (req, res) => req.user ? res.sendFile(__dirname + '/create.html') : res.redirect('/auth/google'));
// ✅ 시나리오 수정 전용 페이지 접속
app.get('/edit/:id', (req, res) => {
    // 로그인 안 한 유저는 메인으로 돌려보냄
    if (!req.user) return res.redirect('/');
    // edit.html 파일 전송
    res.sendFile(__dirname + '/edit.html'); 
});
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

        // 💡 몽고DB의 Map 데이터를 일반적인 { key: value } 객체로 변환해서 보냅니다.
        const scenarioData = scenario.toObject(); // 먼저 전체 데이터를 일반 객체로 변환
        
        res.json({
            ...scenarioData,
            quests: scenario.quests ? Object.fromEntries(scenario.quests.entries()) : {},
            inventory: scenario.inventory ? Object.fromEntries(scenario.inventory.entries()) : {},
            playerImageUrl: scenario.playerImageUrl || null,
            equipment: scenario.equipment ? Object.fromEntries(scenario.equipment.entries()) : { "무기": "없음", "방어구": "없음", "장신구": "없음" },
            bestiary: (scenario.bestiary && typeof scenario.bestiary.entries === 'function') ? Object.fromEntries(scenario.bestiary.entries()) : (scenario.bestiary || {}),
            
            currentEnemy: scenario.currentEnemy || null
        });
    } catch (err) {
        console.error("시나리오 로드 에러:", err);
        res.status(500).send(err.message);
    }
});


app.post('/api/scenarios', async (req, res) => {
    if (!req.user) return res.status(401).send("Unauthorized");
    
    const newScenario = new Scenario({
        userId: req.user._id,
        title: req.body.title,
        worldSetting: req.body.worldSetting,
        characterInfo: req.body.characterInfo,
        appearance: req.body.appearance,  // 👈 추가: 프론트에서 보낸 외형 데이터
        artStyle: req.body.artStyle       // 👈 추가: 프론트에서 보낸 화풍 데이터
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
        

        let equipEntries = scenario.equipment 
            ? Array.from(scenario.equipment.entries()) 
            : Object.entries({ "무기": "없음", "방어구": "없음", "장신구": "없음" });
            
        let invEntries = Array.from(scenario.inventory.entries());
        let currentInvString = invEntries.length > 0 
            ? invEntries.map(([k, v]) => `${k}(${v}개)`).join(', ') 
            : "비어 있음";
            
        
        let currentEquipString = "무기(없음), 방어구(없음), 장신구(없음)";
        if (scenario.equipment && scenario.equipment.size > 0) {
            currentEquipString = Array.from(scenario.equipment.entries()).map(([k, v]) => `${k}(${v})`).join(', ');
        }

// 💡 1. DB에서 도감 데이터를 가져옵니다.
        const currentBestiary = scenario.bestiary ? Object.fromEntries(scenario.bestiary.entries()) : {};
        
        // 💡 2. AI가 읽을 수 있도록 도감의 '상세 스펙'을 예쁘게 정리합니다.
        const bestiaryDetails = Object.entries(currentBestiary).map(([name, stats]) => 
            `- ${name} (HP: ${stats.hp}, 공격력: ${stats.attack}, 방어력: ${stats.defense}, 전리품: ${stats.loot || '없음'}, 드랍: ${stats.gold || 0}G)`
        ).join('\n');

        
        
        const statusSnapshot = `
            [현재 상황 요약]
            - 세계관: ${scenario.worldSetting}
            - 캐릭터: ${scenario.characterInfo}
            - 주요 사건: ${scenario.questLines.join(' -> ') || '없음'}
            - 현재 위치: ${scenario.currentLocation || '시작 지점'}
            - 발견한 지역: ${scenario.discoveredLocations && scenario.discoveredLocations.length > 0 ? scenario.discoveredLocations.join(', ') : '없음'}
            - 진행중인 퀘스트: ${currentQuests}
            - 보유 아이템: ${currentInvString}
            - 체력: ${scenario.hp || 100} / ${scenario.maxHp || 100}
            - 착용 장비: ${currentEquipString}
            - 금화: ${scenario.gold || 0} G
            - 보유 스킬 (${(scenario.skills || []).length}/4개): ${(scenario.skills && scenario.skills.length > 0 ? scenario.skills.join(', ') : '없음')}`;

        const combatInfo = scenario.currentEnemy 
            ? `[현재 전투 중!] 적: ${scenario.currentEnemy.name} (남은 체력: ${scenario.currentEnemy.hp}/${scenario.currentEnemy.maxHp}, 공격력: ${scenario.currentEnemy.attack}, 방어력: ${scenario.currentEnemy.defense})` 
            : `[평시 상태] 현재 세계관에 존재하는 몬스터 도감 상세 정보:\n${bestiaryDetails}`;

// 4. 시스템 지시문 (아이템 획득 및 장비 태그 규칙 강화)
        const systemInstruction = `당신은 TRPG 마스터입니다. 몰입감 있게 한국어로 대답하세요.
        ${shouldSummarize ? "중요: 현재까지 5턴의 대화가 진행되었습니다. 답변 끝에 [요약: 내용] 내용에 지난 5턴간의 주요 사건을 정리한 문장을 넣어 반드시 추가하세요." : ""}
        
        [시스템 태그 사용법 - 변화가 있을 때만 대답 맨 끝에 추가하세요]
        - 퀘스트 생성/변동: [퀘스트: 이름 | 내용]
        - 퀘스트 완료: [완료: 퀘스트이름]
        - 아이템 획득 시: [아이템획득: [장비부위] 아이템명(능력치, 가격)|수량] 
          (장비부위는 투구, 갑옷, 상의, 하의, 악세사리, 무기 중 택1. 소모품은 부위 생략) 
          (예: [아이템획득: [무기] 롱소드(공격+10, 100G)|1], [아이템획득: 체력 포션(회복+20, 10G)|3])
        - 아이템 소모/사용 시: [아이템소모: 아이템명|수량]
        - 장소 이동: [이동: 새로운 장소명]
        - 체력 증감 시: [체력: 남은체력숫자]
        - 최대 체력 증가 시: [최대체력: 숫자]
        - 금화 획득/소비 시: [금화: 변경된총금화]
        - 스킬 획득 시: [스킬추가: 스킬명]
        - 플레이어가 기술을 배울 때: [스킬획득: 스킬명(숫자)] (예: [스킬획득: 파이어볼(30)]) - 숫자는 데미지
        - 기존 스킬을 지울 때: [스킬삭제: 지울스킬명] (예: [스킬삭제: 파이어볼])
        - 새로운 몬스터 등장 시 도감에 등록: [도감등록: 몬스터명|체력|공격력|방어력|전리품명|드랍금화]
          (예: [도감등록: 다이어 울프|40|12|3|늑대 가죽|15])
          (🚨주의: 전투를 시작하기 전, 현재 도감 목록에 없는 새로운 적이라면 반드시 이 태그로 먼저 도감에 등록하세요.)
        - (🚨매우 중요: 플레이어는 스킬을 최대 '4개'까지만 가질 수 있습니다. 4개가 꽉 찼는데 새 스킬을 배우려 한다면, 반드시 기존 스킬 중 하나를 잊어야 한다고 경고하고, 어떤 스킬을 지울지 물어보세요. 플레이어가 지울 스킬을 선택하면 대답 끝에 [스킬삭제: 기존스킬명]과 [스킬획득: 새스킬명(숫자)]를 같이 적어주세요.)
        ${combatInfo}
        
        [⚔️ 전투 전용 태그 규칙 - 반드시 지키세요]
        - 전투 시작 시: [전투시작: 몬스터명] (반드시 도감에 있는 몬스터만 스폰하세요)
        - 전투 중 적 피해 발생 시: [적체력: 남은체력숫자] (직접 계산해서 남은 체력을 적으세요)
        - 적 사망 시: [전투종료] 태그를 적고, 도감을 참고하여 적절한 [아이템획득: ...]과 [금화: ...] 태그로 전리품을 반드시 지급하세요.
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
        console.log(finalMessages);

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

let isUpdated = false;

        // ---------------------------------------------------------
        // ✨ 1. 도감 등록을 무조건 '전투 시작'보다 먼저 처리합니다!
        // ---------------------------------------------------------
        const bestiaryAddMatches = Array.from(rawReply.matchAll(/\[도감등록:\s*([^|\]]+)\|\s*([^|\]]+)\|\s*([^|\]]+)\|\s*([^|\]]+)\|\s*([^|\]]+)\|\s*([^\]]+)\]/g));
        
        if (bestiaryAddMatches.length > 0) {
            if (!scenario.bestiary || typeof scenario.bestiary.set !== 'function') {
                scenario.bestiary = new Map(Object.entries(scenario.bestiary || {}));
            }
            
            bestiaryAddMatches.forEach(m => {
                const name = m[1].trim();
                const hp = parseInt(m[2].replace(/[^0-9]/g, ''), 10) || 10;
                const attack = parseInt(m[3].replace(/[^0-9]/g, ''), 10) || 1;
                const defense = parseInt(m[4].replace(/[^0-9]/g, ''), 10) || 0;
                const loot = m[5].trim();
                const gold = parseInt(m[6].replace(/[^0-9]/g, ''), 10) || 0;

                scenario.bestiary.set(name, { hp, attack, defense, loot, gold });
                
                // 🚨 방금 만든 몬스터를 시스템이 '이번 턴'에 바로 알아볼 수 있게 즉시 추가!
                currentBestiary[name] = { hp, attack, defense, loot, gold }; 
                console.log(`📖 시스템: 도감 몬스터 [${name}] 저장 성공!`);
            });
            
            scenario.markModified('bestiary'); 
            isUpdated = true;
        }

        // ---------------------------------------------------------
        // ⚔️ 2. 도감 업데이트가 끝난 후 전투 시작을 검사합니다!
        // ---------------------------------------------------------
        const combatStartMatch = rawReply.match(/\[전투시작:\s*(.*?)\]/);
        if (combatStartMatch) {
            const enemyName = combatStartMatch[1].trim();
            if (currentBestiary[enemyName]) {
                scenario.currentEnemy = { ...currentBestiary[enemyName], name: enemyName, maxHp: currentBestiary[enemyName].hp };
                isUpdated = true;
                console.log(`⚔️ 시스템: [${enemyName}] 와(과)의 전투가 시작되었습니다!`);
            } else {
                console.log(`⚠️ 시스템 방어: 도감에 없는 몬스터(${enemyName})와 전투를 시도하여 무시했습니다.`);
            }
        }

        // ⚔️ 3. 전투 중 체력 갱신 및 전투 종료 파싱
        const enemyHpMatch = rawReply.match(/\[적체력:\s*(\d+)\]/);
        if (enemyHpMatch && scenario.currentEnemy) {
            scenario.currentEnemy.hp = parseInt(enemyHpMatch[1], 10);
            isUpdated = true;
        }

        if (rawReply.includes("[전투종료]") || (scenario.currentEnemy && scenario.currentEnemy.hp <= 0)) {
            scenario.currentEnemy = null; 
            isUpdated = true;
        }

        // 9. 대화 DB 저장
        if (!isFirstMessage && userMessage) {
            await Message.create({ scenarioId, role: 'user', content: userMessage });
        }
        await Message.create({ scenarioId, role: 'assistant', content: aiReplyWithDice });

 // 10. AI 응답에서 데이터 추출 (상태창 데이터 파싱 추가!)
        const questMatches = Array.from(rawReply.matchAll(/\[퀘스트: (.*?) \| (.*?)\]/g));
        const eventMatch = rawReply.match(/\[요약: (.*?)\]/);
        const completedMatches = Array.from(rawReply.matchAll(/\[완료: (.*?)\]/g));
        const locationMatch = rawReply.match(/\[이동: (.*?)\]/);
        const equipMatches = Array.from(rawReply.matchAll(/\[장비착용:\s*([^|\]]+)\s*\|\s*((?:\[[^\]]*\])?[^\]]+)\]/g));
        const hpMatch = rawReply.match(/\[체력:\s*(\d+)\]/);
        const maxHpMatch = rawReply.match(/\[최대체력:\s*(\d+)\]/);
        const goldMatch = rawReply.match(/\[금화:\s*(\d+)\]/);
        



        
// ✨ 스킬 삭제 처리 ([스킬삭제: 파이어볼] 태그 인식)
        const skillRemoveMatch = rawReply.match(/\[스킬삭제:\s*(.+?)\]/g);
        if (skillRemoveMatch && scenario.skills) {
            skillRemoveMatch.forEach(tag => {
                const rawSkillName = tag.match(/\[스킬삭제:\s*(.+?)\]/)[1].trim();
                const searchName = rawSkillName.split('(')[0].trim(); // "파이어볼"만 추출
                
                // 이름이 일치하는 스킬을 찾아서 삭제합니다.
                const idx = scenario.skills.findIndex(s => s.startsWith(searchName));
                if (idx !== -1) {
                    const removedSkill = scenario.skills.splice(idx, 1)[0];
                    console.log(`🗑️ 시스템: [${removedSkill}] 스킬을 잊었습니다.`);
                    isUpdated = true;
                }
            });
            scenario.markModified('skills');
        }

        // ✨ 스킬 획득 처리 (최대 4개 제한!)
        const skillMatch = rawReply.match(/\[스킬획득:\s*(.+?)\]/g);
        if (skillMatch) {
            if (!scenario.skills) scenario.skills = []; 
            
            skillMatch.forEach(tag => {
                const skillName = tag.match(/\[스킬획득:\s*(.+?)\]/)[1].trim();
                
                if (!scenario.skills.includes(skillName)) {
                    // 🚨 스킬이 4개 미만일 때만 추가를 허락합니다!
                    if (scenario.skills.length < 4) {
                        scenario.skills.push(skillName);
                        console.log(`✨ 시스템: 플레이어가 [${skillName}] 스킬을 습득했습니다!`);
                        isUpdated = true;
                    } else {
                        console.log(`⚠️ 시스템 방어: 스킬 한도(4개) 초과! [${skillName}] 획득이 차단되었습니다.`);
                    }
                }
            });
            scenario.markModified('skills'); 
        }

        const itemGetMatches = Array.from(rawReply.matchAll(/\[(?:아이템획득|아이템):\s*((?:\[[^\]]*\])?[^|\]]+)(?:\|(\d+))?\]/g));
        const itemRemoveMatches = Array.from(rawReply.matchAll(/\[아이템소모:\s*(.*?)(?:\|(\d+))?\]/g));

        equipMatches.forEach(m => {
            const part = m[1].trim(); 
            const rawItem = m[2].trim();
            
            let targetItem = rawItem;
            const searchName = rawItem.split('(')[0].trim();
            for (let key of scenario.inventory.keys()) {
                if (key.startsWith(searchName)) {
                    targetItem = key; 
                    break;
                }
            }

            if (!scenario.equipment) scenario.equipment = new Map();
            scenario.equipment.set(part, targetItem);
            console.log(`[장비 장착] ${part} 슬롯에 ${targetItem} 장착 완료!`);
            isUpdated = true;
        });

        itemGetMatches.forEach(m => {
            const name = m[1].trim(); 
            const count = m[2] ? parseInt(m[2], 10) : 1; 
            const currentCount = scenario.inventory.get(name) || 0;
            scenario.inventory.set(name, currentCount + count);
            isUpdated = true;
        });

        itemRemoveMatches.forEach(m => {
            const rawName = m[1].trim(); 
            const count = m[2] ? parseInt(m[2], 10) : 1;
            const searchName = rawName.split('(')[0].trim();

            let targetKey = null;
            for (let key of scenario.inventory.keys()) {
                if (key.startsWith(searchName)) { targetKey = key; break; }
            }

            if (targetKey) {
                const currentCount = scenario.inventory.get(targetKey) || 0;
                const newCount = currentCount - count;
                if (newCount <= 0) scenario.inventory.delete(targetKey); 
                else scenario.inventory.set(targetKey, newCount); 
                isUpdated = true;
            }
        });

        if (locationMatch) {
            const newLocation = locationMatch[1].trim();
            scenario.currentLocation = newLocation;
            if (!scenario.discoveredLocations) scenario.discoveredLocations = [];
            if (!scenario.discoveredLocations.includes(newLocation)) {
                scenario.discoveredLocations.push(newLocation);
            }
            isUpdated = true;
        }

        // --- 상태창 업데이트 로직 (중복된 스킬 코드는 위로 합치고 제거함) ---
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

        // DB 최종 업데이트
if (isUpdated) {
            await Scenario.findByIdAndUpdate(scenarioId, {
                $set: { 
                    quests: scenario.quests, 
                    inventory: scenario.inventory,
                    questLines: scenario.questLines,
                    equipment: scenario.equipment,
                    currentLocation: scenario.currentLocation,
                    discoveredLocations: scenario.discoveredLocations,
                    hp: scenario.hp,
                    maxHp: scenario.maxHp,
                    gold: scenario.gold,
                    skills: scenario.skills,
                    // 🚨 [핵심 해결] 몽고DB가 소화할 수 있도록 Map 주머니를 순수 객체로 포장해서 던져줍니다!
                    bestiary: scenario.bestiary ? Object.fromEntries(scenario.bestiary.entries()) : {},
                    currentEnemy: scenario.currentEnemy 
                }
            });
        }

        // 11. 클라이언트에 보낼 때 시스템 태그 싹 다 지우기 (스킬획득 태그도 화면에서 숨기도록 정규식 추가!)
       const cleanReply = aiReplyWithDice.replace(/\[(요약|퀘스트|완료|아이템|아이템획득|아이템소모|장비착용|이동|체력|최대체력|금화|스킬추가|스킬획득|스킬삭제|도감등록): .*?\]/g, "").trim();
        return res.json({ 
            reply: cleanReply, 
            diceValue: diceRoll,
            questLines: scenario.questLines,
            qquests: scenario.quests ? Object.fromEntries(scenario.quests.entries()) : {},
            inventory: scenario.inventory ? Object.fromEntries(scenario.inventory.entries()) : {},
            currentLocation: scenario.currentLocation, 
            equipment: scenario.equipment ? Object.fromEntries(scenario.equipment.entries()) : { "무기": "없음", "방어구": "없음", "장신구": "없음" },
            discoveredLocations: scenario.discoveredLocations, 
            hp: scenario.hp !== undefined ? scenario.hp : 100,
            maxHp: scenario.maxHp !== undefined ? scenario.maxHp : 100,
            gold: scenario.gold !== undefined ? scenario.gold : 0,
            playerImageUrl: scenario.playerImageUrl,
            skills: scenario.skills || [],
            bestiary: scenario.bestiary ? Object.fromEntries(scenario.bestiary.entries()) : {},
            currentEnemy: scenario.currentEnemy || null
        });

    } catch (error) {
        console.error("❌ 에러 발생:", error);
        if (!res.headersSent) res.status(500).send("서버 에러: " + error.message);
    }

});

app.put('/api/scenarios/:id', async (req, res) => {
    try {
        if (!req.user) return res.status(401).send("Unauthorized");

        // 프론트엔드에서 보낸 5가지 수정 데이터를 받습니다.
        const { title, worldSetting, characterInfo, appearance, artStyle } = req.body;
        
        // 데이터베이스에서 해당 ID를 찾아서 덮어씌웁니다. (본인 시나리오만 수정 가능)
        const updatedScenario = await Scenario.findOneAndUpdate(
            { _id: req.params.id, userId: req.user._id }, 
            { title, worldSetting, characterInfo, appearance, artStyle },
            { new: true } // 수정된 이후의 결과물을 반환
        );

        if (!updatedScenario) {
            return res.status(404).send("시나리오를 찾을 수 없거나 수정 권한이 없습니다.");
        }

        res.json({ message: "수정 성공", scenario: updatedScenario });
    } catch (error) {
        console.error("시나리오 수정 에러:", error);
        res.status(500).send("서버 오류가 발생했습니다.");
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
        
        // 💡 퀘스트, 가방, 6칸 장비창, 도감, 전투 상태까지 완벽하게 기본값으로 덮어씌웁니다!
        await Scenario.findByIdAndUpdate(scenarioId, {
            $set: { 
                questLines: [], 
                quests: {}, 
                inventory: {},
                // 🚨 [핵심 업데이트] 장비창 6칸으로 확실하게 리셋!
                equipment: { "투구": "없음", "갑옷": "없음", "상의": "없음", "하의": "없음", "장신구": "없음", "무기": "없음" },
                hp: 100,                     // 체력 100으로 리셋
                maxHp: 100,                  // 최대 체력도 100으로 리셋
                gold: 0,                     // 금화 0으로 탕진
                skills: [],         // 🚨 [추가] 빈칸 대신 '기본 공격' 하나 쥐여주고 리셋!
                currentLocation: "시작 지점",  // 장소 초기화
                discoveredLocations: [],     // 발견한 지역 초기화
                bestiary: {},                // 🚨 [추가] AI가 만들었던 도감 몬스터들도 싹 청소
                currentEnemy: null           // 🚨 [추가] 혹시 전투 중에 초기화했을 때를 대비해 전투 상태 해제
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
        
        const equipEntries = scenario.equipment && typeof scenario.equipment.entries === 'function'
            ? Array.from(scenario.equipment.entries()) 
            : [];
        let currentEquipString = equipEntries.length > 0 
            ? equipEntries.map(([k, v]) => `${k}(${v})`).join(', ') 
            : "기본 복장";


        // AI가 상황을 한 장의 삽화로 묘사할 수 있게 문장을 만듭니다.
        const richPrompt = `
        그림 스타일(화풍): ${scenario.artStyle}.
        캐릭터 외형: ${scenario.appearance}.
        캐릭터 설정: ${characterInfo}
        배경 세계관: ${worldContext}.
        현재 상황: ${recentEvents}.
        현재 착용 중인 장비: ${currentEquipString}. 무기와 방어구가 캐릭터와 잘 어울리게 눈에 띄도록 그려줘.`;
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
        const equipEntries = scenario.equipment && typeof scenario.equipment.entries === 'function'
            ? Array.from(scenario.equipment.entries()) 
            : [];
        let currentEquipString = equipEntries.length > 0 
            ? equipEntries.map(([k, v]) => `${k}(${v})`).join(', ') 
            : "기본 복장";
            
        const imagePrompt = `다음 캐릭터 설정을 바탕으로 플레이어 초상화(얼굴 위주의 프로필 일러스트)를 1장 그려줘. 
            설정: ${characterInfo}
            그림 스타일(화풍): ${scenario.artStyle || '애니메 스타일'}
            캐릭터 외형: ${scenario.appearance || '기본 외형'}
            현재 착용 중인 장비: ${currentEquipString}. 무기와 방어구가 캐릭터와 잘 어울리게 눈에 띄도록 그려줘.`;

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
// 🎒 [추가] 드래그 앤 드롭 장비 수동 장착 API
// 🎒 [수정] 드래그 앤 드롭 장비 수동 장착/해제 API (가방 수량 연동 완결판)
app.post('/api/scenario/:id/equip', async (req, res) => {
    try {
        const { part, item } = req.body; // part: 부위, item: 새로 낄 아이템(해제 시 "없음")
        const scenario = await Scenario.findById(req.params.id);
        if (!scenario) return res.status(404).send("시나리오 없음");

        if (!scenario.equipment) scenario.equipment = new Map();
        if (!scenario.inventory) scenario.inventory = new Map();

        // 1. 기존 장착된 아이템 확인 및 가방으로 반환 (+1)
        const oldItem = scenario.equipment.get(part);
        if (oldItem && oldItem !== "없음") {
            const currentOldCount = scenario.inventory.get(oldItem) || 0;
            scenario.inventory.set(oldItem, currentOldCount + 1);
        }

        // 2. 새 아이템 장착 및 가방에서 제거 (-1)
        if (item && item !== "없음") {
            const currentNewCount = scenario.inventory.get(item) || 0;
            if (currentNewCount > 1) {
                scenario.inventory.set(item, currentNewCount - 1);
            } else {
                scenario.inventory.delete(item); // 0개가 되면 가방에서 삭제
            }
        }

        // 3. 장비 슬롯 업데이트
        scenario.equipment.set(part, item);
        
        await scenario.save();

        console.log(`[장비 조작] ${part} 슬롯: ${oldItem || '없음'} -> ${item}`);
        
        // 브라우저로 갱신된 장비와 가방 데이터를 모두 보내줍니다.
        res.json({ 
            success: true, 
            equipment: Object.fromEntries(scenario.equipment.entries()),
            inventory: Object.fromEntries(scenario.inventory.entries())
        });
    } catch (err) {
        console.error("장착 에러:", err);
        res.status(500).send(err.message);
    }
});

// 📖 [추가] 커스텀 몬스터 도감에 추가 API
// 📖 커스텀 몬스터 도감에 추가 API
app.post('/api/scenario/:id/bestiary', async (req, res) => {
    try {
        const { name, hp, attack, defense, loot, gold } = req.body;
        const scenario = await Scenario.findById(req.params.id);
        if (!scenario) return res.status(404).send("시나리오 없음");

        if (!scenario.bestiary) scenario.bestiary = new Map();
        
        scenario.bestiary.set(name, { 
            hp: Number(hp), attack: Number(attack), defense: Number(defense), 
            loot: loot, gold: Number(gold) 
        });
        
        await scenario.save();
        res.json({ success: true, bestiary: Object.fromEntries(scenario.bestiary.entries()) });
    } catch (err) {
        console.error("도감 추가 에러:", err);
        res.status(500).send(err.message);
    }
});


// 9. 서버 실행
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log("-----------------------------------------");
    console.log(`서버 실행 중: http://localhost:${PORT}`);
    console.log("-----------------------------------------");
});