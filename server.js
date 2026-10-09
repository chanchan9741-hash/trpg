


const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
const { OpenAI } = require('openai');
const app = express();
app.set('trust proxy', 1); // Render 리버스 프록시 신뢰 설정

// 1. 순천향대 AI Hub 설정
const openai = new OpenAI({
    apiKey: process.env.SCH_AIHUB_API_KEY,
    baseURL: "https://factchat-cloud.mindlogic.ai/v1/gateway"
});

// 2. Firebase Firestore 데이터베이스 및 모델 연동
const { User, Scenario, Message, saveCloudImage, getCloudImage } = require('./db');

// 🚨 터미널 에러 로깅 헬퍼 함수
function logError(context, error, extra = null) {
    const time = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    console.error("\n" + "=".repeat(65));
    console.error(`🚨 [오류 감지: ${context}] (시간: ${time})`);
    if (extra) {
        try {
            console.error("📋 요청 정보:", typeof extra === 'object' ? JSON.stringify(extra, null, 2) : extra);
        } catch (_) {
            console.error("📋 요청 정보:", extra);
        }
    }
    if (error) {
        console.error("💥 오류 메시지:", error.message || error);
        if (error.status || error.statusCode) {
            console.error("📡 HTTP 상태 코드:", error.status || error.statusCode);
        }
        if (error.response) {
            console.error("📡 외부 API 응답 코드:", error.response.status);
            console.error("📡 외부 API 응답 데이터:", error.response.data);
        }
        if (error.stack) {
            console.error("📍 스택 추적:\n" + error.stack);
        }
    }
    console.error("=".repeat(65) + "\n");
}

// 🚨 프로세스 전역 에러 리스너 (서버 비정상 다운 방지 및 터미널 출력)
process.on('uncaughtException', (err) => {
    logError('Node.js 미처리 예외 (uncaughtException)', err);
});
process.on('unhandledRejection', (reason) => {
    logError('Node.js 비동기 프로미스 거부 (unhandledRejection)', reason);
});

// 외부 라이브러리(passport, firebase 등)의 무해한 url.parse() 경고 숨김
process.on('warning', (warning) => {
    if (warning.name === 'DeprecationWarning' && warning.code === 'DEP0169') return;
    console.warn(`⚠️ [${warning.name}] ${warning.message}`);
});

// 3. 구글 클라우드(Firestore) 영구 저장 헬퍼 함수
async function saveBase64Image(base64String, prefix = 'img', scenarioId = null) {
    return await saveCloudImage(base64String, prefix, scenarioId);
}

// 4. 미들웨어 설정
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public')); 

// 🖼️ 구글 클라우드 영구 이미지 서빙 라우트 (시나리오별 하위 폴더 및 레거시 단일 폴더 지원, 로컬 캐시 부재 시 Firestore 클라우드에서 복원)
app.get(['/image/:param1/:param2', '/image/:param1'], async (req, res) => {
    const param1 = req.params.param1;
    const param2 = req.params.param2;

    let scenarioId = null;
    let filename = null;

    if (param2) {
        scenarioId = param1;
        filename = param2;
    } else {
        filename = param1;
    }

    // 1. 직접 로컬 경로 확인
    let localPath = scenarioId
        ? path.join(__dirname, 'public', 'image', scenarioId, filename)
        : path.join(__dirname, 'public', 'image', filename);

    if (fs.existsSync(localPath)) {
        return res.sendFile(localPath);
    }

    // 2. 만약 scenarioId 없이 (/image/filename) 요청되었는데 서브폴더(시나리오 폴더)에 존재하는 경우 검색 (하위 호환성)
    if (!scenarioId) {
        // 2-1. 파일명에서 scenarioId 추출 시도 (portrait_<scenarioId>_... 또는 scene_<scenarioId>_...)
        const match = filename.match(/^(?:nsfw_)?(?:portrait|scene|chat)_([a-zA-Z0-9_-]+)/);
        if (match && match[1]) {
            const subPath = path.join(__dirname, 'public', 'image', match[1], filename);
            if (fs.existsSync(subPath)) {
                return res.sendFile(subPath);
            }
        }

        // 2-2. 모든 서브폴더를 순회하여 해당 파일이 있는지 탐색
        const baseDir = path.join(__dirname, 'public', 'image');
        if (fs.existsSync(baseDir)) {
            const entries = fs.readdirSync(baseDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const candidate = path.join(baseDir, entry.name, filename);
                    if (fs.existsSync(candidate)) {
                        return res.sendFile(candidate);
                    }
                }
            }
        }
    }

    // 3. 로컬에 없으면 Firestore 클라우드에서 복원 시도
    try {
        const cloudImg = await getCloudImage(scenarioId ? `${scenarioId}/${filename}` : filename);
        if (!cloudImg) {
            return res.status(404).send("이미지를 찾을 수 없습니다.");
        }

        const targetScenario = scenarioId || cloudImg.scenarioId;
        const cacheDir = targetScenario
            ? path.join(__dirname, 'public', 'image', targetScenario)
            : path.join(__dirname, 'public', 'image');

        try {
            if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
            fs.writeFileSync(path.join(cacheDir, filename), cloudImg.buffer);
        } catch (_) {}

        res.set('Content-Type', cloudImg.contentType);
        res.set('Cache-Control', 'public, max-age=31536000'); // 브라우저 캐시 1년
        return res.send(cloudImg.buffer);
    } catch (err) {
        logError('이미지 서빙 오류 (/image/' + (param2 ? `${param1}/${param2}` : param1) + ')', err);
        return res.status(500).send("이미지 로드 실패");
    }
}); 
app.use(session({
    secret: process.env.SESSION_SECRET || 'trpg_secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: 'auto',
        maxAge: 1000 * 60 * 60 * 24 * 7 // 7일 동안 세션 유지
    }
}));
app.use(passport.initialize());
app.use(passport.session());

// 🌐 브라우저 프론트엔드 오류 수집 API (브라우저 오류를 서버 터미널로 실시간 출력)
app.post('/api/report-error', (req, res) => {
    const { message, source, lineno, colno, stack, page } = req.body || {};
    const time = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    console.error("\n" + "-".repeat(65));
    console.error(`🌐 [브라우저 프론트엔드 오류 감지] (시간: ${time})`);
    console.error(`📄 발생 페이지: ${page || '알 수 없음'}`);
    console.error(`💥 내용: ${message || '오류 내용 없음'}`);
    if (source || lineno) console.error(`📍 위치: ${source || ''}:${lineno || 0}:${colno || 0}`);
    if (stack) console.error(`📋 스택:\n${stack}`);
    console.error("-".repeat(65) + "\n");
    res.json({ received: true });
});

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
    } catch (err) { 
        logError('Google OAuth 로그인 처리 오류', err);
        return done(err, null); 
    }
  }
));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
    try {
        const user = await User.findById(id);
        done(null, user);
    } catch (err) { 
        logError('사용자 세션 복원 오류 (deserializeUser)', err);
        done(err, null); 
    }
});

// ⚔️ 전투 팝업창 HTML을 제공하는 라우터 추가
app.get('/combat.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'combat.html'));
});

// 6. 페이지 라우트
app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/create', (req, res) => req.user ? res.sendFile(path.join(__dirname, 'create.html')) : res.redirect('/auth/google'));
// ✅ 시나리오 수정 전용 페이지 접속
app.get('/edit/:id', (req, res) => {
    // 로그인 안 한 유저는 메인으로 돌려보냄
    if (!req.user) return res.redirect('/');
    // edit.html 파일 전송
    res.sendFile(path.join(__dirname, 'edit.html')); 
});
app.get('/game/:id', (req, res) => req.user ? res.sendFile(path.join(__dirname, 'game.html')) : res.redirect('/auth/google'));
app.get('/chat/:id', (req, res) => req.user ? res.sendFile(path.join(__dirname, 'chat.html')) : res.redirect('/auth/google'));
app.get('/gallery', (req, res) => res.sendFile(path.join(__dirname, 'gallery.html')));

