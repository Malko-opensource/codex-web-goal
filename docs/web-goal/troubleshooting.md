# 트러블슈팅

| 증상 | 구분할 상태 | 안전한 확인 | 다음 행동 | 금지 행동 |
| --- | --- | --- | --- | --- |
| 확장에 Connected가 보이나 작업이 안 감 | `connected` 대 `bound` | 브리지의 대화 URL과 실제 활성 URL 비교 | 같은 `/c/...` 대화를 열고 재바인딩/재조정 | 새 요청 생성 |
| 탭 새로고침 뒤 응답 관찰이 멈춤 | `reconnecting`, `stale` | 같은 URL 탭 ID가 브리지에 갱신됐는지 확인 | 자동 재바인딩을 기다린 뒤 기존 turn 조회 | 프롬프트 재전송 |
| 탭을 닫았다 다시 열었음 | `disconnected` 또는 `blocked` | 정규화 URL 일치, content script 응답 확인 | 같은 URL로 열고 확장 연결 복구 | 다른 대화에 자동 전환 |
| 전송 결과가 `uncertain` | 전달 결과 불명 | 요청 ID, 전송 저널, marker, 입력창, 브리지 이벤트 대조 | 기존 요청을 reconciliation | 확인 없는 재전송 |
| 입력창은 비었지만 메시지가 없음 | `uncertain` | 대화에 marker가 실제 존재하는지 확인 | 불확실 유지, 반복 안전성 판단 | 빈 입력창만으로 성공 판정 |
| Enter가 줄바꿈함 | DOM 동작 차이 | 전송 버튼 존재·활성 상태 확인 | 실제 전송 버튼 사용 | 키보드 Enter 의미에 의존 |
| 브리지는 `submitted`, TUI는 종료 제안 | TUI 상태 `stale` | `web_goal_status`, worker 상태, 파일 상태 새로 조회 | 브리지 turn을 먼저 끝내거나 조정 | 오래된 TUI 표시만으로 종료 |
| ChatGPT 답변은 있으나 파일이 없음 | `answered` 대 산출물 미완료 | 예상 파일 list/read와 operation 기록 확인 | 기존 turn의 worker/파일 효과 조정 | 답변 텍스트로 완료 처리 |
| 파일은 있으나 `worker_finish` 없음 | `files_written`, worker 미완료 | 같은 turn token의 finish 이벤트 확인 | 가능하면 기존 turn을 finish; 아니면 로컬 조정 | 새 token으로 과거 turn 재개 |
| `worker_finish`는 있으나 검증 안 됨 | `worker_finished` | seal revision과 checkpoint 확인 | seal 후 같은 revision 로컬 검증 | 바로 완료 처리 |
| seal 뒤 파일이 바뀜 | `stale`/`WORKSPACE_DRIFT` | 현재 source revision 비교 | 변경 검토, reseal, 검증 재실행 | 예전 checkpoint 재사용 |
| 권한 승인이 반복됨 | 외부 승인 미확정 | 현재 turn, 계정, 승인 대상 도구 확인 | 단계별 승인 후 상태 재조회 | 승인 우회 또는 무인 재시도 |
| token이 화면/로그에 노출됨 | 보안 사고 | 노출 범위와 credential 종류 식별 | 브리지·터널 중지, 폐기·재발급, 로그 정리 | 같은 token 계속 사용 |
| 인앱 브라우저에 ChatGPT를 열었으나 전달 안 됨 | 지원되지 않는 작업 탭 | Chrome 확장/content script 존재 여부 확인 | 인앱에는 대시보드를 열고 ChatGPT 작업 탭은 Chrome 사용 | 연결 표시만 보고 작업 탭으로 간주 |

## 한 번에 진단할 항목

새 모드의 추가 오류:

- `HOST_INTEGRATION_REQUIRED`/`HOST_NOT_PARKED`: 실제 호스트 훅과 private socket 확인. 모델 폴링 대체 금지.
- `CONTEXT_STALE`: 정본 digest·버전 재조회. 오래된 효과 요청 재전송 금지.
- `POLICY_STALE`/`PROTECTED_CHECK`: 검사기 변경. 새 세션 정책 승인 전 통과 처리 금지.
- `RUN_ACTIVE`: 현재 사본 실행을 기다리거나 취소한 후 원본 수정.
- `EXECUTION_UNCERTAIN`: 기존 run과 부분 효과 조사. 새 ID 자동 실행 금지.
- `EXECUTION_BUDGET`: 예산 소진은 완료가 아님. 결과를 보존하고 판단 요청.
- `WORKSPACE_DRIFT`: 원본을 재검증. 예전 verify run으로 finish 금지.
- dylib 접근 차단: 필요한 설치 경로만 tool-root 지정. 전체 홈/System 읽기 허용으로 우회 금지.

현재 `doctor` 결과에 더해 운영자는 다음을 한 화면에서 확인할 수 있어야 한다.

- 브라우저 WebSocket 연결과 마지막 heartbeat 시각
- 저장된 대화 URL, 실제 탭 URL/ID, content script 응답
- 터널 health와 MCP `workspace_info`
- 활성 네이티브 thread/Goal fingerprint
- 요청 ID와 전달·worker·validation 진행 상태
- 예상 파일, 적용 파일, read-back, seal revision, checkpoint
- `uncertain` 또는 `stale`의 원인과 마지막 권위 관찰 시각

이 통합 진단은 **[요구]**이며 현재 CLI가 모든 항목을 한 명령으로 보장한다는 뜻은 아니다.
