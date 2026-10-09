const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');

const { getFirestore } = require('firebase-admin/firestore');

// 1. Firebase Admin SDK 초기화
let serviceAccount = null;
const keyPath = path.join(__dirname, 'serviceAccountKey.json');

if (fs.existsSync(keyPath)) {
    try {
        serviceAccount = require(keyPath);
        console.log("📄 [Firebase] serviceAccountKey.json 파일을 로드했습니다.");
    } catch (e) {
        console.error("❌ [Firebase] serviceAccountKey.json 읽기 실패:", e.message);
    }
} else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
        if (process.env.FIREBASE_SERVICE_ACCOUNT.trim().startsWith('{')) {
            serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            console.log("🔑 [Firebase] 환경변수(FIREBASE_SERVICE_ACCOUNT JSON)를 로드했습니다.");
        } else if (fs.existsSync(process.env.FIREBASE_SERVICE_ACCOUNT)) {
            serviceAccount = require(path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT));
            console.log("📄 [Firebase] 환경변수 경로의 키 파일을 로드했습니다.");
        }
    } catch (e) {
        console.error("❌ [Firebase] FIREBASE_SERVICE_ACCOUNT 파싱 실패:", e.message);
    }
} else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    serviceAccount = {
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    };
    console.log("🔑 [Firebase] 개별 환경변수(PROJECT_ID / CLIENT_EMAIL / PRIVATE_KEY)를 로드했습니다.");
}

let db = null;
if (serviceAccount) {
    try {
        if (!admin.getApps().length) {
            admin.initializeApp({
                credential: admin.cert(serviceAccount)
            });
        }
        db = getFirestore();
        console.log("🔥 [Firebase] Firestore 연결 성공!");
    } catch (err) {
        console.error("❌ [Firebase] 초기화 에러:", err.message);
    }
} else {
    console.warn("\n=======================================================");
    console.warn("⚠️  [Firebase] 서비스 계정 키(serviceAccountKey.json)가 없습니다!");
    console.warn("👉 Firebase 콘솔(프로젝트 설정 > 서비스 계정 > 새 비공개 키 생성)");
    console.warn("   에서 다운로드받은 키 파일을 프로젝트 폴더에 넣어주세요.");
    console.warn("=======================================================\n");
}

function checkDb() {
    if (!db) {
        throw new Error("Firebase Firestore가 초기화되지 않았습니다. serviceAccountKey.json 파일을 확인해주세요.");
    }
    return db;
}

// 2. User 모델
const User = {
    async findOne(query) {
        const firestore = checkDb();
        if (query.googleId) {
            const snap = await firestore.collection('users').where('googleId', '==', query.googleId).limit(1).get();
            if (snap.empty) return null;
            const doc = snap.docs[0];
            return { _id: doc.id, id: doc.id, ...doc.data() };
        }
        if (query._id || query.id) {
            return this.findById(query._id || query.id);
        }
        return null;
    },

    async create(data) {
        const firestore = checkDb();
        const userData = {
            googleId: data.googleId,
            username: data.username,
            email: data.email,
            createdAt: new Date()
        };
        const ref = await firestore.collection('users').add(userData);
        return { _id: ref.id, id: ref.id, ...userData };
    },

    async findById(id) {
        const firestore = checkDb();
        const doc = await firestore.collection('users').doc(id).get();
        if (!doc.exists) return null;
        return { _id: doc.id, id: doc.id, ...doc.data() };
    }
};

// 3. Scenario 래퍼 & 모델
function wrapScenario(id, data) {
    if (!data) return null;

    const toMap = (val, defaultVal = {}) => {
        if (val instanceof Map) return val;
        return new Map(Object.entries(val || defaultVal));
    };

    const scenarioObj = {
        _id: id,
        id: id,
        userId: data.userId,
        title: data.title || "",
        worldSetting: data.worldSetting || "",
        characterInfo: data.characterInfo || "",
        appearance: data.appearance || "",
        artStyle: data.artStyle || "고품질의 다크 판타지 유화 스타일, 걸작",
        currentLocation: data.currentLocation || "시작 지점",
        discoveredLocations: data.discoveredLocations || ["시작 지점"],
        hp: data.hp !== undefined ? data.hp : 100,
        maxHp: data.maxHp !== undefined ? data.maxHp : 100,
        gold: data.gold !== undefined ? data.gold : 0,
        party: data.party || [],
        skills: data.skills || ["기본 공격"],
        questLines: data.questLines || [],
        playerImageUrl: data.playerImageUrl || null,
        currentEnemy: data.currentEnemy || null,
        createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : (data.createdAt ? new Date(data.createdAt) : new Date()),

        quests: toMap(data.quests),
        inventory: toMap(data.inventory),
        equipment: toMap(data.equipment, { "투구": "없음", "갑옷": "없음", "상의": "없음", "하의": "없음", "악세사리": "없음", "무기": "없음" }),
        bestiary: toMap(data.bestiary),
        characters: toMap(data.characters),

        markModified: () => {},
        toObject: function() {
            return {
                _id: this._id,
                id: this.id,
                userId: this.userId,
                title: this.title,
                worldSetting: this.worldSetting,
                characterInfo: this.characterInfo,
                appearance: this.appearance,
                artStyle: this.artStyle,
                currentLocation: this.currentLocation,
                discoveredLocations: this.discoveredLocations,
                hp: this.hp,
                maxHp: this.maxHp,
                gold: this.gold,
                party: this.party,
                skills: this.skills,
                questLines: this.questLines,
                playerImageUrl: this.playerImageUrl,
                currentEnemy: this.currentEnemy,
                createdAt: this.createdAt
            };
        },
        async save() {
            await ScenarioModel.updateDocument(this.id, this);
            return this;
        }
    };

    return scenarioObj;
}