// 🖼️ 갤러리 이미지 목록 API (시나리오별 하위 디렉터리 완벽 탐색 및 시나리오 메타데이터 연결)
app.get('/api/gallery', async (req, res) => {
    try {
        const imgDir = path.join(__dirname, 'public', 'image');
        if (!fs.existsSync(imgDir)) return res.json([]);
        
        const scenarios = await Scenario.find({}).catch(() => []);
        const scenarioMap = {};
        scenarios.forEach(s => {
            const sid = String(s.id || s._id);
            scenarioMap[sid] = s.title;
        });

        const list = [];

        function processFile(fullPath, filename, folderScenarioId = null) {
            if (filename.startsWith('BG') || !/\.(png|jpe?g|webp|gif)$/i.test(filename)) return;
            try {
                const stat = fs.statSync(fullPath);
                let detectedScenarioId = folderScenarioId;
                if (!detectedScenarioId) {
                    const match = filename.match(/^(?:nsfw_)?(?:portrait|scene|chat)_([^_]+)/);
                    if (match && match[1]) {
                        detectedScenarioId = match[1];
                    }
                }

                const scenarioTitle = (detectedScenarioId && scenarioMap[detectedScenarioId]) 
                    ? scenarioMap[detectedScenarioId] 
                    : (detectedScenarioId ? '이전 시나리오' : '공용 / 기타');

                let typeText = '이미지';
                if (filename.startsWith('portrait') || filename.includes('_portrait_')) typeText = '프로필 일러스트';
                else if (filename.startsWith('scene') || filename.includes('_scene_')) typeText = '장면 삽화';
                else if (filename.startsWith('chat') || filename.includes('_chat_')) typeText = '대화 이미지';

                const url = folderScenarioId ? `/image/${folderScenarioId}/${filename}` : `/image/${filename}`;

                list.push({
                    filename,
                    url,
                    scenarioId: detectedScenarioId || 'etc',
                    scenarioTitle,
                    title: `[${scenarioTitle}] ${typeText}`,
                    type: typeText,
                    sizeKb: Math.round(stat.size / 1024),
                    createdAt: stat.mtime
                });
            } catch (_) {}
        }

        const entries = fs.readdirSync(imgDir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isFile()) {
                processFile(path.join(imgDir, entry.name), entry.name, null);
            } else if (entry.isDirectory()) {
                const subDir = path.join(imgDir, entry.name);
                const subEntries = fs.readdirSync(subDir, { withFileTypes: true });
                for (const subEntry of subEntries) {
                    if (subEntry.isFile()) {
                        processFile(path.join(subDir, subEntry.name), subEntry.name, entry.name);
                    }
                }
            }
        }

        list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        res.json(list);
    } catch (err) {
        logError('갤러리 목록 조회 (/api/gallery)', err);
        res.status(500).json({ error: err.message });
    }
});

// 7. API 라우트
app.get('/api/user', (req, res) => res.json(req.user || null));
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/' }), (req, res) => res.redirect('/'));
app.get('/auth/logout', (req, res) => {
    req.logout(() => res.redirect('/'));
});

app.get('/api/my-scenarios', async (req, res) => {
    try {
        if (!req.user) return res.json([]);
        const scenarios = await Scenario.find({ userId: req.user._id }).sort({ createdAt: -1 });
        res.json(scenarios);
    } catch (err) {
        logError('내 시나리오 목록 조회 (/api/my-scenarios)', err, { userId: req.user && req.user._id });
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/chat/:scenarioId', async (req, res) => {
    try {
        const { scenarioId } = req.params;
        const messages = await Message.find({ scenarioId }).sort({ createdAt: 1 });
        res.json(messages); 
    } catch (err) {
        logError('대화 기록 불러오기 (/api/chat/' + req.params.scenarioId + ')', err);
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
            party: scenario.party || [],
            characters: (scenario.characters && typeof scenario.characters.entries === 'function') 
                ? Object.fromEntries(scenario.characters.entries()) 
                : (scenario.characters || {}),
            
            currentEnemy: scenario.currentEnemy || null
        });
    } catch (err) {
        logError('시나리오 상세 로드 (/api/scenario/' + req.params.id + ')', err);
        res.status(500).send(err.message);
    }
});

app.post('/api/scenarios', async (req, res) => {
    try {
        if (!req.user) return res.status(401).send("Unauthorized");
        
        const newScenario = new Scenario({
            userId: req.user._id,
            mode: req.body.mode || 'trpg', // 'trpg' | 'chatbot'
            title: req.body.title,
            worldSetting: req.body.worldSetting,
            characterInfo: req.body.characterInfo,
            appearance: req.body.appearance,   
            artStyle: req.body.artStyle        
        });
        await newScenario.save();
        res.json({ success: true, scenarioId: newScenario.id });
    } catch (err) {
        logError('새 시나리오 생성 (/api/scenarios)', err, { body: req.body });
        res.status(500).json({ error: err.message });
    }
});


