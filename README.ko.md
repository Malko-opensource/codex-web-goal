# Codex Web Goal

[English](README.md) · 한국어

**Web authors. Local Codex verifies.**

> **실험적 프로젝트:** 합성 브라우저 테스트와 네이티브 Codex 프로토콜 검증을 통과했습니다.
> 실제 ChatGPT 계정과 네이티브 Goal 자동 반복의 종단 간 동작은 아직 검증하지 않았습니다.

ChatGPT Web의 실제 Chrome 대화와 로컬 Codex의 네이티브 `/goal`을 연결하는 독립적인 MIT 오픈소스입니다.
기존 프로젝트의 어댑터나 ChatGPT API 프록시가 아닙니다. TypeScript로 처음부터 작성했습니다.

```text
사용자 → 로컬 Codex /goal
           ↓ 다음 작업 · 검증 결과
        로컬 브리지 → Chrome 확장 → 선택한 ChatGPT Web 대화
           ↑                            ↓ 읽기 · 코드/문서 편집
           └──────── 로컬 MCP ← HTTPS 터널
           ↓ Web 편집 종료 → 소스 상태 고정
        로컬 Codex 실행/검증 → 중간점검 → 다음 Web 작업
```

GitLab/GitHub 서버는 작업 전달 경로에 없습니다. VPN으로 clone한 **로컬 저장소**를 지정하면 됩니다.
Commit, push, MR/PR 생성은 필수 단계가 아니며 브리지가 자동 수행하지 않습니다.

## 들어 있는 것

- **일반 Web 작업:** 제한된 워크스페이스 파일 읽기·검색·작성·정확한 부분 수정·삭제. 명령 실행은 로컬 화면에서 건별 승인.
- **네이티브 Goal 연동:** 로컬 Codex가 다음 작업과 중간점검을 보내고, Web이 작성하며, Codex가 실행·검증·완료 판단.
- **Plan 세션:** 서버에서 Web 파일 변경과 명령 실행을 차단하는 읽기 전용 모드.
- **Chrome MV3 확장:** 선택한 대화에 메시지를 보내고 DOM에서 응답 회수. 쿠키 추출이나 비공개 ChatGPT API 사용 없음.
- **로컬 대시보드:** 연결, 목표, Web 응답, 단계 기록, 일시정지/종료, 일반 작업 명령 승인/중지.
- **복구:** 저장된 요청 ID, 전송 직전 기록, 파일 변경 기록, 백업, 재연결 후 확인. 불확실한 전송은 재전송하지 않음.
- **배포 구성:** Codex 플러그인, 명시 호출용 `$web-goal` 스킬, Chrome ZIP, 테스트, GitHub CI.

## 사전 조건과 지원 범위

- Node.js **22.16 이상**, npm, Chrome.
- 네이티브 `/goal`, `--remote`, App Server Goal 메서드를 제공하는 Codex CLI. **0.153.4에서 프로토콜 확인**.
- ChatGPT Web에서 사용자 지정 MCP 연결을 추가할 수 있는 계정/워크스페이스 권한.
- ngrok 또는 동등한 HTTPS 전달 경로. **MCP 포트만** 전달합니다.
- 조직의 소스 반출 규정과 ChatGPT 이용 조건을 확인하세요. Web에 전달한 코드/로그는 온프레미스에만 머물지 않습니다.

기준 실행 경로는 **이 프로젝트가 시작한 App Server에 연결한 Codex CLI**입니다.
이미 열려 있는 Codex Desktop 작업에 자동으로 붙는 기능은 제공하지 않습니다.
동시에 개발자 1명·워크스페이스 1개·브리지 세션 1개·Web 대화 1개를 다룹니다.
워크스페이스별 별도 프로세스/상태 디렉터리/포트를 쓰려면 App Server 주소도 별도로 지정해야 합니다.

## 시작하기

### 1. 빌드와 Codex 플러그인 설치

```sh
git clone https://github.com/Malko-opensource/codex-web-goal.git
cd codex-web-goal
npm ci
npm run build
node dist/cli.js install-plugin
```

