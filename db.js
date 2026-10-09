const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');

const { getFirestore } = require('firebase-admin/firestore');

// 1. Firebase Admin SDK 초기화
let serviceAccount = null;
const localKeyPath = path.join(__dirname, 'serviceAccountKey.json');
const renderKeyPath = '/etc/secrets/serviceAccountKey.json';
const keyPath = fs.existsSync(localKeyPath) ? localKeyPath : (fs.existsSync(renderKeyPath) ? renderKeyPath : null);

if (keyPath) {
    try {
        serviceAccount = require(keyPath);
        console.log(`📄 [Firebase] 키 파일(${keyPath})을 로드했습니다.`);
    } catch (e) {
        console.error("❌ [Firebase] 키 파일 읽기 실패:", e.message);
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
        mode: data.mode || 'trpg', // 'trpg' | 'chatbot'
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
                mode: this.mode || 'trpg',
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
        mode: data.mode || 'trpg',
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
            mode: this.mode || 'trpg',
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
        if (this.playerImageUrl && this.playerImageUrl.startsWith('data:image')) {
            this.playerImageUrl = await saveCloudImage(this.playerImageUrl, 'portrait', ref.id);
            await ref.update({ playerImageUrl: this.playerImageUrl });
        }
        return this;
    };
}

class FirestoreQuery {
    constructor(execFn) {
        this._execFn = execFn;
        this._sort = null;
        this._limit = null;
    }

    sort(sortOption) {
        this._sort = sortOption;
        return this;
    }

    limit(n) {
        this._limit = n;
        return this;
    }

    async exec() {
        let list = await this._execFn();
        if (!Array.isArray(list)) return list;

        if (this._sort) {
            if (typeof this._sort === 'object') {
                const [field, order] = Object.entries(this._sort)[0] || [];
                if (field) {
                    list = [...list].sort((a, b) => {
                        let valA = a[field];
                        let valB = b[field];
                        if (valA instanceof Date) valA = valA.getTime();
                        if (valB instanceof Date) valB = valB.getTime();
                        if (valA === undefined) return 1;
                        if (valB === undefined) return -1;
                        return order === -1 ? (valB > valA ? 1 : (valB < valA ? -1 : 0)) : (valA > valB ? 1 : (valA < valB ? -1 : 0));
                    });
                }
            } else if (typeof this._sort === 'function') {
                list = [...list].sort(this._sort);
            }
        }

        if (typeof this._limit === 'number' && this._limit >= 0) {
            list = list.slice(0, this._limit);
        }

        return list;
    }

    then(onFulfilled, onRejected) {
        return this.exec().then(onFulfilled, onRejected);
    }

    catch(onRejected) {
        return this.exec().catch(onRejected);
    }
}

ScenarioModel.find = function(query) {
    return new FirestoreQuery(async () => {
        const firestore = checkDb();
        let ref = firestore.collection('scenarios');
        if (query && query.userId) {
            ref = ref.where('userId', '==', query.userId);
        }
        const snap = await ref.get();
        return snap.docs.map(doc => wrapScenario(doc.id, doc.data()));
    });
};

ScenarioModel.findById = async function(id) {
    const firestore = checkDb();
    const doc = await firestore.collection('scenarios').doc(id).get();
    if (!doc.exists) return null;
    return wrapScenario(doc.id, doc.data());
};