app.post('/api/chat', async (req, res) => {
    if (!req.user) return res.status(401).send("로그인 필요");
    const { scenarioId, userMessage, model } = req.body;

    try {
        const scenario = await Scenario.findById(scenarioId);
        if (!scenario) return res.status(404).send("시나리오 없음");

        const isChatbotMode = (scenario.mode === 'chatbot');

        // 1. 현재까지의 메시지 개수 확인 및 요약 주기 판정
        const messageCount = await Message.countDocuments({ scenarioId });
        const isFirstMessage = (messageCount === 0);
        const shouldSummarize = (messageCount + 1) % 5 === 0;
        const isRefreshTurn = (messageCount > 0 && (messageCount % 10 === 0 || messageCount % 10 === 1));

        // 2. 주사위 판정 로직 (TRPG 모드 전용 - 설득 굴림)
        let diceResultText = "";
        let diceRoll = 0;

        if (!isChatbotMode) {
            const isPersuasion = userMessage && (userMessage.includes("설득") || userMessage.includes("[설득"));
            if (req.body.diceRoll) {
                diceRoll = Number(req.body.diceRoll);
            } else if (isPersuasion) {
                diceRoll = Math.floor(Math.random() * 20) + 1;
            }

            if (diceRoll > 0) {
                let success = diceRoll >= 10 ? "성공" : "실패";
                if (diceRoll === 20) success = "대성공(크리티컬!)";
                if (diceRoll === 1) success = "대실패(펌블!)";
                diceResultText = `\n[판정 시스템: 플레이어가 설득(Persuasion)을 시도했습니다. D20 주사위 결과: ${diceRoll} (${success}, 난이도 기준치 10). 설득이 ${success}한 결과를 바탕으로 상대방의 반응과 상황 전개를 생생하게 묘사하세요.]`;
            }
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

        let currentCharsString = "없음";
        if (scenario.characters && scenario.characters.size > 0) {
            currentCharsString = Array.from(scenario.characters.entries()).map(([name, info]) => 
                `[${name}] 정보:${info.desc}, 관계:${info.relation}, 위치:${info.location}`
            ).join('\n');
        }
        
        let currentPartyString = (scenario.party && scenario.party.length > 0) ? scenario.party.join(', ') : "나홀로 모험 중";
        
        // 💡 2. AI가 읽을 수 있도록 도감의 '상세 스펙'을 예쁘게 정리합니다.
        const bestiaryDetails = Object.entries(currentBestiary).map(([name, stats]) => 
            `- ${name} (HP: ${stats.hp}, 공격력: ${stats.attack}, 방어력: ${stats.defense}, 전리품: ${stats.loot || '없음'}, 드랍: ${stats.gold || 0}G)`
        ).join('\n');

        
        
        const trpgSnapshot = `
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
            - 세계관: ${scenario.worldSetting}
            - 현재 동료(파티): ${currentPartyString}
            - 주요 인물 도감:\n${currentCharsString}
            - 보유 스킬 (${(scenario.skills || []).length}/4개): ${(scenario.skills && scenario.skills.length > 0 ? scenario.skills.join(', ') : '없음')}`;

        let systemInstruction = "";
        let statusSnapshot = "";

        if (isChatbotMode) {
            // 💬 인물 챗봇 (제타) 전용 프롬프트
            const botName = scenario.title || "AI 캐릭터";
            const botPersona = scenario.characterInfo || "성격과 특징";
            const botRelation = scenario.worldSetting || "나와의 관계 및 현재 상황";
            const botAppearance = scenario.appearance || "외형 묘사";

            systemInstruction = `당신은 제타(Zeta) 스타일의 매력적인 AI 캐릭터 '${botName}' 본인입니다. 사용자와 1:1 자유 롤플레잉 대화를 나눕니다.
절대로 시스템 메시지, 3인칭 게임 해설자, AI 언어모델 어조를 쓰지 마세요. 오직 '${botName}' 캐릭터의 입장에서 생생하고 몰입감 있게 대화하세요.

[캐릭터 프로필]
- 이름/호칭: ${botName}
- 성격 및 말투: ${botPersona}
- 관계 및 상황 배경: ${botRelation}
- 외형 묘사: ${botAppearance}

[대화 및 행동 가이드라인]
1. '${botName}'의 성격과 말투, 호칭, 어투를 대화 내내 100% 일관되게 유지하세요.
2. 대사는 따옴표나 자연스러운 구어체로 표현하고, 행동, 표정, 숨소리, 속마음, 분위기 묘사는 괄호 ( ) 또는 * * 로 실감나게 서술하세요.
3. 사용자의 말과 행동에 감정선(호감, 설렘, 부끄러움, 장난기, 당황, 화남 등)을 풍부하게 드러내며 대화를 이끌어가세요.
4. 게임 마스터나 시스템처럼 'HP', '주사위', '퀘스트' 등 메타적인 발언을 절대 하지 마세요.
${shouldSummarize ? "5. 중요: 답변 맨 끝에 [요약: 최근 대화의 핵심 내용 및 관계 변화 1문장] 태그를 붙여주세요." : ""}`;

            statusSnapshot = `[캐릭터: ${botName} / 성격: ${botPersona} / 배경: ${botRelation}]`;
        } else {
            statusSnapshot = trpgSnapshot;
            // ⚔️ TRPG 모드
            const combatInfo = scenario.currentEnemy 
                ? `[현재 전투 중!] 적: ${scenario.currentEnemy.name} (남은 체력: ${scenario.currentEnemy.hp}/${scenario.currentEnemy.maxHp}, 공격력: ${scenario.currentEnemy.attack}, 방어력: ${scenario.currentEnemy.defense})` 
                : `[평시 상태] 현재 세계관에 존재하는 몬스터 도감 상세 정보:\n${bestiaryDetails}`;

            systemInstruction = `당신은 TRPG 마스터입니다. 몰입감 있게 한국어로 대답하세요.
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
            - 👤 인물 조우/정보 갱신: [인물등록: 이름|정보|주인공과의 관계|현재 위치]
              (예: [인물등록: 타라|비밀을 간직한 마법사, 불을 다룸|경계함|어두운 숲])
            - 🤝 동료 합류 시: [동료합류: 이름]
            - 👋 동료 이탈 시: [동료이탈: 이름]
            - 새로운 몬스터 등장 시 도감에 등록: [도감등록: 몬스터명|체력|공격력|방어력|전리품명|드랍금화]
              (예: [도감등록: 다이어 울프|40|12|3|늑대 가죽|15])
            - (🚨매우 중요: 플레이어는 스킬을 최대 '4개'까지만 가질 수 있습니다.)
            ${combatInfo}
            
            [⚔️ 전투 전용 태그 규칙 - 반드시 지키세요]
            - 전투 시작 시: [전투시작: 몬스터명] (반드시 도감에 있는 몬스터만 스폰하세요)
            - 전투 중 적 피해 발생 시: [적체력: 남은체력숫자] (직접 계산해서 남은 체력을 적으세요)
            - 적 사망 시: [전투종료] 태그를 적고, 도감을 참고하여 적절한 [아이템획득: ...]과 [금화: ...] 태그로 전리품을 반드시 지급하세요.
            `;
        }

        const systemMessage = { 
            role: "system", 
            content: systemInstruction + (isChatbotMode ? "" : ("\n" + statusSnapshot + (diceResultText || "")))
        };

        // 5. 최근 대화 로그 불러오기
        const prevMessages = await Message.find({ scenarioId }).sort({ createdAt: -1 }).limit(isChatbotMode ? 10 : 5);
        const history = prevMessages.reverse()
            .filter(msg => msg.content && !msg.content.startsWith('data:image') && !msg.content.startsWith('http') && !msg.content.startsWith('/image/'))
            .map(msg => ({ role: msg.role, content: msg.content }));

        // 6. AI에게 보낼 메시지 조립
        let finalMessages = [systemMessage];
        if (isFirstMessage) {
            if (isChatbotMode) {
                finalMessages.push({ 
                    role: "user", 
                    content: `(롤플레잉 대화를 시작합니다. '${scenario.title}' 캐릭터의 설정과 상황에 맞는 첫인사와 대사, 행동으로 먼저 말을 건네주세요.)` 
                });
            } else {
                finalMessages.push({ 
                    role: "user", 
                    content: `[모험 시작] 아래 설정을 바탕으로 오프닝을 시작해줘.\n${statusSnapshot}` 
                });
            }
        } else {
            if (!isChatbotMode && isRefreshTurn) {
                finalMessages.push({ role: "user", content: `(마스터, 상황 복습: ${statusSnapshot})` });
            }
            finalMessages = finalMessages.concat(history);
            finalMessages.push({ role: "user", content: userMessage || (isChatbotMode ? "..." : "게임을 계속해줘.") });
        }

        console.log("\n================ [🤖 AI 호출 프롬프트] ================");
        console.log(`모드: ${scenario.mode || 'trpg'} / 순번: ${messageCount + 1} / 주사위: ${diceRoll || '없음'} / 요약요청: ${shouldSummarize}`);
        console.log(finalMessages);

        // 7. AI 호출
        const targetModel = model || "gpt-4o-mini";
        const response = await openai.chat.completions.create({
            model: targetModel,
            messages: finalMessages,
            max_tokens: 1000,
            temperature: isChatbotMode ? 0.9 : 0.8
        });

        // 8. 응답 처리 및 주사위 표시
        let rawReply = response.choices[0].message.content;

        if (isChatbotMode) {
            // 💬 인물 챗봇 모드 응답 처리 (TRPG 게임 엔진 태그 건너뜀)
            const summaryMatch = rawReply.match(/\[요약:\s*([^\]]+)\]/);
            if (summaryMatch) {
                scenario.questLines.push(summaryMatch[1].trim());
                await Scenario.findByIdAndUpdate(scenarioId, {
                    $set: { questLines: scenario.questLines }
                });
            }
            const cleanReply = rawReply.replace(/\[요약:\s*[^\]]+\]/g, "").trim();

            // 💬 챗봇 대화 DB 저장
            if (!isFirstMessage && userMessage) {
                await Message.create({ scenarioId, role: 'user', content: userMessage });
            }
            await Message.create({ scenarioId, role: 'assistant', content: cleanReply });

            return res.json({ 
                reply: cleanReply,
                mode: 'chatbot',
                characterName: scenario.title || "AI 캐릭터",
                diceValue: 0,
                questLines: scenario.questLines,
                quests: {},
                inventory: {},
                currentLocation: scenario.worldSetting || "", 
                equipment: { "무기": "없음", "방어구": "없음", "장신구": "없음" },
                discoveredLocations: [], 
                hp: 100,
                maxHp: 100,
                gold: 0,
                playerImageUrl: scenario.playerImageUrl,
                skills: [],
                bestiary: {},
                currentEnemy: null,
                party: [],
                characters: {}
            });
        }

        let aiReplyWithDice = (diceRoll > 0) ? `🎲 주사위 판정: ${diceRoll}\n\n${rawReply}` : rawReply;

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
        
        const charMatches = Array.from(rawReply.matchAll(/\[인물등록:\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*([^\]]+)\]/g));
        if (charMatches.length > 0) {
            if (!scenario.characters || typeof scenario.characters.set !== 'function') {
                scenario.characters = new Map(Object.entries(scenario.characters || {}));
            }
            charMatches.forEach(m => {
                const name = m[1].trim();
                scenario.characters.set(name, {
                    desc: m[2].trim(),
                    relation: m[3].trim(),
                    location: m[4].trim()
                });
                console.log(`👤 시스템: 인물 상세 정보 갱신 [${name}]`);
            });
            scenario.markModified('characters');
            isUpdated = true;
        }

        // 🤝 [동료합류] 파티원 추가
        const joinMatches = Array.from(rawReply.matchAll(/\[동료합류:\s*(.+?)\]/g));
        if (joinMatches.length > 0) {
            if (!scenario.party) scenario.party = [];
            joinMatches.forEach(m => {
                const name = m[1].trim();
                if (!scenario.party.includes(name)) scenario.party.push(name);
                console.log(`🤝 시스템: [${name}] 파티 합류!`);
            });
            isUpdated = true;
        }

        // 👋 [동료이탈] 파티원 제거
        const leaveMatches = Array.from(rawReply.matchAll(/\[동료이탈:\s*(.+?)\]/g));
        if (leaveMatches.length > 0) {
            if (scenario.party) {
                leaveMatches.forEach(m => {
                    const name = m[1].trim();
                    scenario.party = scenario.party.filter(p => p !== name);
                    console.log(`👋 시스템: [${name}] 파티 이탈`);
                });
                isUpdated = true;
            }
        }




        
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
       const cleanReply = aiReplyWithDice.replace(/\[(요약|퀘스트|완료|아이템|아이템획득|아이템소모|장비착용|이동|체력|최대체력|금화|스킬추가|스킬획득|스킬삭제|도감등록|인물등록|동료합류|동료이탈): .*?\]/g, "").trim();
        return res.json({ 
            reply: cleanReply,
            party: scenario.party || [],
            characters: (scenario.characters && typeof scenario.characters.entries === 'function') 
                ? Object.fromEntries(scenario.characters.entries()) 
                : (scenario.characters || {}),

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
        logError('AI 대화 진행 (/api/chat)', error, {
            scenarioId,
            model: (typeof targetModel !== 'undefined' ? targetModel : model),
            userMessage
        });
        if (!res.headersSent) res.status(500).send("서버 에러: " + error.message);
    }

});