function ScenarioModel(data) {
    const defaultData = {
        userId: data.userId,
        title: data.title || "",
        worldSetting: data.worldSetting || "",
        characterInfo: data.characterInfo || "",
        appearance: data.appearance || "",
        artStyle: data.artStyle || "고품질의 다크 판타지 유화 스타일, 걸작",
        questLines: [],
        quests: {},
        inventory: {},
        currentLocation: '시작 지점',
        discoveredLocations: ['시작 지점'],
        hp: 100,
        maxHp: 100,
        gold: 0,
        characters: {},
        party: [],
        skills: ['기본 공격'],
        playerImageUrl: null,
        equipment: { "투구": "없음", "갑옷": "없음", "상의": "없음", "하의": "없음", "악세사리": "없음", "무기": "없음" },
        bestiary: {},
        currentEnemy: null,
        createdAt: new Date()
    };
    Object.assign(this, wrapScenario(null, defaultData));

    this.save = async function() {
        const firestore = checkDb();
        const plainData = {
            userId: this.userId,
            title: this.title,
            worldSetting: this.worldSetting,
            characterInfo: this.characterInfo,
            appearance: this.appearance,
            artStyle: this.artStyle,
            questLines: this.questLines,
            quests: this.quests instanceof Map ? Object.fromEntries(this.quests.entries()) : (this.quests || {}),
            inventory: this.inventory instanceof Map ? Object.fromEntries(this.inventory.entries()) : (this.inventory || {}),
            currentLocation: this.currentLocation,
            discoveredLocations: this.discoveredLocations,
            hp: this.hp,
            maxHp: this.maxHp,
            gold: this.gold,
            characters: this.characters instanceof Map ? Object.fromEntries(this.characters.entries()) : (this.characters || {}),
            party: this.party,
            skills: this.skills,
            playerImageUrl: this.playerImageUrl,
            equipment: this.equipment instanceof Map ? Object.fromEntries(this.equipment.entries()) : (this.equipment || {}),
            bestiary: this.bestiary instanceof Map ? Object.fromEntries(this.bestiary.entries()) : (this.bestiary || {}),
            currentEnemy: this.currentEnemy,
            createdAt: this.createdAt || new Date()
        };
        const ref = await firestore.collection('scenarios').add(plainData);
        this._id = ref.id;
        this.id = ref.id;
        return this;
    };
}

ScenarioModel.find = async function(query) {
    const firestore = checkDb();
    let ref = firestore.collection('scenarios');
    if (query && query.userId) {
        ref = ref.where('userId', '==', query.userId);
    }
    const snap = await ref.get();
    const list = snap.docs.map(doc => wrapScenario(doc.id, doc.data()));

    const result = [...list];
    result.sort = function(comparator) {
        if (comparator && comparator.createdAt === -1) {
            result.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        } else if (typeof comparator === 'function') {
            result.sort(comparator);
        }
        return result;
    };
    // 기본 생성일 기준 내림차순 정렬
    result.sort({ createdAt: -1 });
    return result;
};

ScenarioModel.findById = async function(id) {
    const firestore = checkDb();
    const doc = await firestore.collection('scenarios').doc(id).get();
    if (!doc.exists) return null;
    return wrapScenario(doc.id, doc.data());
};