마지막 명령은 이 로컬 저장소를 Codex marketplace로 등록하고 플러그인을 설치합니다.
사용자 Codex 설정에 설치 내역이 기록됩니다. **빌드 자체는 설정을 변경하지 않습니다.**
설치 전에 플러그인과 스킬을 검토하고, 설치 후 Codex를 새로 시작하세요.
이 저장소 경로를 이동했다면 새 경로에서 다시 등록해야 합니다.

### 2. 로컬 브리지 시작

```sh
node dist/cli.js start --workspace /absolute/path/to/your/repo
```

출력되는 Dashboard URL을 여세요. 기본 포트는 다음과 같습니다.

| 포트 | 역할 | 외부 공개 |
| --- | --- | --- |
| 43120 | ChatGPT용 MCP | HTTPS 터널로 이 포트만 |
| 43121 | 대시보드·확장·로컬 제어 | 금지 |
| 43122 | 네이티브 Codex App Server | 금지 |

기본 상태는 `~/.local/share/codex-web-goal`에 저장됩니다. `--state-dir /absolute/private/dir`로 변경할 수 있습니다.
상태 디렉터리는 저장소 외부 또는 저장소의 `.web-goal` 안에 두세요. 토큰과 코드 백업이 포함되므로 공유/커밋하지 마세요.
별도 상태 디렉터리를 쓸 때는 모든 CLI 명령에 같은 `--state-dir`를 전달하세요.

### 3. ChatGPT에 로컬 MCP 연결

다른 터미널에서 실행합니다.

```sh
ngrok http 43120
```

ChatGPT 설정에서 개발자 모드를 활성화하고 사용자 지정 MCP 연결을 추가합니다.
CLI가 출력한 `/mcp/<비밀 토큰>` 경로를 ngrok의 HTTPS 주소 뒤에 그대로 붙이세요.
예: `https://your-tunnel.example/mcp/<token>`.
앱 인증 항목은 별도 OAuth를 제공하지 않는 연결로 설정합니다. URL 토큰 자체가 접근 권한입니다.