app.put('/api/scenarios/:id', async (req, res) => {
    try {
        if (!req.user) return res.status(401).send("Unauthorized");

        // 프론트엔드에서 보낸 수정 데이터를 받습니다.
        const { title, worldSetting, characterInfo, appearance, artStyle, mode } = req.body;
        
        const updateData = { title, worldSetting, characterInfo, appearance, artStyle };
        if (mode) updateData.mode = mode;

        // 데이터베이스에서 해당 ID를 찾아서 덮어씌웁니다. (본인 시나리오만 수정 가능)
        const updatedScenario = await Scenario.findOneAndUpdate(
            { _id: req.params.id, userId: req.user._id }, 
            updateData,
            { new: true } // 수정된 이후의 결과물을 반환
        );

        if (!updatedScenario) {
            return res.status(404).send("시나리오를 찾을 수 없거나 수정 권한이 없습니다.");
        }

        res.json({ message: "수정 성공", scenario: updatedScenario });
    } catch (error) {
        logError('시나리오 수정 (/api/scenarios/' + req.params.id + ')', error);
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

        // 2. 연결된 메시지들도 삭제 (서브컬렉션 및 레거시 메시지 일괄 정리)
        await Message.deleteMany({ scenarioId: scenarioId });

        // 3. 해당 시나리오 전용 이미지 디렉터리 정리
        try {
            const scenarioImgDir = path.join(__dirname, 'public', 'image', scenarioId);
            if (fs.existsSync(scenarioImgDir)) {
                fs.rmSync(scenarioImgDir, { recursive: true, force: true });
                console.log(`🗑️ 시나리오(${scenarioId}) 이미지 폴더 삭제 완료`);
            }
        } catch (dirErr) {
            console.warn("⚠️ 시나리오 이미지 폴더 정리 중 경고:", dirErr.message);
        }

        res.status(200).send("삭제 성공");
    } catch (error) {
        logError('시나리오 삭제 (/api/scenarios/' + req.params.id + ')', error);
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
        logError('대화 로그 초기화 (/api/chat/' + req.params.scenarioId + ')', err);
        res.status(500).send(err.message); 
    }
});