ScenarioModel.updateDocument = async function(id, scenario) {
    if (scenario.playerImageUrl && scenario.playerImageUrl.startsWith('data:image')) {
        scenario.playerImageUrl = await saveCloudImage(scenario.playerImageUrl, 'portrait', id);
    }
    const firestore = checkDb();
    const plainData = {
        mode: scenario.mode || 'trpg',
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

// 4. Message 모델 (시나리오별 독립 서브컬렉션: scenarios/{scenarioId}/messages)
const Message = {
    find(query) {
        return new FirestoreQuery(async () => {
            const firestore = checkDb();
            let docs = [];

            // 1) 시나리오별 서브컬렉션에서 먼저 조회
            if (query && query.scenarioId) {
                const subSnap = await firestore.collection('scenarios').doc(query.scenarioId).collection('messages').get();
                if (!subSnap.empty) {
                    docs = subSnap.docs.map(doc => ({
                        _id: doc.id,
                        id: doc.id,
                        ...doc.data(),
                        createdAt: doc.data().createdAt?.toDate ? doc.data().createdAt.toDate() : (doc.data().createdAt ? new Date(doc.data().createdAt) : new Date())
                    }));
                }
            }

            // 2) 만약 서브컬렉션에 없으면 기존 레거시 messages 컬렉션에서 조회 (하위 호환성 100%)
            if (docs.length === 0) {
                let ref = firestore.collection('messages');
                if (query && query.scenarioId) {
                    ref = ref.where('scenarioId', '==', query.scenarioId);
                }
                const snap = await ref.get();
                docs = snap.docs.map(doc => ({
                    _id: doc.id,
                    id: doc.id,
                    ...doc.data(),
                    createdAt: doc.data().createdAt?.toDate ? doc.data().createdAt.toDate() : (doc.data().createdAt ? new Date(doc.data().createdAt) : new Date())
                }));
            }

            return docs;
        });
    },

    async countDocuments(query) {
        const firestore = checkDb();
        if (query && query.scenarioId) {
            const subSnap = await firestore.collection('scenarios').doc(query.scenarioId).collection('messages').get();
            if (!subSnap.empty) return subSnap.size;

            const legacySnap = await firestore.collection('messages').where('scenarioId', '==', query.scenarioId).get();
            return legacySnap.size;
        }
        const snap = await firestore.collection('messages').get();
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

        let ref;
        if (data.scenarioId) {
            // 시나리오 하위 messages 서브컬렉션에 그룹화하여 저장
            ref = await firestore.collection('scenarios').doc(data.scenarioId).collection('messages').add(messageData);
        } else {
            ref = await firestore.collection('messages').add(messageData);
        }
        return { _id: ref.id, id: ref.id, ...messageData };
    },

    async deleteMany(query) {
        const firestore = checkDb();
        let deletedCount = 0;
        if (query && query.scenarioId) {
            // 1) 서브컬렉션 메시지 일괄 삭제
            const subSnap = await firestore.collection('scenarios').doc(query.scenarioId).collection('messages').get();
            if (!subSnap.empty) {
                const batch = firestore.batch();
                subSnap.docs.forEach(doc => batch.delete(doc.ref));
                await batch.commit();
                deletedCount += subSnap.size;
            }

            // 2) 레거시 컬렉션 잔여 메시지 일괄 삭제
            const legacySnap = await firestore.collection('messages').where('scenarioId', '==', query.scenarioId).get();
            if (!legacySnap.empty) {
                const batch = firestore.batch();
                legacySnap.docs.forEach(doc => batch.delete(doc.ref));
                await batch.commit();
                deletedCount += legacySnap.size;
            }
            return { deletedCount };
        }
        return { deletedCount: 0 };
    }
};

// 5. Cloud Image 저장소 (시나리오별 폴더 분할 및 Firestore 청크 분할 영구 보관)
let sharp = null;
try {
    sharp = require('sharp');
} catch (e) {
    console.warn("⚠️ [Sharp] 이미지 압축 라이브러리 미지원 환경, 원본으로 저장합니다.");
}

async function saveCloudImage(base64String, prefix = 'img', scenarioId = null) {
    if (!base64String || typeof base64String !== 'string') return base64String;
    if (base64String.startsWith('http://') || base64String.startsWith('https://') || (base64String.startsWith('/image/') && !base64String.startsWith('/image/data:'))) {
        return base64String;
    }
    const firestore = checkDb();
    try {
        const matches = base64String.match(/^data:image\/([a-zA-Z0-9]+);base64,(.+)$/);
        let ext = 'png';
        let contentType = 'image/png';
        let rawData = base64String;
        if (matches) {
            ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
            contentType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
            rawData = matches[2];
        } else if (base64String.startsWith('data:image')) {
            rawData = base64String.split(',')[1] || base64String;
        }

        let buffer = Buffer.from(rawData, 'base64');
        const origSizeKb = Math.round(buffer.length / 1024);

        // 🚀 [용량 대폭 감축] Sharp를 사용해 768px WebP로 초고효율 압축
        if (sharp) {
            try {
                buffer = await sharp(buffer)
                    .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true })
                    .webp({ quality: 82 })
                    .toBuffer();
                ext = 'webp';
                contentType = 'image/webp';
            } catch (sharpErr) {
                console.warn("⚠️ [Sharp] 이미지 압축 실패, 원본 저장 진행:", sharpErr.message);
            }
        }

        const newSizeKb = Math.round(buffer.length / 1024);

        // 시나리오 ID 자동 감지
        let targetScenarioId = scenarioId;
        let fileType = prefix;
        if (!targetScenarioId && prefix) {
            const m = prefix.match(/^(?:nsfw_)?(scene|portrait|chat)_([a-zA-Z0-9_-]+)/);
            if (m) {
                fileType = m[1];
                targetScenarioId = m[2];
            }
        }

        const timestamp = Date.now();
        const rand = Math.random().toString(36).substring(2, 8);
        const filename = targetScenarioId 
            ? `${fileType}_${timestamp}_${rand}.${ext}`
            : `${prefix}_${timestamp}_${rand}.${ext}`;
        const imageId = targetScenarioId
            ? `${targetScenarioId}_${fileType}_${timestamp}_${rand}`
            : `${prefix}_${timestamp}_${rand}`;

        const CHUNK_SIZE = 700 * 1024;
        const totalChunks = Math.ceil(buffer.length / CHUNK_SIZE);

        const metaRef = targetScenarioId
            ? firestore.collection('scenarios').doc(targetScenarioId).collection('images').doc(imageId)
            : firestore.collection('cloud_images').doc(imageId);

        const batch = firestore.batch();
        batch.set(metaRef, {
            scenarioId: targetScenarioId || null,
            filename,
            contentType,
            ext,
            totalSize: buffer.length,
            totalChunks,
            createdAt: new Date()
        });

        for (let i = 0; i < totalChunks; i++) {
            const chunkBuf = buffer.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
            const chunkRef = metaRef.collection('chunks').doc(String(i));
            batch.set(chunkRef, { data: chunkBuf });
        }
        await batch.commit();

        // 로컬 디스크 캐시 (시나리오별 하위 디렉터리 분리 저장!)
        try {
            const cacheDir = targetScenarioId
                ? path.join(__dirname, 'public', 'image', targetScenarioId)
                : path.join(__dirname, 'public', 'image');
            if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
            fs.writeFileSync(path.join(cacheDir, filename), buffer);
        } catch (_) {}

        const returnedUrl = targetScenarioId ? `/image/${targetScenarioId}/${filename}` : `/image/${filename}`;
        console.log(`☁️ [구글 클라우드 영구 저장 완료] ${returnedUrl} (압축: ${origSizeKb}KB ➡️ ${newSizeKb}KB, ${totalChunks} 청크)`);
        return returnedUrl;
    } catch (err) {
        console.error("❌ 클라우드 이미지 저장 에러:", err.message);
        return base64String;
    }
}

