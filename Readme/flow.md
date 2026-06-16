<img src="https://img.shields.io/badge/MongoDB-47A148?style=for-the-badge&logo=mongodb&logoColor=white"> <img src="https://img.shields.io/badge/Passport.js-34E27A?style=for-the-badge&logo=passport&logoColor=black"> <img src="https://img.shields.io/badge/Google_OAuth-4285F4?style=for-the-badge&logo=google&logoColor=white">


# 데이터 흐름 구조
## 💾 Data Architecture (데이터 구조)

* **인증 및 계정 데이터:** Google OAuth 2.0을 통해 전달받는 유저 식별 정보(`googleId`, `username`, `email`) 기반의 세션 관리
* **실시간 인게임 상태(State):** 플레이어의 실시간 변동 데이터 (`hp`, `gold`, 최대 4개의 `skills`)
* **구조화된 인벤토리 (Mongoose Map Stack):** 자바스크립트 Map 객체를 활용하여 `{"체력 포션": 3, "롱소드": 1}` 형태의 **[아이템명: 수량]** Key-Value 스택 관리
* **실시간 몬스터 도감(Bestiary):** AI가 생성한 적의 스펙(`name`, `hp`, `atk`, `def`, `loot`)을 실시간 DB 동기화
* **대화 및 이미지 로그:** 타임스탬프 기반 컬렉션(`Message`)을 통해 텍스트 로그 및 동적 생성 삽화 URL(Base64) 관리



## 1. 🔄 실시간 대화 및 데이터 순환 흐름 (Core Sequence)

유저가 말풍선 채팅창에 자연어 명령어(행동)를 입력했을 때, Express 서버가 데이터 무결성을 확보하고 AI 마스터의 컨텍스트를 가공하여 MongoDB와 최종 동기화하는 정밀 시퀀스 흐름입니다.

```mermaid
graph TD
    subgraph Client [1. Client Layer]
        UI1[좌측 패널: Status UI<br>HP Bar / Gold / 4-Slot Skills]
        UI2[중앙 패널: Chat Window<br>User bubble / Master bubble]
        UI3[우측 패널: Journal<br>Map Monitor / Quest & Logs]
    end

    subgraph Server [2. Backend Server Layer]
        EX[Express Server Core]
        RT[Routing Engine<br>/api/chat, /api/scenario]
        HP[History Proxy & Image Filter<br>Filter Base64 Strings]
        TP[Regex TagParser Component<br>Extract 시스템 제어 태그]
    end

    subgraph Infra [3. Infrastructure Layer]
        DB[(MongoDB Atlas)]
        SC[Scenarios Collection<br>State, Quests Map]
        MS[Messages Collection<br>Logs, Image Link Archive]
        AI[AI Hub Engine<br>GPT-4o-mini & DALL-E 3]
    end

    %% 연결 관계 %%
    UI1 & UI2 & UI3 <-->|SSE / JSON Response| EX
    EX --> RT
    RT --> HP --> TP
    TP <-->|Mongoose ODM| DB
    DB --- SC & MS
    EX <-->|API Call| AI
```

## 2.🧱 시스템 데이터 레이어 구조 (Data Architecture)
엔진이 처리하는 데이터의 성격과 특징에 따라 비정형 문서(Document), 정형 세션(Session), 가변 구조(Map)를 유기적으로 배치한 인프라 구조도입니다.

```mermaid
sequenceDiagram
    autonumber
    actor User as 플레이어 (Client)
    participant Server as Express 서버
    participant DB as MongoDB
    participant AI as AI 마스터 (LLM)

    User->>Server: 자연어 행동 명령어 입력 (/api/chat)
    Note over Server: 1. Context History 조립 및<br>이미지 필터링 인터셉터 작동<br>(Base64 / HTTP 주소 원천 제거)
    Server->>DB: 최근 대화 세션 로그 10개 조회
    DB-->>Server: 필터링된 대화 내역 반환
    
    Note over Server: 2. System Prompt 및 State 결합<br>현재 시나리오 스펙 주입<br>(HP, Gold, 스킬, 병렬 퀘스트 맵)
    Server->>AI: 압축된 컨텍스트 및 프롬프트 전송
    AI-->>Server: 마스터 응답 문장 반환 (Raw Text)
    
    Note over Server: 3. Express TagParser 컴포넌트 작동<br>시스템 제어 특수 태그 분석<br>e.g., [도감등록: 멧돼지|30|8|2]<br>e.g., [상태변동: HP -15]
    Server->>DB: Object.fromEntries 변환 후 가변 포장 처리 데이터 영구 저장
    DB-->>Server: DB 동기화 완료 응답
    
    Server->>User: 파싱 완료된 순수 서술형 스토리 및 실시간 UI 업데이트 응답
    Note over User: 채팅창 말풍선 정렬 및<br>HP 바 / 인벤토리 / 도감 동적 렌더링
```

## 🛡️ 3. 예외 처리 및 최적화 제어 흐름 (Troubleshooting Flow)
1.  400 Bad Request (Payload Too Large) 예외 차단
DALL-E 3 가 가동되어 생성된 거대한 이미지 데이터가 대화 히스토리 버퍼에 누적되어 토큰 한도를 폭파시키는 에러(PayloadTooLargeError)를 방어하는 프록시 단의 전처리 알고리즘입니다.
    ```mermaid
    graph TD
    A[Express /api/chat 요청 수신] --> B(DB Message History Array 순회 루프 시작)
    B --> C{텍스트 원문 검사<br>string.startsWith}
    C -->|data:image| D[배열 적재 Skip<br>Context 경량화]
    C -->|http| D
    C -->|일반 서술형 텍스트| E[Buffer에 Safe Push]
    D --> F[루프 지속]
    E --> F
    F --> G[압축된 버퍼만 AI 백본으로 전송]
    ```

2. Mongoose Map 하이브리드 동기화 (데이터 유실 방지)
MongoDB 스키마 내부에서 자바스크립트 내장 Map 형태로 관리되는 인벤토리 및 도감 객체를 덮어쓸 때, 변경 사항이 무시되거나 증발하는 현상을 해결하기 위해 설계된 데이터 포장 가변 파이프라인입니다.

    ```mermaid
    graph LR
    A[AI 마스터가 생성한<br>몬스터 도감 데이터 수신] --> B[Scenario 스키마 내<br>bestiary 인스턴스 확보]
    B --> C[Mongoose 고질적 버그 대응<br>Object.fromEntries 변환 적용]
    C --> D[(깔끔한 JSON 오브젝트 형식으로<br>MongoDB 영구 저장 및 리턴)]
    ```