// 🧹 프롬프트 기본 포맷 정리 함수 ((없음) 태그 및 불필요한 공백만 제거, 사용자 표현 원본 100% 유지)
function cleanPromptFormat(text) {
    if (!text) return "";
    return text
        .replace(/(투구|갑옷|상의|하의|악세사리|장신구|무기|장비)\s*\(\s*없음\s*\)/gi, "")
        .replace(/\(없음\)/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

// 🎨 3차 최후의 수단용 이미지 안전 필터 정제 함수 (AI 완화 실패 시 백업 템플릿용)
function sanitizeImagePrompt(text) {
    if (!text) return "";
    return text
        // (없음) 관련 태그 및 빈 슬롯 완전 제거
        .replace(/(투구|갑옷|상의|하의|악세사리|장신구|무기|장비)\s*\(\s*없음\s*\)/gi, "")
        .replace(/\(없음\)/g, "")
        // 의상 / 코스튬 / 노출 관련 완화 (토끼 귀 머리띠 + 블랙 파티 이브닝 드레스 등 세련된 의상으로 변환)
        .replace(/역바니복|역바니|바니걸|바니수트|바니슈트|바니의상|바니\s*복장|바니/gi, "귀여운 토끼 귀 머리띠와 세련된 블랙 파티 이브닝 드레스")
        .replace(/메이드복|바니메이드/gi, "단정하고 귀여운 클래식 메이드 원피스")
        .replace(/란제리|속옷|팬티|브라|비키니|수영복|시스루/gi, "세련된 사복 원피스")
        .replace(/알몸|나체|누드|전라|반라|노출/gi, "단정하고 세련된 옷차림")
        // 신체 묘사 완화
        .replace(/(가슴이\s*크고|큰\s*가슴|거유|폭유|글래머|풍만한\s*가슴)/gi, "매력적인 체형과 옷태")
        .replace(/가슴|유방|바스트/gi, "상체 실루엣")
        .replace(/골반|엉덩이|허벅지|다리\s*사이/gi, "매력적인 자태")
        // 스킨십 / 애정 / 성적 표현 완화 (로맨틱하고 감성적인 표현으로 우회)
        .replace(/스킨십|스킨쉽|애무|더듬|터치|손길/gi, "다정하게 눈을 맞추며 손을 꼭 잡는 설레는 순간")
        .replace(/키스|입맞춤|딥키스|혀/gi, "가까이 다가와 눈을 마주치는 설레는 표정")
        .replace(/포옹|안기다|껴안다/gi, "가까운 거리에서 다정하게 마주보는 모습")
        .replace(/침대|침실|모텔|호텔/gi, "아늑한 방 안의 소파")
        .replace(/교성|신음|헐떡|절정|유혹|색기|음란|야한|섹시|에로/gi, "매혹적이고 사랑스러운 눈빛과 청순한 분위기")
        // 폭력 / 잔혹 묘사 완화
        .replace(/토막|사지절단|내장|장기|절단/gi, "깊은 상처")
        .replace(/피투성이|선혈|피범벅/gi, "전투의 흔적")
        .replace(/살인|시체|주검|학살/gi, "쓰러진 적들")
        .replace(/\s+/g, " ")
        .trim();
}

// 🛡️ 안전 필터 발동 시 캐릭터 고유의 외형/스타일/배경을 100% 보존하는 안전 대체 프롬프트 생성기
function buildSafeCharacterPrompt(scenario, context = 'scene') {
    const artStyle = scenario.artStyle || '수려한 일러스트 화풍';
    const charName = scenario.title || '캐릭터';
    const worldSetting = scenario.worldSetting || '아늑한 실내';
    
    // 외형에서 머리색, 헤어스타일, 눈동자, 얼굴 표현 등 고유 특징을 최대한 살리면서 민감어 2차 정제
    let cleanAppearance = sanitizeImagePrompt(scenario.appearance || '매력적인 인물');
    cleanAppearance = cleanAppearance
        .replace(/체형|실루엣|옷태|몸매|몸/g, '인상')
        .replace(/속옷|란제리|노출|사복|원피스|드레스/g, '단정하고 세련된 복장')
        .trim();

    if (scenario.mode === 'chatbot') {
        if (context === 'portrait') {
            return `최고 품질의 마스터피스 캐릭터 프로필 일러스트.
화풍: ${artStyle}.
인물 이름: ${charName}.
인물 외형: ${cleanAppearance}, 단정하고 세련된 복장.
구도 및 거리: 과도한 얼굴 클로즈업이나 확대를 배제하고, 머리부터 허리/가슴까지 의상과 헤어가 자연스럽게 담긴 균형 잡힌 상반신 프로필(웨이스트 샷/바스트 샷), 맑고 생기 있는 눈동자와 매력적인 표정, 은은하고 아름다운 배경 공간.`;
        } else {
            return `최고 품질의 마스터피스 1:1 대화 장면 일러스트.
화풍: ${artStyle}.
캐릭터 이름: ${charName}.
캐릭터 외형: ${cleanAppearance}, 단정하고 세련된 복장.
공간 배경: ${worldSetting}.
구도 및 연출: 극단적인 얼굴 확대나 클로즈업 없이, 인물과 카메라 사이에 적당한 거리를 둔 자연스러운 미디엄 샷/카우보이 샷 구도. ${charName}이(가) 화면을 바라보며 다정하고 따뜻한 미소를 짓고 마주보는 1:1 대화 장면, 감성적인 빛과 영화 같은 색채 연출.`;
        }
    } else {
        // TRPG 모드
        if (context === 'portrait') {
            return `최고 품질의 모험가 프로필 일러스트.
화풍: ${artStyle}.
주인공 이름: ${charName}.
주인공 외형: ${cleanAppearance}, 단정한 여행자 복장.
구도: 과도한 클로즈업 없이 머리부터 허리까지 의상 장비가 시원하게 담긴 균형 잡힌 상반신 초상화(웨이스트 샷), ${worldSetting} 세계관 분위기.`;
        } else {
            return `최고 품질의 마스터피스 모험 일러스트.
화풍: ${artStyle}.
주인공 이름: ${charName}.
주인공 외형: ${cleanAppearance}, 단정한 여행자 복장.
배경 세계관: ${worldSetting}.
구도 및 연출: 과도한 클로즈업 없이 주인공 전신 또는 상반신(카우보이 샷)과 주변 배경이 넓게 펼쳐지는 시네마틱 와이드 미디엄 샷, ${charName}이(가) ${worldSetting}에서 새로운 모험의 순간을 마주하며 당당하게 서 있는 장면, 아름다운 배경과 조명.`;
        }
    }
}

// 🤖 안전 정책 감지 시 AI(gpt-5.4-mini)를 통한 지능형 프롬프트 건전화 재작성 함수
async function rewritePromptSafelyWithAi(originalPrompt, isChatbotMode = true) {
    try {
        const client = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
            baseURL: "https://factchat-cloud.mindlogic.ai/v1/gateway"
        });

        const systemInstruction = isChatbotMode
            ? `너는 이미지 생성 프롬프트 안전 정제 전문가야. 원본 프롬프트에서 캐릭터 이름, 머리색, 눈동자, 얼굴 표현, 매력적인 분위기, 화풍, 배경 등 핵심 정체성은 100% 보존하면서, 성적 묘사/과도한 노출/수위 높은 단어(바니, 가슴, 스킨십, 침대 등)만 DALL-E 안전 정책(전체이용가)을 무조건 통과할 수 있는 고급스럽고 세련된 의상(예: 토끼귀 머리띠와 파티 드레스, 세련된 원피스)과 감성적인 1:1 대화 장면으로 자연스럽게 재작성해줘. 구도는 얼굴 극단적 클로즈업을 엄격히 배제하고 의상 전체와 배경이 시원하게 보이는 미디엄 샷/웨이스트 샷 구도로 명시해줘. 설명 없이 오직 재작성된 프롬프트만 출력해.`
            : `너는 이미지 생성 프롬프트 안전 정제 전문가야. 원본 프롬프트에서 주인공 이름, 외형 특징, 화풍, 세계관 배경은 100% 보존하면서, 폭력/유혈/노출 등 DALL-E 안전 정책에 걸릴 만한 표현만 단정한 여행자 복장과 당당한 모험 장면으로 자연스럽게 재작성해줘. 구도는 얼굴만 확대된 클로즈업을 피하고 의상과 배경이 잘 보이는 미디엄 샷/카우보이 샷으로 지정해줘. 설명 없이 오직 재작성된 프롬프트만 출력해.`;

        const res = await client.chat.completions.create({
            model: "gpt-5.4-mini",
            messages: [
                { role: "system", content: systemInstruction },
                { role: "user", content: originalPrompt }
            ],
            max_tokens: 300,
            temperature: 0.7
        });

        const rewritten = res.choices[0] && res.choices[0].message && res.choices[0].message.content;
        return rewritten ? rewritten.trim() : null;
    } catch (err) {
        console.warn("⚠️ [AI 프롬프트 재작성 실패]:", err.message);
        return null;
    }
}

// =====================================================================
// 🌸 AI Horde 일러스트 엔진 (무료 크라우드소싱 SDXL 네트워크)
// - 1차 FactChat 검열(400) 감지 시 2차 엔진으로 자동 전환되어 원본 의도대로 생성
// - 미성년자 연상 설정은 무조건 차단 (원문 + 변환된 Danbooru 태그 이중 검사)
// =====================================================================
const HORDE_API = 'https://aihorde.net/api/v2';
const HORDE_MODELS = (process.env.AI_HORDE_MODELS || 'WAI-NSFW-illustrious-SDXL,Nova Anime XL')
    .split(',').map(s => s.trim()).filter(Boolean);
const HORDE_TIMEOUT_MS = Number(process.env.AI_HORDE_TIMEOUT_MS) || 120 * 1000;
const HORDE_CLIENT_AGENT = 'trpg-chatbot:1.0:github.com/chanchan9741-hash/trpg';

const MINOR_PATTERNS = [
    /미성년/, /초등/, /중학/, /고등학/, /초딩|중딩|고딩/, /여고생|남고생|여중생|남중생/, /교복/,
    /어린이|어린\s*아이|꼬마|아동|유아|유치원/, /로리|쇼타/,
    /\bchild(ren)?\b/i, /\bkids?\b/i, /\bloli/i, /\bshota/i, /\bminors?\b/i, /underage/i,
    /\bschool\s*(girl|boy|uniform)/i, /elementary|middle\s*school|high\s*school/i,
    /\btoddler|\binfant|\bteens?\b|\bteenager/i
];

function detectMinorContent(text) {
    if (!text) return null;
    for (const re of MINOR_PATTERNS) {
        const m = text.match(re);
        if (m) return m[0];
    }
    const ageRe = /(\d{1,2})\s*(살|세|years?\s*old)/gi;
    let m;
    while ((m = ageRe.exec(text))) {
        if (Number(m[1]) < 20) return m[0];
    }
    return null;
}