새 ChatGPT 대화에 해당 MCP 연결을 선택하고 간단한 메시지를 보내 `/c/...` 주소가 생기게 하세요.
`workspace_info`, `workspace_list` 호출로 원하는 로컬 저장소가 보이는지 확인합니다.
계정/워크스페이스 정책에 따라 개발자 모드와 연결 메뉴가 다를 수 있습니다.
[OpenAI의 현재 MCP 연결 안내](https://developers.openai.com/plugins/deploy/connect-chatgpt)를 함께 확인하세요.

Web의 도구 승인·로그인·보안 확인·이용량 제한은 자동 우회하지 않습니다. 필요한 승인은 직접 처리하세요.
이 프로젝트는 무인 실행 가능 여부나 ChatGPT 서비스 정책상 허용 여부를 보장하지 않습니다.

### 4. Chrome 확장 연결

1. `chrome://extensions`에서 개발자 모드를 켭니다.
2. **압축해제된 확장 프로그램 로드**로 빌드된 `extension/` 디렉터리를 선택합니다.
3. 로컬 대시보드에서 페어링 코드를 생성합니다. 코드는 5분 동안 유효하며 한 번만 사용됩니다.
4. 확장 팝업에서 `http://127.0.0.1:43121`과 코드를 입력하여 연결합니다.
5. 사용할 ChatGPT 대화 탭을 활성화한 뒤 확장에서 **이 채팅 연결**을 선택합니다.

대시보드에서 Chrome 연결과 대화 URL을 확인하세요. Goal 중에는 다른 대화로 바꿀 수 없습니다.

### 5. 실제 Codex Goal 시작

```sh
node dist/cli.js codex
```

열린 **Codex 터미널 안에서** 다음과 같이 요청합니다. 쉘 명령이 아닙니다.

```text
/goal $web-goal 로그인 오류를 수정하고 관련 테스트가 통과할 때까지 진행해.
설계·문서·코드는 연결된 ChatGPT Web에서 작성하고, 실행·검증은 로컬에서 해.
```

이 문법을 지원하지 않는 Codex 버전에서는 `/goal`로 목표를 먼저 설정한 뒤 `$web-goal`을 명시적으로 호출하세요.
Codex는 네이티브 목표를 확인하고 Web 턴마다 로컬 검증 결과를 전달합니다. 브리지는 목표 완료를 대신 선언하지 않습니다.

Plan만 원하면 Codex에서 Plan 모드를 켜고 `$web-goal`로 설계를 요청하세요.
구현할 때는 읽기 전용 브리지 세션을 종료하고, 구현 승인을 담은 네이티브 Goal을 새로 연결합니다.

## 일반 Web 사용

Goal 없이 파일 작업만 하려면 `start --no-codex --workspace /absolute/repo`로 시작해도 됩니다.
Web에서 MCP를 선택하고 파일 읽기/수정을 요청하세요. Chrome 확장은 자동 Goal 메시지 왕복에만 필요합니다.
일반 작업의 명령은 대시보드에서 **정확한 명령과 실행 위치를 검토한 뒤** 승인합니다.
승인된 명령은 운영체제의 사용자 권한으로 실행됩니다. Codex 샌드박스 안에서 실행되는 것이 아닙니다.

## 상태·중단·재시작

```sh
node dist/cli.js status
node dist/cli.js doctor
node dist/cli.js codex --thread-id <기존-네이티브-작업-ID>
```

- 일시정지/종료는 Web 편집 권한을 회수합니다. 이미 반영된 파일은 되돌리지 않습니다.
- 브리지 종료는 브리지가 시작한 Codex App Server도 종료합니다. 재시작 뒤 기존 Codex 작업을 다시 여세요.
- Chrome 연결은 자동 재시도합니다. 확인된 전송은 이어 관찰하며, 전송 여부가 불확실하면 멈춥니다.
- 네이티브 Goal이 일시정지/완료/교체되거나 조회가 실패하면 브리지를 정지합니다. 원인을 해소한 뒤 로컬에서 재개하세요.
- 재개해도 과거 편집 토큰은 살아나지 않습니다. Codex가 부분 변경을 점검하고 새 턴을 발급합니다.
- 같은 Web 대화의 수동 메시지는 로컬 Goal 지시로 수집하지 않습니다. **Web 모델의 대화 문맥은 공유되므로 영향까지 격리되지는 않습니다.**

[복구 절차 및 제한](docs/OPERATIONS.md) · [설계/상태 계약](docs/ARCHITECTURE.md) · [보안 경계](SECURITY.md)

## 개발과 검증

```sh
npm test
npm run build
npx playwright install chromium
npm run test:browser
npm run test:codex
npm run release
```

브라우저 테스트는 실제 확장과 MCP를 사용하지만, `chatgpt.com` 페이지를 합성 fixture로 치환합니다.
실제 계정, 로그인, ChatGPT 모델 응답은 사용하지 않습니다. `test:codex`도 모델을 호출하지 않습니다.
**실제 ChatGPT UI 및 네이티브 Goal 자동 반복의 계정 기반 종단 간 검증은 별도로 필요합니다.**
[실행한 검증과 미검증 범위](docs/VERIFICATION.md)를 분리해서 기록했습니다.

`release/`에 Chrome/플러그인 ZIP과 SHA256SUMS가 생성됩니다. 빌드·테스트·release 명령은 외부에 게시하지 않습니다.
언어 선택의 이유는 브라우저 확장·MCP·로컬 UI의 데이터 계약을 하나의 TypeScript 코드베이스에서 유지하기 위해서입니다.
Electron이나 별도 데이터베이스 서버는 필요하지 않습니다.

MIT. OpenAI 또는 GitLab의 공식 제품이 아닙니다. 새 프로젝트이며 다른 저장소의 구현을 복사하지 않았습니다.
