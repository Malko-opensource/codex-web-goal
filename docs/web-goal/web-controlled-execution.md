# Web 주도 실행·검증: 구현과 남은 연결 조건

## 구현 상태

후속 [공통 위임 계약](shared-delegation.md)에서 일반 요청·결과 종류·자료·로컬 지원 경로를 추가했다.
이 문서의 검사기·필수 검증 완료 설명은 기본 `verified-files` 계약에 해당한다. 저장 형식은 현재 v3다.

`local-supervised`는 기존 기본값이다. `web-controlled`는 명시적인 실행 정책과 호스트 대기 소켓이
모두 필요하다. 실제 Codex 호스트 스케줄러의 소스·대기 훅은 이 저장소에 없으므로 무모델 대기 기능
전체는 미완료다. 비공개 Codex RPC를 추측하거나 Goal pause를 외부 대기로 위장하지 않는다.
인앱 브라우저 어댑터도 아직 별도 호스트 구현이 필요하다.

| 경계 | 구현 | 남은 검증/조건 |
| --- | --- | --- |
| 맥락 | digest·버전·출처·원문 참조·명시적인 누락 표시와 수락 | 지시를 실제로 이해했다는 보장은 아님 |
| 호스트 | 전용 UNIX 소켓 어댑터, park/reconcile/resume-once/revoke 계약 | 실제 호스트 스케줄러 연결·0회 모델 호출 검증 |
| 실행 | Mac Seatbelt, 작업 사본, clean env, watchdog, 공개 인터넷 proxy | 도구별 라이브러리 경로와 실제 프로젝트 검증 |
| 완료 | 고정 검사·revision·파일 read-back·seal·checkpoint | 의미적 요구사항 평가는 별도, 네이티브 Goal은 미변경 |
| 복구 | 실행 ID·wake 영수증, 재시작 실행은 uncertain | 고의적인 process-group 이탈 자손의 완전 정리 미검증 |

## 맥락 및 작업 계약

로컬 모델은 `web_goal_dispatch.context_details`에 constraints, instructions(text/source), decisions,
openQuestions, references(path/sha256), historyOmitted를 보낸다. 관련 AGENTS.md와 workspace revision도
고정한다. 필수 내용을 자르는 대신 총 60,000자 한도를 초과하면 요청을 거부한다. 로컬 전체 대화나
시스템 지시가 자동 공유되는 것이 아니며 저장소 지침의 원문 출처도 승인 정책과 구별한다.

Web은 `worker_context`로 정본을 읽고, 같은 도구의 `acknowledge_digest`로 수락을 기록한다.
쓰기·실행·완료에는 `context_version`과 `policy_version`이 필요하다. 수동 Web 메시지는 권한이나
목적을 변경하지 않는다. 추가 권한이 필요하면 `worker_finish(outcome=blocked)`로 요청한다.

사용자 입력/목적이 바뀌면 호스트는 기존 lease를 즉시 무효화한다. 로컬의
`web_goal_invalidate_context`는 현재 turn의 쓰기·실행·대기 알림을 회수한다. 기존 토큰은 부활하지
않는다. 부분 효과를 확인하고 resume 후 새 request_id와 맥락으로 dispatch한다. 정책 변경은 새
세션으로만 승인한다. 이미 수락된 외부 효과는 취소만으로 되돌리지 않는다.

## 실행 정책과 도구

`web_goal_open.execution_policy` 예시(실제 프로젝트에 맞는 검사기와 산출물을 지정):

```json
{
  "mode": "web-controlled",
  "network": "public-internet",
  "checks": [{"id": "required", "argv": ["node", "verify.cjs"], "cwd": "."}],
  "protectedFiles": ["verify.cjs", "package-lock.json"],
  "expectedFiles": ["src/result.js"]
}
```