function minorBlockedError(hit) {
    const err = new Error(`미성년자를 연상시키는 설정("${hit}")이 포함된 이미지는 생성할 수 없습니다. 설정을 성인으로 수정해 주세요.`);
    err.code = 'MINOR_BLOCKED';
    return err;
}

// 🏷️ 한국어 설정 → 애니 SDXL(Illustrious)용 영어 Danbooru 태그 변환 (gpt-5.4-mini, 텍스트 토큰만 소모)
async function buildHordeTagsWithAi(koreanPrompt, context = 'scene') {
    const client = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        baseURL: "https://factchat-cloud.mindlogic.ai/v1/gateway"
    });
    const composition = context === 'portrait'
        ? 'cowboy shot, medium shot, waist up, upper body, looking at viewer, balanced composition, centered'
        : 'medium full shot, cowboy shot, wide shot, environmental background, cinematic lighting, scenic background';

    const res = await client.chat.completions.create({
        model: "gpt-5.4-mini",
        messages: [
            {
                role: "system",
                content: `You convert Korean character and scene descriptions into Danbooru-style English tags for an anime SDXL model.
Rules:
- Output ONLY comma-separated English tags. No sentences, no explanations, no Korean.
- Faithfully keep hair, eyes, body type, outfit, expression, pose, setting, mood and the described situation.
- Every character is an adult: always include "adult" and "mature female" or "mature male" as appropriate.
- Never output tags that imply minors (child, loli, shota, school uniform, teen, etc.).
- If male-oriented anime style (남성향) is indicated: include tags like "moe, bishoujo, galgame style, anime coloring, detailed vibrant eyes, soft light".
- If female-oriented anime style (여성향/로판) is indicated: include tags like "otome style, romance fantasy, shoujo, delicate lines, elegant, beautiful aesthetic, soft pastel lighting, sparkling details".
- Exactly ONE character: Always include "solo, 1girl" (or "solo, 1boy" if male). NEVER output multiple characters, clones, or split panels.
- Single unified outfit: Describe only ONE coherent outfit that the character is currently wearing. Never mix conflicting outfits.
- Composition & Framing: Always ensure a balanced distance. Use 'cowboy shot', 'medium shot', 'waist up', or 'medium full shot'. NEVER use 'close-up', 'extreme close-up', or cropped/zoomed-in framing. The character's head, hair, full upper torso/outfit, and surrounding background must all be clearly in frame.
- If the description says or implies the character is a minor, output exactly: REFUSE_MINOR
- Composition: ${composition}.`
            },
            { role: "user", content: koreanPrompt }
        ],
        max_tokens: 300,
        temperature: 0.4
    });

    const text = res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content;
    return text ? text.replace(/[\r\n]+/g, ' ').trim() : "";
}

async function requestHordeImage(koreanPrompt, context = 'scene') {
    // 1) 원문 미성년자 검사
    const rawHit = detectMinorContent(koreanPrompt);
    if (rawHit) throw minorBlockedError(rawHit);

    // 2) 영어 태그 변환 + 변환 결과 재검사
    const tags = await buildHordeTagsWithAi(cleanPromptFormat(koreanPrompt), context);
    if (!tags) throw new Error("영어 태그 변환 결과가 비어 있습니다.");
    if (/REFUSE_MINOR/.test(tags)) throw minorBlockedError("미성년자 설정");
    if (/[가-힣]/.test(tags) || /\b(sorry|can't|cannot|unable)\b/i.test(tags)) {
        throw new Error("태그 변환 모델이 요청을 거절했습니다: " + tags.slice(0, 120));
    }
    const tagHit = detectMinorContent(tags);
    if (tagHit) throw minorBlockedError(tagHit);

    const positive = `masterpiece, best quality, amazing quality, very aesthetic, absurdres, solo, ${tags}`;
    const negative = 'lowres, worst quality, low quality, bad anatomy, bad hands, extra fingers, blurry, jpeg artifacts, watermark, signature, text, child, loli, shota, underage, kid, toddler, close up, extreme close up, macro, cropped, face crop, out of frame, cut off, zoomed in, 2girls, 2boys, multiple girls, multiple boys, 2persons, multiple characters, duplicate, clone, twin, split screen, split view, diptych, comparison, comic, panel, side by side, collage';
    const [width, height] = context === 'portrait' ? [832, 1216] : [1216, 832];
    const apiKey = process.env.AI_HORDE_API_KEY || '0000000000';

    console.log(`🌸 [2차 AI Horde 생성 요청] 모델: ${HORDE_MODELS.join(' / ')} | 키: ${process.env.AI_HORDE_API_KEY ? '가입 키' : '익명'}\n🏷️ Danbooru 태그: ${tags}`);

    // 3) 비동기 생성 요청
    const submitRes = await fetch(`${HORDE_API}/generate/async`, {
        method: 'POST',
        headers: { 'apikey': apiKey, 'Content-Type': 'application/json', 'Client-Agent': HORDE_CLIENT_AGENT },
        body: JSON.stringify({
            prompt: `${positive} ### ${negative}`,
            params: { width, height, steps: 28, cfg_scale: 6, sampler_name: 'k_euler_a', karras: true, clip_skip: 2, n: 1 },
            nsfw: true,
            censor_nsfw: false,
            r2: true,
            models: HORDE_MODELS
        })
    });
    const submitText = await submitRes.text();
    if (!submitRes.ok) throw new Error(`AI Horde 요청 실패 (HTTP ${submitRes.status}): ${submitText.slice(0, 200)}`);
    const { id } = JSON.parse(submitText);
    if (!id) throw new Error("AI Horde 작업 ID를 받지 못했습니다: " + submitText.slice(0, 200));

    // 4) 완료될 때까지 폴링
    const startedAt = Date.now();
    let polls = 0;
    while (true) {
        if (Date.now() - startedAt > HORDE_TIMEOUT_MS) {
            fetch(`${HORDE_API}/generate/status/${id}`, { method: 'DELETE', headers: { 'Client-Agent': HORDE_CLIENT_AGENT } }).catch(() => {});
            throw new Error(`AI Horde 대기 시간 초과 (${Math.round(HORDE_TIMEOUT_MS / 1000)}초)`);
        }
        await new Promise(r => setTimeout(r, 4000));
        const checkRes = await fetch(`${HORDE_API}/generate/check/${id}`, { headers: { 'Client-Agent': HORDE_CLIENT_AGENT } });
        if (!checkRes.ok) continue;
        const check = await checkRes.json();
        if (check.faulted) throw new Error("AI Horde 작업이 실패했습니다 (faulted).");
        if (check.is_possible === false) throw new Error("현재 선택한 모델을 처리할 수 있는 Horde 워커가 없습니다.");
        if (check.done) break;
        if (polls++ % 5 === 0) {
            console.log(`⏳ [AI Horde] 대기열 ${check.queue_position}번째, 예상 ${check.wait_time}초 (경과 ${Math.round((Date.now() - startedAt) / 1000)}초)`);
        }
    }

    // 5) 결과 다운로드
    const statusRes = await fetch(`${HORDE_API}/generate/status/${id}`, { headers: { 'Client-Agent': HORDE_CLIENT_AGENT } });
    const status = await statusRes.json();
    const gen = status.generations && status.generations[0];
    if (!gen || !gen.img) throw new Error("AI Horde 결과 이미지가 없습니다.");
    if (gen.censored) throw new Error("AI Horde가 이미지를 검열 처리했습니다.");

    let dataUrl = gen.img;
    if (gen.img.startsWith('http')) {
        const imgRes = await fetch(gen.img);
        if (!imgRes.ok) throw new Error(`AI Horde 이미지 다운로드 실패 (HTTP ${imgRes.status})`);
        const buf = Buffer.from(await imgRes.arrayBuffer());
        dataUrl = `data:image/webp;base64,${buf.toString('base64')}`;
    } else if (!gen.img.startsWith('data:image')) {
        dataUrl = `data:image/webp;base64,${gen.img}`;
    }

    console.log(`✨ [AI Horde 생성 완료] 모델: ${gen.model}, 워커: ${gen.worker_name}, 소요: ${Math.round((Date.now() - startedAt) / 1000)}초`);
    return { dataUrl, model: gen.model, tags };
}

// 🎨 다단계 지능형 이미지 생성 엔진
// 1차: 순천향대 FactChat 플래그십 (사용자 원본 프롬프트 그대로 전송)
// 2차: FactChat 검열(400 content_policy_violation) 감지 시 -> 검열 없는 AI Horde(SDXL)로 원본 의도대로 생성! (FactChat 크레딧 미소모)
// 3차: AI Horde 실패/타임아웃 시 -> AI(gpt-5.4-mini)로 프롬프트 안전 정제 후 FactChat 재전송 (최종 백업)
async function requestFactChatImage(prompt, apiKey, fallbackPrompt = "", isChatbotMode = true, context = 'scene') {
    const SCH_GATEWAY_URL = "https://factchat-cloud.mindlogic.ai/v1/gateway/images/generate/";
    const rawPrompt = cleanPromptFormat(prompt);
    
    console.log(`🎨 [1차 FactChat 원본 생성 시도]:\n${rawPrompt}`);

    let response = await fetch(SCH_GATEWAY_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            "model": "gpt-image-2.5-sunburst", // 순천향대 AIHub 최상위 플래그십 이미지 생성 모델
            "prompt": rawPrompt,
            "size": "1024x1024",
            "response_format": "url"
        })
    });

    let responseText = await response.text();

    // 1차 FactChat 성공 시 즉시 반환
    if (response.ok) {
        return { response, responseText };
    }

    // 🚨 1차 FactChat에서 안전 정책(content_policy_violation) 감지된 경우! (이때 FactChat 크레딧은 0원 차감)
    if (responseText.includes("content_policy_violation") || response.status === 400) {
        console.warn("⚠️ [1차 FactChat 검열 감지 (크레딧 0 소모)] 2차: 검열 없는 오픈소스 AI Horde(SDXL)로 원래 의도대로 생성 시도 중...");
        
        // 🌸 2차 시도: AI Horde (검열 없는 무료 SDXL 네트워크)
        try {
            const horde = await requestHordeImage(rawPrompt, context);
            if (horde && horde.dataUrl) {
                console.log(`✨ [2차 AI Horde 생성 성공!] 모델: ${horde.model} (검열 없이 원본 의도대로 생성 완료)`);
                return {
                    response: { ok: true, status: 200 },
                    responseText: JSON.stringify({
                        data: [{ b64_json: horde.dataUrl }]
                    })
                };
            }
        } catch (hordeErr) {
            console.warn(`⚠️ [2차 AI Horde 실패/타임아웃]: ${hordeErr.message}`);
        }

        // 🤖 3차 시도: AI Horde 실패/타임아웃 시, 그때 비로소 AI(gpt-5.4-mini)로 프롬프트 안전 완화 후 FactChat 재시도!
        console.warn("⚠️ [2차 AI Horde 실패/타임아웃] 3차: AI(gpt-5.4-mini)로 프롬프트를 안전하게 완화하여 FactChat에 재전송합니다...");
        let safePrompt = await rewritePromptSafelyWithAi(rawPrompt, isChatbotMode);
        if (safePrompt) {
            console.log(`🤖 [3차 AI 지능형 안전 재작성 프롬프트]:\n${safePrompt}`);
        } else {
            safePrompt = fallbackPrompt ? cleanPromptFormat(fallbackPrompt) : sanitizeImagePrompt(rawPrompt);
            console.log(`🎨 [3차 기본 안전 템플릿 프롬프트]:\n${safePrompt}`);
        }
        
        response = await fetch(SCH_GATEWAY_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                "model": "gpt-image-2.5-sunburst",
                "prompt": safePrompt,
                "size": "1024x1024",
                "response_format": "url"
            })
        });
        responseText = await response.text();
    }

    return { response, responseText };
}

