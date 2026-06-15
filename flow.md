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