검사기 원문은 세션 시작 때 SHA로 고정한다. 실행 사본에서도 OS 정책으로 해당 파일 쓰기·삭제와
상위 디렉터리 이름 변경을 거부한다. Web은 해당 파일을 수정할 수 없고 로컬에서 바뀌어도
정책을 다시 승인해야 한다. protectedFiles에는 검사기뿐 아니라 실행을 제어하는 스크립트·설정도
포함한다. 검사기는 '검사 0개/skip만 발생'을 스스로 실패 처리해야 한다. exit 0만으로 테스트의
충분성을 증명하지 않는다. 테스트/런처를 동적으로 소스에서 교체하는 정책은 신뢰 가능한 기준이 아니다.

- `workspace_exec`: argv/cwd, 선택적 localServices(0~4), request_id, 버전으로 자유 진단.
- `workspace_verify`: Web 입력의 성공 주장 없이 고정된 checks 전체 실행.
- `workspace_job_result`: run_id와 cursor로 최대 32,000자 로그 구간, 검사·산출물 hash 조회.
- `workspace_job_cancel`: 자기 turn의 실행 취소. 원본 변경을 롤백하지 않음.

같은 request_id는 기존 실행을 반환한다. 본문이 다르면 충돌이다. `uncertain` 실행을 자동 재시작하지
않는다. 정상 테스트 실패는 Web이 수정하고 새로운 검증 요청을 한다. `worker_finish`는 이 반복의
마지막에만 호출한다. 성공은 같은 맥락/정책의 verify run, 모든 검사 성공, expectedFiles read-back,
현재 revision 일치가 필요하며 브리지가 seal과 checkpoint를 기록한다. 중간 답변은 작업 종료가 아니다.

사본은 실행마다 새로 만든다. node_modules 등 기존 제외 디렉터리를 암묵 공유하지 않는다. 필요한
의존성 준비 명령을 진단 argv 또는 고정 checks에 포함한다. 사본의 수정은 자동 반영하지 않으며
검증 도중 소스가 바뀌면 stale이다. 수정 내용을 사용하려면 출력으로 확인하고 SHA 파일 도구로
명시적으로 적용한 뒤 다시 검증한다. 현재 산출물 조회는 manifest와 로그이며 범용 바이너리 다운로드
서비스가 아니다. 작업 사본은 실행 후 정리하며 원본·상태·파일 백업은 삭제하지 않는다.

기본값: 동시 실행 1개, 명령/검증 묶음 10분, 세션 누적 실행 30분, 검증 5회. 세션 시작 시 설정할 수
있으며 소진은 완료가 아니라 needs_attention이다. 로그 1,000,000자를 넘는 실행은 중단한다.

## 실행기 설정

브리지 시작 시 `--host-wait-socket /absolute/private.sock`을 명시해야 새 모드를 사용할 수 있다.
이 옵션은 호스트를 구현하거나 설치하지 않는다. 소켓은 사용자 소유의 0600 UNIX 소켓이어야 한다.
`--tool-root`는 반복 가능하며 Node 등 실행 파일과 필요한 dylib의 **정규화된 설치 경로**만 지정한다.
빈 설정에는 macOS 시스템 도구만 있다. Homebrew Node는 bin 경로만으로 동작하지 않을 수 있다.
라이브러리 접근 실패를 전체 홈 디렉터리 읽기 허용으로 우회하지 않는다.

실행기는 `sandbox-exec`의 독립 정책을 적용한다. Codex CLI의 모델이나 승인 검토자를 호출하지
않는다. 기본 읽기 경계에 `/System/Volumes/Data`가 포함되지 않도록 `/System` 전체를 허용하지 않는다.
인터넷은 HTTP proxy/CONNECT를 통하며 직접 소켓 접근은 차단한다. HTTP(S) proxy를 지원하지 않는
개발 도구는 연결 방식을 조정해야 한다. 공개 인터넷 허용은 배포/push나 회사 데이터 반출 승인이 아니다.
`--deny-egress-host`로 공개 브리지 터널 호스트도 차단한다. DNS의 모든 응답을 검사하고 실제 연결에는
검사한 IP를 고정한다. localhost·사설망·metadata·IPv4-mapped IPv6는 차단한다.