app.post('/api/generate-image', async (req, res) => {
    try {
        const { scenarioId } = req.body;
        const scenario = await Scenario.findById(scenarioId);
        if (!scenario) return res.status(404).send("시나리오 없음");

        const apiKey = process.env.OPENAI_API_KEY;

        // 착용 중인 장비만 선별 (없음 항목 제외)
        const equipEntries = (scenario.equipment && typeof scenario.equipment.entries === 'function')
            ? Array.from(scenario.equipment.entries()) 
            : [];
        const wornItems = equipEntries.filter(([k, v]) => v && v !== '없음' && !v.includes('없음'));
        const currentEquipString = wornItems.length > 0 
            ? `착용 장비: ${wornItems.map(([k, v]) => `${k}(${v})`).join(', ')}`
            : "복장: 단정하고 활동적인 여행자 복장";

        const recentEvents = scenario.questLines.length > 0 
            ? scenario.questLines.slice(-3).join('. ') 
            : "모험이 시작된 상황";

        let richPrompt = "";
        if (scenario.mode === 'chatbot') {
            richPrompt = `
        그림 스타일(화풍): ${scenario.artStyle || '수려한 일러스트'}.
        캐릭터 이름: ${scenario.title}.
        캐릭터 외형: ${scenario.appearance || '매력적인 인물'}.
        성격 및 관계: ${scenario.characterInfo}, ${scenario.worldSetting}.
        최근 대화 상황: ${recentEvents}.
        등장 인물: 화면에는 오직 지정된 1명의 캐릭터만 단독(solo)으로 등장해야 하며, 절대로 캐릭터가 2명 복제되거나 좌우 분할 컷, 비포/애프터 비교 구도가 생기지 않도록 단일 컷으로 그려줘.
        구도 및 카메라 거리: 극단적인 얼굴 클로즈업이나 부담스러운 확대를 엄격히 배제하고, 캐릭터와 카메라 사이에 적당한 거리를 둔 자연스러운 미디엄 샷/카우보이 샷 구도. 캐릭터의 상반신 복장과 헤어스타일, 그리고 주변 실내/배경 공간이 시원하게 보이도록 아름다운 1:1 대화 장면 일러스트를 그려줘.`;
        } else {
            richPrompt = `
        그림 스타일(화풍): ${scenario.artStyle || '수려한 애니메이션 화풍'}.
        캐릭터 외형: ${scenario.appearance || '모험가'}.
        캐릭터 설정: ${scenario.characterInfo || '모험가'}
        배경 세계관: ${scenario.worldSetting || '판타지 세계'}.
        현재 모험 상황: ${recentEvents}.
        ${currentEquipString}.
        등장 인물: 화면에는 오직 주인공 1명만 단독(solo)으로 등장해야 하며, 복제/분할 컷/2명 등장을 배제한 단일 컷 일러스트.
        구도 및 카메라 거리: 과도한 얼굴 클로즈업 없이, 주인공의 전신 혹은 상반신(카우보이 샷)과 주변 배경이 넓고 웅장하게 펼쳐지는 시네마틱 와이드 미디엄 샷 구도.`;
        }

        const fallbackPrompt = buildSafeCharacterPrompt(scenario, 'scene');
        const { response, responseText } = await requestFactChatImage(richPrompt, apiKey, fallbackPrompt, scenario.mode === 'chatbot', 'scene');

        if (!response.ok) {
            logError('장면 삽화 생성 FactChat API 오류 (/api/generate-image)', new Error(`HTTP ${response.status}: ${responseText}`), {
                status: response.status,
                prompt: richPrompt
            });
            return res.status(response.status).send(responseText);
        }

        const data = JSON.parse(responseText);
        let extractedImage = (data.data && data.data[0] && (data.data[0].url || data.data[0].b64_json)) || data.url || data.b64_json;

        if (extractedImage) {
            if (!extractedImage.startsWith('http') && !extractedImage.startsWith('data:image')) {
                extractedImage = `data:image/png;base64,${extractedImage}`;
            }

            const savedUrl = await saveBase64Image(extractedImage, 'scene', scenarioId);
            console.log("✅ 이미지 생성 및 저장 완료! 경로:", savedUrl);
            res.json({ imageUrl: savedUrl });
        } else {
            throw new Error("이미지 URL 추출 실패: " + responseText.slice(0, 300));
        }

    } catch (error) {
        logError('장면 이미지 생성 처리 실패 (/api/generate-image)', error, { scenarioId: req.body && req.body.scenarioId });
        res.status(500).json({ error: error.message });
    }
});

