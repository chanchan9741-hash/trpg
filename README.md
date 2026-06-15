# ⚔️📜 AI-Driven Web TRPG Engine

> **"DB 데이터 - 프롬프트 피드백 순환 구조(NER 기법)"** 기반의 독창적인 웹 기반 다크 판타지 TRPG 게임 엔진입니다. 유저의 선택과 AI 마스터의 상호작용을 실시간으로 정밀하게 제어하며, 몰입감 넘치는 텍스트 어드벤처 환경을 제공합니다.

---

## 🚀 Key Features (주요 기능)

* **클래식 3단 패널 UI/UX**
    * **좌측 패널:** 플레이어 초상화, 실시간 HP 바, 금화(Gold) 정보, 4칸 스킬창 UI
    * **중앙 패널:** 청회색(플레이어) 및 흰색(마스터) 말풍선으로 정렬되는 실시간 채팅창
    * **우측 패널:** 현재 위치 지도 UI 및 모달 팝업 형태의 모험 일지/가방(인벤토리) 통합 관리
* **시나리오 관리 및 완벽한 새 게임(Reset) 기능**
    * AI api를 통해 데이터 저장과 분석, 
    * 모달의 답답함을 탈출한 단독 시나리오 생성/수정/삭제 전용 페이지 구축
    * 시나리오 삭제 시 연관된 대화 로그(`Message` 컬렉션)까지 완벽하게 동시 삭제 (Cascade API)
    * 단순 로그 청소를 넘어 DB 수치(HP 100, 0G, 장소, 도감 등)를 초기화하고 브라우저를 리로드하는 '새 게임 시작' API 구현

---

## 🛠 Tech Stack (사용 기술)

| 분류 | 기술 스택 |
| :--- | :--- |
| **Front-end** | HTML5, CSS3, JavaScript (Vanilla/ES6+) |
| **Back-end** | Node.js, Express |
| **Database** | MongoDB, Mongoose ORM |
| **Authentication** | Google OAuth 2.0 |
| **AI Integration** | LLM API, NER(개체명 인식) 기반 프롬프트 엔지니어링 |

---

## 💾 Data Architecture (데이터 구조)

* **인증 및 계정 데이터:** Google OAuth 2.0을 통해 전달받는 유저 식별 정보(`googleId`, `username`, `email`) 기반의 세션 관리
* **실시간 인게임 상태(State):** 플레이어의 실시간 변동 데이터 (`hp`, `gold`, 최대 4개의 `skills`)
* **구조화된 인벤토리 (Mongoose Map Stack):** 자바스크립트 Map 객체를 활용하여 `{"체력 포션": 3, "롱소드": 1}` 형태의 **[아이템명: 수량]** Key-Value 스택 관리
* **실시간 몬스터 도감(Bestiary):** AI가 생성한 적의 스펙(`name`, `hp`, `atk`, `def`, `loot`)을 실시간 DB 영구 동기화
* **대화 및 이미지 로그:** 타임스탬프 기반 컬렉션(`Message`)을 통해 텍스트 로그 및 동적 생성 삽화 URL(Base64) 관리

---

## ⚡ Troubleshooting & Optimization (주요 버그 수정 내역)

### 1. Mongoose Map 객체 데이터 소화 불량 해결
* **문제:** MongoDB가 자바스크립트 내장 Map 데이터를 수동으로 덮어쓸 때 데이터가 유실되는 현상 발생.
* **해결:** `Object.fromEntries(map.entries())` 객체 변환 포장 처리를 통해 DB 저장 및 프론트 전송 안정성 100% 확보.

### 2. "게임을 시작해줘" 오프닝 무한 증식 버그 수정
* **문제:** 새로고침 시 초기 데이터 공백을 인지하고 `start()` 오프닝 서술 함수가 중복 실행되는 현상.
* **해결:** 첫 질문은 DB에 남기지 않고 깔끔하게 오프닝 타이밍만 잡도록 로직 정비.

### 3. AI 컨텍스트 토큰 초과(400 Bad Request) 에러 원천 차단
* **문제:** 생성된 삽화의 거대한 Base64 암호문 덩어리가 AI 대화 히스토리에 그대로 묶여 들어가 토큰 한도를 초과하는 현상 (`PayloadTooLargeError`).
* **해결:** AI에게 컨텍스트를 보낼 때 `startsWith('data:image')` 및 `startsWith('http')`를 걸러내는 데이터 필터링 파이프라인 배치로 에러 원인 제거.

### 4. 비동기 타이밍 및 중복 선언(SyntaxError) 정비
* **문제:** 코드 확장 과정에서 `Scenario has already been declared` 등의 변수 중복 선언 및 자바스크립트 비동기 순서 뒤틀림 발생.
* **해결:** 스코프 정비 및 비동기 흐름(`async/await`) 구조 통합 정리.

---

## 🔮 Future Roadmap (향후 확장 계획)

* **비즈니스 로직 독창성 확보:** 본 프로젝트의 핵심인 **"DB 데이터 - 프롬프트 피드백 순환 구조(NER 기법 기반)"** 아키텍처 특허 출원 검토
* **Spring Boot 마이그레이션:** 대규모 트래픽 대비 및 유지보수성 향상을 위해 거대한 `server.js`를 역할별로 쪼개는 아키텍처 재설계 계획 수립
    * `Controller`: 프론트 접수 및 응답 처리
    * `TRPGMasterService`: Spring AI 프레임워크 기반 LLM 연동 및 흐름 제어
    * `TagParser`: 정규식 및 스트림 API를 활용한 태그 전문 분리 파서 컴포넌트 화
