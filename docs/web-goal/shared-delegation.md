# 일반 요청과 Goal의 공통 Web 위임

## 현재 구현과 경계

일반 요청의 전체 또는 일부를 Web에 맡기고 원래 대화로 돌려받는 계약을 Goal 관리와 분리했다.
`DelegationRuntime`은 맥락·실행·완료·복구를, `DelegationSupport`는 선택 자료·외부 MCP·로컬 지원 요청을
소유한다. 둘은 같은 브리지 프로세스의 모듈이며 별도 서비스가 아니다. 기존 `WebExecution` export는
호환용 별칭이다. 네이티브 Goal 생성·수정·완료 API를 새로 호출하지 않는다.

| 경로 | 바인딩 | 최종 수락 주체 |
| --- | --- | --- |
| 일반 요청 | threadId + origin.requestId/inputVersion | 원래 요청의 로컬 대화 |
| Goal | threadId + goalFingerprint | 네이티브 Goal |
| 공통 내부 작업 | sessionId/turnId + contextVersion/policyVersion | 위임 결과·효과를 브리지가 기록; 상위 목적 완료는 별도 |

**실제 Codex 호스트 연동은 여전히 미완료**다. 사용자 입력에 대응하는 requestId/inputVersion 취득,
대기 중 자동 모델 호출 억제, 원래 대화로의 재개, 첨부 자산 내보내기는 실제 호스트 구현이 필요하다.
합성 호스트의 모델 요청 0회/단일 재개 테스트는 실제 Codex 사용량 검증이 아니다. 지원이 없으면
일반 위임을 거부하며 Goal 생성이나 모델 폴링으로 대체하지 않는다. 기존 direct 모드는 유지한다.

## 일반 요청 시작

`delegation_open` 입력 예시(호스트가 확인할 실제 원래 요청 식별자를 사용):

```json
{
  "kind": "request",
  "thread_id": "origin-thread-id",
  "origin_request_id": "origin-request-id",
  "input_version": 1,
  "objective": "이 변경의 영향을 분석하고 원래 대화로 설명을 반환한다",
  "policy": {
    "mode": "web-controlled",
    "network": "public-internet",
    "resultKind": "answer"
  }
}
```

일반 요청에는 활성 Goal이 필요 없다. 실제 Goal은 같은 도구의 `kind=goal` 또는 기존 `web_goal_open`으로
연결한다. 이미 열린 세션을 다른 목적·모드·정책으로 자동 전환하지 않는다.
`delegation_dispatch`로 위임하고 `worker_context`의 digest를 Web이 수락해야 효과를 허용한다.
`delegation_status`는 작은 관찰값, `delegation_result(turn_id)`는 저장된 최종 결과를 반환한다.
`delegation_control`은 브리지의 pause/resume/cancel/close이며 네이티브 Goal을 변경하지 않는다.

### 결과 계약

| policy.resultKind | 필수 조건 | 허용되지 않는 추론 |
| --- | --- | --- |
| answer | 맥락 수락, 원본 revision 유지, 답변 및 선택적 evidence/unresolved 기록 | 실행 검증을 통과했다는 주장 |
| files | 예상 파일 모두 존재, read-back, 읽는 동안 revision 유지 | 테스트 통과 주장 |
| verified-files (기존 기본값) | 고정 검사 전체 통과, 검사기 보호, 예상 파일 read-back, 동일 revision | 해당 위임이 전체 Goal을 완료했다는 주장 |

answer는 파일 쓰기·로컬 명령 실행 권한이 없다. files/answer에 필수 실행 검사를 지정하면 정책을
거부한다. 필요한 검사를 생략하려고 resultKind를 낮추는 것은 허용된 최적화가 아니다. Web은 이 값을
변경할 수 없다. 파일 작업의 임의 진단은 실행기가 구성된 경우에만 허용한다.