async function getCloudImage(filenameOrId) {
    const firestore = checkDb();
    try {
        let scenarioId = null;
        let cleanName = filenameOrId;

        if (filenameOrId.includes('/')) {
            const parts = filenameOrId.split('/');
            if (parts.length >= 2) {
                scenarioId = parts[0];
                cleanName = parts[parts.length - 1];
            }
        }

        const nameParts = cleanName.split('.');
        const imageId = nameParts.length > 1 ? nameParts.slice(0, -1).join('.') : cleanName;

        if (!scenarioId) {
            const m = cleanName.match(/^(?:nsfw_)?(?:scene|portrait|chat)_([^_]+)/);
            if (m) scenarioId = m[1];
        }

        let metaDoc = null;

        // 1) 시나리오가 특정된 경우: scenarios/{scenarioId}/images/{imageId}
        if (scenarioId) {
            const directDoc = await firestore.collection('scenarios').doc(scenarioId).collection('images').doc(imageId).get();
            if (directDoc.exists) {
                metaDoc = directDoc;
            } else {
                const qSnap = await firestore.collection('scenarios').doc(scenarioId).collection('images').where('filename', '==', cleanName).limit(1).get();
                if (!qSnap.empty) metaDoc = qSnap.docs[0];
            }
        }

        // 2) 못 찾았으면 collectionGroup('images')로 전체 검색
        if (!metaDoc) {
            try {
                const qGroup = await firestore.collectionGroup('images').where('filename', '==', cleanName).limit(1).get();
                if (!qGroup.empty) metaDoc = qGroup.docs[0];
            } catch (_) {}
        }

        // 3) 레거시 root cloud_images 컬렉션 fallback
        if (!metaDoc) {
            let legacyDoc = await firestore.collection('cloud_images').doc(imageId).get();
            if (!legacyDoc.exists) {
                legacyDoc = await firestore.collection('cloud_images').doc(cleanName).get();
            }
            if (!legacyDoc.exists) {
                const qSnap = await firestore.collection('cloud_images').where('filename', '==', cleanName).limit(1).get();
                if (!qSnap.empty) legacyDoc = qSnap.docs[0];
            }
            if (legacyDoc && legacyDoc.exists) metaDoc = legacyDoc;
        }

        if (!metaDoc || !metaDoc.exists) return null;

        const meta = metaDoc.data();
        const chunksSnap = await metaDoc.ref.collection('chunks').get();
        if (chunksSnap.empty) return null;

        const sortedDocs = chunksSnap.docs.sort((a, b) => Number(a.id) - Number(b.id));
        const fullBuffer = Buffer.concat(sortedDocs.map(d => d.data().data));

        return {
            buffer: fullBuffer,
            contentType: meta.contentType || 'image/png',
            scenarioId: meta.scenarioId || scenarioId || null,
            filename: meta.filename || cleanName
        };
    } catch (err) {
        console.error("❌ 클라우드 이미지 읽기 에러:", err.message);
        return null;
    }
}

async function deleteCloudScenarioImages(scenarioId) {
    if (!scenarioId) return;
    const firestore = checkDb();
    try {
        const imgSnap = await firestore.collection('scenarios').doc(scenarioId).collection('images').get();
        for (const doc of imgSnap.docs) {
            const chunksSnap = await doc.ref.collection('chunks').get();
            for (const chunk of chunksSnap.docs) {
                await chunk.ref.delete();
            }
            await doc.ref.delete();
        }
    } catch (_) {}
}

module.exports = {
    db,
    admin,
    User,
    Scenario: ScenarioModel,
    Message,
    saveCloudImage,
    getCloudImage,
    deleteCloudScenarioImages
};