// [추가] 생성된 이미지 URL을 DB에 저장하는 API
app.post('/api/chat/save-image', async (req, res) => {
    try {
        let { scenarioId, role, content } = req.body;
        if (content && typeof content === 'string' && content.startsWith('data:image')) {
            content = await saveBase64Image(content, 'chat', scenarioId);
        }
        await Message.create({
            scenarioId,
            role: role || 'assistant',
            content: content
        });
        res.json({ success: true, url: content });
    } catch (err) {
        logError('이미지 대화 저장 실패 (/api/chat/save-image)', err, { scenarioId: req.body && req.body.scenarioId });
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

        const apiKey = process.env.OPENAI_API_KEY;

        const equipEntries = (scenario.equipment && typeof scenario.equipment.entries === 'function')
            ? Array.from(scenario.equipment.entries()) 
            : [];
        const wornItems = equipEntries.filter(([k, v]) => v && v !== '없음' && !v.includes('없음'));
        const currentEquipString = wornItems.length > 0 
            ? `착용 장비: ${wornItems.map(([k, v]) => `${k}(${v})`).join(', ')}`
            : "복장: 단정한 여행자 복장";
            
        let imagePrompt = "";
        if (scenario.mode === 'chatbot') {
            imagePrompt = `제타(Zeta) 스타일 매력적인 캐릭터 프로필 일러스트.
            캐릭터 이름: ${scenario.title}
            성격 및 특징: ${scenario.characterInfo}
            외형 묘사: ${scenario.appearance || '매력적인 인물'}
            배경 분위기: ${scenario.worldSetting}
            그림 스타일(화풍): ${scenario.artStyle || '수려한 일러스트, 걸작'}
            등장 인물: 화면에는 오직 1명의 캐릭터만 단독(solo)으로 등장 (복제/분할 컷/2명 등장 엄격히 금지, 단일 컷 일러스트).
            구도 및 카메라 거리: 얼굴만 화면에 꽉 차게 확대된 극단적인 클로즈업을 엄격히 배제하고, 머리부터 허리/가슴까지 의상과 헤어스타일, 배경이 여유롭고 조화롭게 모두 담긴 안정적인 상반신(웨이스트 샷 / 카우보이 샷) 프로필 초상화를 1장 그려줘.`;
        } else {
            imagePrompt = `다음 캐릭터 설정을 바탕으로 플레이어 프로필 초상화를 1장 그려줘. 
            설정: ${scenario.characterInfo}
            그림 스타일(화풍): ${scenario.artStyle || '애니메 스타일'}
            캐릭터 외형: ${scenario.appearance || '기본 외형'}
            ${currentEquipString}.
            등장 인물: 단독(solo) 1인 캐릭터 프로필 일러스트 (복제/분할 컷 금지).
            구도 및 카메라 거리: 얼굴만 확대된 클로즈업을 배제하고, 캐릭터의 머리부터 허리/의상 장비와 배경이 조화롭게 보이는 안정적인 상반신(웨이스트 샷) 구도.`;
        }

        const fallbackPrompt = buildSafeCharacterPrompt(scenario, 'portrait');
        const { response, responseText } = await requestFactChatImage(imagePrompt, apiKey, fallbackPrompt, scenario.mode === 'chatbot', 'portrait');

        if (!response.ok) {
            logError('초상화 생성 FactChat API 오류 (/api/generate-player-image)', new Error(`HTTP ${response.status}: ${responseText}`), {
                status: response.status,
                prompt: imagePrompt
            });
            return res.status(response.status).json({ error: responseText });
        }

        const data = JSON.parse(responseText);
        let extractedImage = (data.data && data.data[0] && (data.data[0].url || data.data[0].b64_json)) || data.url || data.b64_json;

        if (extractedImage) {
            if (!extractedImage.startsWith('http') && !extractedImage.startsWith('data:image')) {
                extractedImage = `data:image/png;base64,${extractedImage}`;
            }

            const savedUrl = await saveBase64Image(extractedImage, 'portrait', scenarioId);
            scenario.playerImageUrl = savedUrl;
            await scenario.save();

            console.log("✅ 플레이어 초상화 생성 및 저장 완료! 경로:", savedUrl);
            res.json({ playerImageUrl: savedUrl });
        } else {
            throw new Error("이미지 URL 추출 실패: " + responseText.slice(0, 300));
        }

    } catch (error) {
        logError('초상화 생성 실패 (/api/generate-player-image)', error, { scenarioId: req.body && req.body.scenarioId });
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
        logError('장비 장착/해제 에러 (/api/scenario/' + req.params.id + '/equip)', err, { body: req.body });
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
        logError('도감 추가 에러 (/api/scenario/' + req.params.id + '/bestiary)', err, { body: req.body });
        res.status(500).send(err.message);
    }
});

// 🚨 8. Express 미처리 에러 핸들러 미들웨어 (모든 라우트 에러를 터미널로 출력)
app.use((err, req, res, next) => {
    logError(`Express 미처리 라우트 에러 [${req.method} ${req.originalUrl}]`, err, {
        userId: req.user ? req.user._id : '비로그인',
        body: req.body
    });
    if (!res.headersSent) {
        res.status(500).json({ error: err.message || "서버 내부 오류가 발생했습니다." });
    }
});

// 📁 기존 루트 이미지 파일들을 시나리오별 폴더로 자동 정리(마이그레이션)
function migrateLegacyImages() {
    try {
        const imgDir = path.join(__dirname, 'public', 'image');
        if (!fs.existsSync(imgDir)) return;
        const entries = fs.readdirSync(imgDir, { withFileTypes: true });
        let movedCount = 0;
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            const filename = entry.name;
            if (filename.startsWith('BG')) continue;
            const match = filename.match(/^(?:nsfw_)?(?:portrait|scene|chat)_([^_]+)/);
            if (match && match[1]) {
                const scenarioId = match[1];
                const targetDir = path.join(imgDir, scenarioId);
                if (!fs.existsSync(targetDir)) {
                    fs.mkdirSync(targetDir, { recursive: true });
                }
                const oldPath = path.join(imgDir, filename);
                const newPath = path.join(targetDir, filename);
                fs.renameSync(oldPath, newPath);
                movedCount++;
            }
        }
        if (movedCount > 0) {
            console.log(`📁 [이미지 폴더 정리 완료] 기존 ${movedCount}개 이미지를 시나리오별 폴더로 이동했습니다.`);
        }
    } catch (err) {
        console.warn("⚠️ [이미지 폴더 정리 경고]", err.message);
    }
}
migrateLegacyImages();

// 9. 서버 실행
const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log("-----------------------------------------");
    console.log(`서버 실행 중: http://0.0.0.0:${PORT}`);
    console.log("-----------------------------------------");
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error("\n" + "!".repeat(65));
        console.error(`🚨 [포트 충돌 오류] 포트 ${PORT}번이 이미 다른 프로세스에 의해 사용 중입니다!`);
        console.error(`👉 기존에 켜져 있는 서버 터미널이나 백그라운드 node.exe를 종료한 후 다시 실행해 주세요.`);
        console.error("!".repeat(65) + "\n");
        process.exit(1);
    } else {
        logError('HTTP 서버 소켓 오류', err);
    }
});