`worker_finish`의 evidence/unresolved는 Web의 평가로 기록하며 실행기 증거와 구별한다.
result_captured는 자료 수집·seal이지 runner_validated가 아니다. 완료 후보의 결과와 원래 요청
바인딩을 호스트 wake 이벤트에 함께 보낸다. 동일 이벤트 영수증을 재사용하며 새 모델 턴을 중복 생성하지
않는 것은 호스트의 원자적 의무다. 사용자 입력 버전 변경은 오래된 효과와 결과 복귀보다 우선한다.

## 선택 자료와 도구 등록

브리지 시작 시 `--resource-manifest /absolute/private.json`을 지정한다. 설정은 원격 쓰기 가능한
워크스페이스 밖 또는 보호된 `.web-goal` 안에 둔다. 아래 경로는 예시이며 자동 탐색·생성하지 않는다.

```json
{
  "resources": [
    {
      "id": "writing-skill", "kind": "skill", "description": "선택한 작성 지침",
      "root": "/absolute/canonical/skill",
      "files": ["SKILL.md", "references/style.md"]
    },
    {
      "id": "reference-image", "kind": "image", "description": "사용자가 선택한 참고 이미지",
      "path": "/absolute/canonical/reference.png"
    }
  ],
  "capabilities": [
    {
      "id": "selected-service-tool", "description": "승인 후 실행할 특정 MCP 도구",
      "url": "http://127.0.0.1:45000/mcp", "tool": "selected_tool",
      "inputSchema": {"type": "object", "properties": {"item_id": {"type": "string"}}, "required": ["item_id"]},
      "headerEnv": {"Authorization": "SELECTED_MCP_AUTH_HEADER"}
    }
  ]
}
```

- `headerEnv`는 헤더 값이 아니라 환경변수 이름이다. 값은 승인된 호출 시 실행 측에서만 읽는다.
- 카탈로그는 등록된 이름·설명·digest·참고 schema만 노출한다. 로컬 경로·endpoint·인증값을 프롬프트로
  전달하지 않는다. inputSchema는 사용 설명용이고 실제 인자 검사는 해당 MCP 서버가 책임진다.
- `delegation_catalog`로 목록을 먼저 읽고 `context_details.resourceIds/capabilityIds`로 필요한 것만
  선택한다. 등록만으로 Web에 전체 접근 권한이 생기지 않는다. 선택한 자료·도구의 digest를 맥락에 고정한다.
- 스킬은 명시적으로 열거한 UTF-8 파일만 제공한다. `SKILL.md`는 필수이며 원문을 조용히 절단하지 않는다.
  `worker_resource_read`의 cursor로 전체를 읽는다. 선언하지 않은 참조·템플릿이 필요하면 로컬에 요청한다.
  로컬 절대경로와 Codex 전용 도구 이름이 Web에서 그대로 작동한다고 가정하지 않는다.
- 이미지 제한은 8 MiB, PNG/JPEG/WebP이며 링크 파일과 알려진 자격 증명 파일은 거부한다. 반환은 MCP
  image content다. **브라우저 composer 업로드, ChatGPT의 실제 이미지 해석, Codex 첨부 자동 가져오기는
  구현되지 않았다.** 반환 바이트와 hash는 전달 증거이지 모델 이해의 증거가 아니다.
- 자료가 등록 후 바뀌면 RESOURCE_STALE로 거부한다. 재시작 때 새 구성을 읽고 새 맥락을 승인해야 한다.
  설정/자료에 담긴 조직 정보를 외부 Web 서비스로 전송할 권한은 사용자가 별도로 확인해야 한다.

### MCP 중계의 별도 신뢰 경계

`worker_capability_request`는 고정된 capability ID와 인자로 요청을 저장한다. **모든 호출은 로컬
대시보드에서 정확한 인자를 승인한 후** 전송한다. 현재 선택적 Streamable HTTP MCP 중계만 지원하며,
모든 플러그인·stdio 서버를 자동 설치하거나 노출하지 않는다. 게시·삭제 승인을 카탈로그 선택으로 대체하지 않는다.