localServices를 요청하면 커널이 예약한 loopback listener를 자식 FD 3부터 전달한다.
`WEB_GOAL_LOCAL_SERVICES`에 fd/port 배열이 들어간다. 테스트 서버는 해당 FD를 인수해야 한다
(Node 예: `server.listen({fd: service.fd})`). 포트 번호만 확보하고 풀어 버리는 경쟁 조건을 피한다.
임의의 `listen(0)`과 모든 localhost 접근을 허용하지 않는다. FD 전달을 지원하지 않는 런타임은 실패한다.

## 호스트 개발자가 구현할 계약

모든 요청은 `POST /web-goal/v1/<route>`이다. 이는 이 프로젝트의 새 프로토콜이며 Codex App Server
메서드가 아니다. SocketDelegationHost가 스키마와 binding/영수증 일치를 검사한다.

| route | 입력/필수 의미 |
| --- | --- |
| capabilities | protocol=1, externalWait/durableWakeReceipts/userInputInvalidation=true |
| park | sessionId/turnId/threadId/goalFingerprint/contextVersion/policyVersion, 동일 binding에 멱등 |
| reconcile | 기존 lease, 실제 scheduler 상태·갱신된 만료 시각 반환 |
| resume-once | lease와 event, 사용자 입력 세대 확인 + 영구 영수증 + 재개 예약을 원자 처리 |
| revoke | lease 무효화, 같은 요청 반복 허용, 사용자 Goal을 자동 재개하지 않음 |

lease에는 binding 필드와 leaseId/state/expiresAt이 들어간다. state는 waiting_external/resumed/revoked/
unknown이다. resume-once는 eventId와 accepted/revoked를 반환한다. 응답 유실 후 같은 event를 다시
받으면 영수증을 반환하고 모델 요청을 중복 생성하지 않는다. 호스트는 이벤트 스트림뿐 아니라
**도구 결과 후 모델 호출과 Goal 자동 continuation**을 scheduler 경계에서 차단해야 한다.
park 응답 전에 이 경계를 확정한다. 사용자 pause와 waiting_external을 동일 상태로 구현하지 않는다.
사용자 입력·목적 교체·예산 제한 시 lease 및 오래된 wake를 무효화한다.

실제 호스트 어댑터가 없으면 HOST_INTEGRATION_REQUIRED로 차단한다. 실제 호스트에서 정상 대기
구간의 모델 요청 0회 및 사용자 중단 후 재개 금지가 입증되기 전에는 이 기능을 완료로 판정하지 않는다.
현재 기본 CodexClient는 계속 조회 전용이다. 실제 호스트 구현을 위한 소스/공식 확장 지점 확보가 남아 있다.

## 저장과 관측

state v3는 contexts(각 turn), frozen policy, runs, wakeEvents와 로컬 지원·MCP 호출 기록을 저장한다. v1/v2를 읽으면 0600 원본 백업을
남기고 기존 세션의 모드를 바꾸지 않는다. 재시작 시 queued/running 실행은 uncertain으로 남긴다.
web_goal_snapshot은 전체 이력 없이 단계·맥락·실행·예산·wake 상태를 반환한다.
UI 폴링과 호스트 상태 조회는 프로그램 작업이며 모델 호출이 아니다. 회복 가능한 실패/진행 이벤트는
로컬 모델에 전달하지 않는다. 해결되지 않는 전송 재조정은 2분 후 사용자 확인 대상으로 올린다.

검증은 `npm test`, `npm run build`, `npm run test:browser`를 사용한다. 실제 Mac 격리 검사는
`WEB_GOAL_SANDBOX_TESTS=1 node --import tsx --test test/runner.test.ts`로 별도 실행한다.
테스트용 canary만 사용하며 실제 개인 ChatGPT 대화나 인증값을 테스트에 넣지 않는다.
출력·호출 수·실행 시간은 측정 가능하지만 실제 Codex/ChatGPT 토큰 사용량을 추정해서 채우지 않는다.
