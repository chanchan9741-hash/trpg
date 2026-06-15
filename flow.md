# ⚙️ AI TRPG Engine: Core Architecture & Data Flow

> 본 문서는 AI 기반 다크 판타지 TRPG 웹 게임 엔진의 시스템 구조, 데이터 파이프라인, 그리고 핵심 트러블슈팅 실행 로직을 가시화한 기술 설계서입니다.

---

## 1. 🏗️ 전체 시스템 아키텍처 (System Architecture)

본 엔진은 클라이언트의 UI 요청을 Express 백엔드에서 처리하고, MongoDB 인프라의 가변 데이터 상태를 실시간으로 가로채어 LLM 컨텍스트와 융합하는 **"DB 데이터 - 프롬프트 피드백 순환 구조"**를 가집니다.

```mermaid
graph TD
    subgraph Client [1. Client Layer]
        UI1[좌측 패널: Status UI<br>HP Bar / Gold / 4-Slot Skills]
        UI2[중앙 패널: Chat Window<br>User bubble / Master bubble]
        UI3[우측 패널: Journal<br>Map Monitor / Quest & Logs]
    end

    subgraph Server [2. Backend Server Layer]
        EX[Express Server]
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
2. 🔄 실시간 대화 및 데이터 순환 흐름 (Core Runtime Flow)
유저가 채팅창에 행동(자연어 명령어)을 입력했을 때, 시스템 내부에서 데이터가 동기화되고 파싱되는 정밀 5단계 런타임 수명 주기입니다.

코드 스니펫


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
3. 🛡️ 예외 처리 및 최적화 실행 로직 (Troubleshooting Flow)
3.1 400 Bad Request (Payload Too Large) 예외 차단 로직
DALL-E 3 가 가동되어 생성된 삽화의 거대한 Base64 바이너리가 AI의 컨텍스트 버퍼(History)에 누적될 때 발생하는 토큰 한도 초과 오류를 해결한 제어 흐름입니다.

코드 스니펫


graph TD
    A[Express /api/chat 요청 수신] --> B(DB Message History Array 순회 루프 시작)
    B --> C{텍스트 원문 검사<br>string.startsWith}
    C -->|data:image| D[배열 적재 Skip<br>Context 경량화]
    C -->|http| D
    C -->|일반 서술형 텍스트| E[Buffer에 Safe Push]
    D --> F[루프 지속]
    E --> F
    F --> G[압축된 버퍼만 AI 백본으로 전송]
3.2 Mongoose Map 하이브리드 변환 (데이터 증발 방지)
MongoDB(Mongoose) 환경에서 수동으로 Map 객체를 수정하거나 덮어쓸 때 발생하는 데이터 소화 불량(동기화 미반영) 현상을 우회하는 가변 포장 처리 파이프라인입니다.

코드 스니펫


graph LR
    A[AI 마스터가 생성한<br>몬스터 도감 데이터 수신] --> B[Scenario 스키마 내<br>bestiary 인스턴스 확보]
    B --> C[Mongoose 고질적 버그 대응<br>Object.fromEntries 변환 적용]
    C --> D[(깔끔한 JSON 오브젝트 형식으로<br>MongoDB 영구 저장 및 리턴)]
🔮 4. Next-Step: Spring Boot 마이그레이션 아키텍처
단일 파일(server.js) 기반의 절차지향적 구조를 엔터프라이즈 레벨의 역할 기반 계층형 아키텍처(Layered Architecture)로 완전 분리하는 청사진입니다.

코드 스니펫


graph LR
    subgraph Spring [Spring Boot Layered Architecture]
        Ctrl[ChatController<br>- API 요청 접수<br>- JSON 객체 매핑]
        Serv[TRPGMasterService<br>- Spring AI LLM 제어<br>- 가성비 스냅샷 요약]
        Repo[ScenarioRepository<br>- Spring Data MongoDB<br>- 무결성 쿼리 수행]
        Parser[TagParser Component<br>- Java Stream API<br>- 정규식 독립 컴포넌트]
    end

    Ctrl --> Serv
    Serv --> Repo
    Serv --> Parser