이 중계는 Mac 사본 실행기와 다르다. 실제 파일·네트워크·서비스 권한은 해당 MCP 서버가 집행한다.
Codex 승인·Seatbelt를 상속하지 않는다. 신뢰 가능한 서버와 최소 권한 자격 증명을 설정해야 하며,
승인된 도구의 숨은 부작용까지 브리지가 증명하지 못한다. 리디렉션은 허용하지 않는다.

요청 ID와 승인 내용은 먼저 저장한다. 실행 도중 재시작·전송 실패·취소는 uncertain으로 남기고 자동
재전송하지 않는다. 외부 효과 취소는 롤백이 아니다. 승인 대기·실행·불확실한 효과가 남아 있으면 쓰기와
완료를 막는다. Web은 `worker_finish(outcome=blocked)`로 조정을 요청할 수 있고, 로컬은 기존 서비스의
실제 상태를 확인한 뒤 새 맥락에서 계속한다. 승인되지 않은 대기 호출은 중단 시 폐기한다.

결과는 최대 32,000자를 보관하고 `worker_capability_result`는 기본 4,000자와 cursor만 반환한다.
비텍스트 upstream resource/image는 자동 재전달하지 않으며 tool output을 권한이나 지시로 승격하지 않는다.

## 로컬 Codex 지원 경로

`worker_request_local(request_id, task, reason)`은 정상적인 협업 경로다. 진행 중·불확실한 효과를 먼저
정리하고, Web의 새 효과를 중지한 뒤 `local_assistance` 이벤트를 원래 대화로 전달한다. 기본 한도는
세션당 3회이며 `maxLocalAssists`로 시작 시 설정한다. 이 한도는 무한 왕복 방지이며 품질 저하 허가가 아니다.

로컬은 허용된 기능·판단을 수행하고 `delegation_assistance_result`로 resolved/declined와 요약을 기록한다.
이때 오래된 사용자 입력 세대의 반환은 거부한다. 반환된 turn은 handed_off이며 실패나 완료로 세지 않는다.
기존 token은 폐기하고, 로컬이 변경 사항을 확인한 다음 resume + 새 request_id/context로 다시 위임한다.
반환 요약 자체로 정책·목적이 변경되거나 Web 권한이 자동 부활하지 않는다.

호스트 capabilities에 일반 요청은 `ordinaryRequests=true`, 로컬 지원은 `localAssistance=true`가 필요하다.
기존 `/web-goal/v1` 계약의 선택적 확장이며 지원 플래그 없는 호스트를 지원한다고 추정하지 않는다.
원래 요청/입력 세대는 호스트가 실제 스케줄러와 대조해야 하며, 호출자가 제공한 문자열만 믿어서는 안 된다.

## 관측과 호환성

state v3는 v1/v2 원문을 권한 0600으로 백업하고 assistance/capability 기록을 추가한다. 기존 세션,
맥락·검사기 digest·실행 결과를 재작성하거나 새 모드로 자동 전환하지 않는다. 되돌릴 때는 브리지를 정지하고
미확인 외부 효과를 먼저 조정한다. 백업 복원은 외부 효과를 되돌리지 않는다.

현재 측정값은 실행 횟수·시간·보관 로그량·로컬 지원 요청 수이며 실제 네이티브 Goal 토큰은 조회될 때만
표시한다. 일반 요청의 로컬 토큰/모델 요청 수, Web 사용량, 자산 처리 토큰은 아직 unknown이다.
호스트 사용량 계측 후에는 **완료한 원래 작업당 로컬 토큰·소요 시간·성공률·재작업률**로 비교한다.
완료 후보 수나 호출 0회를 성공률로 대신하지 않는다. 정상 대기에서 모델 폴링을 제거하되, 유용한 로컬
판단까지 금지하지 않는다. 기존 [실행 격리의 미검증 범위](web-controlled-execution.md)는 그대로 남는다.
