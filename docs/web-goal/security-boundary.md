# 보안 경계

## 보호 대상

선택형 실행 모드의 OS 격리·clean env·공개 인터넷 proxy·예약 listener FD·watchdog와 잔여 한계는
[실행 경계](web-controlled-execution.md)를 따른다. Codex 승인·샌드박스의 자동 상속은 없고 기존
turn token 노출 문제도 해결된 것이 아니다. 고의적인 process-group 이탈 정리와 실제 호스트 대기를
검증하기 전에는 hostile-code/회사 소스의 production-ready 판정을 하지 않는다.

- MCP capability token, 대시보드 token, 확장 credential, 일회성 pairing code
- turn write token과 요청 marker
- 공개 터널의 token 포함 전체 URL
- 실제 대화 URL, 소스 코드, 파일 백업, 브리지 상태 snapshot
- 브라우저 스크린샷, 접근성 트리, DOM dump, 오류 메시지와 자동화 trace

접근성 출력과 화면 검사는 단순 진단 자료가 아니라 민감 로그 경계다. 수집 전 최소 범위를 정하고,
저장·공유·이슈 첨부 전에 token, 터널 URL, 대화 URL, 실제 소스를 마스킹한다.

## 현재 경계와 알려진 한계

**[현재 구현]** 공개되는 것은 MCP 포트뿐이며 URL의 capability token으로 접근을 제한한다. 제어 포트와
Codex App Server는 loopback에 남는다. 확장은 별도 credential과 Origin 검사를 사용하고, 파일 쓰기는
turn token·예상 SHA·연산 ID로 제한한다.

**[현재 구현의 한계]** turn token은 Web 모델이 도구 인자로 사용해야 하므로 현재 visible prompt에
포함된다. 따라서 ChatGPT 대화 DOM, 접근성 트리, 화면 캡처에서 완전히 분리되어 있지 않다. 이 상태를
프로덕션 수준의 비밀 분리로 설명하면 안 된다.

**[요구/미결정]** turn token을 화면에 노출하지 않으면서도 turn별 최소 권한과 replay 방지를 유지할
수 있는 별도 전달 채널 또는 서버 측 세션 바인딩을 설계해야 한다. MCP URL token 하나로 현재 turn을
암묵 승인하면 권한 범위가 넓어질 수 있으므로 대안 검토 없이 적용하지 않는다.

## 운영 규칙

- token 또는 token 포함 URL을 프롬프트 본문, 로그, 스크린샷, 접근성 트리, 공개 이슈에 남기지 않는다.
- 자동 마스킹은 base64url 형태뿐 아니라 `/mcp/<token>`, Bearer 값, tunnel URL 전체를 다룬다.
- 공개 터널 origin과 인증 경로를 설정·표시·로그에서 분리한다.
- token 노출 시 브리지와 터널을 먼저 중지하고 새 private state로 credential을 재발급한다.
- 인증 없는 커넥터 설정은 capability URL을 사용하는 임시 개발 환경에서만 허용한다.
- 조직 코드에는 짧은 수명의 인증 또는 서명 요청을 권장하되, 실제 지원 여부는 별도 검증한다.
- 로그인, 보안 확인, CAPTCHA, 도구 승인을 자동화하거나 우회하지 않는다.

## 배포 전 차단 조건

민감 DOM/접근성 출력의 자동 마스킹, token 회전, 실제 계정에서의 재연결, 조직 데이터 반출 승인 중
하나라도 확인되지 않으면 회사 소스에 대한 production-ready 판정을 내리지 않는다.