ScenarioModel.updateDocument = async function(id, scenario) {
    const firestore = checkDb();
    const plainData = {
        title: scenario.title,
        worldSetting: scenario.worldSetting,
        characterInfo: scenario.characterInfo,
        appearance: scenario.appearance || "",
        artStyle: scenario.artStyle || "고품질의 다크 판타지 유화 스타일, 걸작",
        currentLocation: scenario.currentLocation || "시작 지점",
        discoveredLocations: scenario.discoveredLocations || ["시작 지점"],
        hp: scenario.hp !== undefined ? scenario.hp : 100,
        maxHp: scenario.maxHp !== undefined ? scenario.maxHp : 100,
        gold: scenario.gold !== undefined ? scenario.gold : 0,
        party: scenario.party || [],
        skills: scenario.skills || ["기본 공격"],
        questLines: scenario.questLines || [],
        playerImageUrl: scenario.playerImageUrl || null,
        currentEnemy: scenario.currentEnemy || null,
        quests: scenario.quests instanceof Map ? Object.fromEntries(scenario.quests.entries()) : (scenario.quests || {}),
        inventory: scenario.inventory instanceof Map ? Object.fromEntries(scenario.inventory.entries()) : (scenario.inventory || {}),
        equipment: scenario.equipment instanceof Map ? Object.fromEntries(scenario.equipment.entries()) : (scenario.equipment || {}),
        bestiary: scenario.bestiary instanceof Map ? Object.fromEntries(scenario.bestiary.entries()) : (scenario.bestiary || {}),
        characters: scenario.characters instanceof Map ? Object.fromEntries(scenario.characters.entries()) : (scenario.characters || {})
    };
    await firestore.collection('scenarios').doc(id).set(plainData, { merge: true });
};

ScenarioModel.findByIdAndUpdate = async function(id, update) {
    const firestore = checkDb();
    const docRef = firestore.collection('scenarios').doc(id);
    const doc = await docRef.get();
    if (!doc.exists) return null;

    const updateData = update.$set || update;
    const serialized = {};
    for (const [key, val] of Object.entries(updateData)) {
        if (val instanceof Map) {
            serialized[key] = Object.fromEntries(val.entries());
        } else {
            serialized[key] = val;
        }
    }
    await docRef.set(serialized, { merge: true });
    const updatedDoc = await docRef.get();
    return wrapScenario(updatedDoc.id, updatedDoc.data());
};

ScenarioModel.findOneAndUpdate = async function(filter, update, options) {
    const firestore = checkDb();
    const id = filter._id || filter.id;
    const docRef = firestore.collection('scenarios').doc(id);
    const doc = await docRef.get();
    if (!doc.exists) return null;
    const data = doc.data();
    if (filter.userId && data.userId !== filter.userId) return null;

    const updateData = update.$set || update;
    const serialized = {};
    for (const [key, val] of Object.entries(updateData)) {
        if (val instanceof Map) {
            serialized[key] = Object.fromEntries(val.entries());
        } else {
            serialized[key] = val;
        }
    }
    await docRef.set(serialized, { merge: true });
    const updatedDoc = await docRef.get();
    return wrapScenario(updatedDoc.id, updatedDoc.data());
};

ScenarioModel.findOneAndDelete = async function(filter) {
    const firestore = checkDb();
    const id = filter._id || filter.id;
    const docRef = firestore.collection('scenarios').doc(id);
    const doc = await docRef.get();
    if (!doc.exists) return null;
    const data = doc.data();
    if (filter.userId && data.userId !== filter.userId) return null;
    await docRef.delete();
    return wrapScenario(doc.id, data);
};

// 4. Message 모델
const Message = {
    async find(query) {
        const firestore = checkDb();
        let ref = firestore.collection('messages');
        if (query && query.scenarioId) {
            ref = ref.where('scenarioId', '==', query.scenarioId);
        }
        const snap = await ref.get();
        const list = snap.docs.map(doc => {
            const data = doc.data();
            return {
                _id: doc.id,
                id: doc.id,
                ...data,
                createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : (data.createdAt ? new Date(data.createdAt) : new Date())
            };
        });

        const queryResult = [...list];
        queryResult.sort = function(sortObj) {
            if (sortObj && sortObj.createdAt === 1) {
                queryResult.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
            } else if (sortObj && sortObj.createdAt === -1) {
                queryResult.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            }
            return queryResult;
        };

        queryResult.limit = function(n) {
            const limited = queryResult.slice(0, n);
            limited.reverse = () => [...limited].reverse();
            return limited;
        };

        return queryResult;
    },

    async countDocuments(query) {
        const firestore = checkDb();
        let ref = firestore.collection('messages');
        if (query && query.scenarioId) {
            ref = ref.where('scenarioId', '==', query.scenarioId);
        }
        const snap = await ref.get();
        return snap.size;
    },

    async create(data) {
        const firestore = checkDb();
        const messageData = {
            scenarioId: data.scenarioId,
            role: data.role,
            content: data.content,
            createdAt: new Date()
        };
        const ref = await firestore.collection('messages').add(messageData);
        return { _id: ref.id, id: ref.id, ...messageData };
    },

    async deleteMany(query) {
        const firestore = checkDb();
        let ref = firestore.collection('messages');
        if (query && query.scenarioId) {
            ref = ref.where('scenarioId', '==', query.scenarioId);
        }
        const snap = await ref.get();
        if (snap.empty) return { deletedCount: 0 };
        const batch = firestore.batch();
        snap.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        return { deletedCount: snap.size };
    }
};

module.exports = {
    db,
    admin,
    User,
    Scenario: ScenarioModel,
    Message
};
