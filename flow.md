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
