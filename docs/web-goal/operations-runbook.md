# 운영 런북

## 시작 전 preflight

1. 브리지와 네이티브 App Server가 같은 로컬 워크스페이스를 가리키는지 확인한다.
2. 확장 상태의 `connected`와 대화 URL의 `bound`를 각각 확인한다.
3. ChatGPT에서 `workspace_info`를 호출해 절대 경로와 모드를 확인한다.
4. `workspace_list`와 `workspace_read`로 기대한 파일을 읽는다.
5. 쓰기 작업이면 폐기 가능한 검증 파일 또는 이번 작업 대상에 SHA 기반 쓰기가 가능한지 확인한다.
6. 자동 Goal 턴이면 `worker_context`와 `worker_finish` 계약을 확인한다.

MCP 연결 성공이나 도구 목록 노출만으로 preflight 통과로 판정하지 않는다. 실환경 수용 테스트에서는
`workspace_info → list/read → write → read-back → worker_finish`까지 확인한다.

## 정상 작업 사이클

아래 10단계는 기본 local-supervised 모드다. web-controlled는 [새 실행 런북](web-controlled-execution.md)
대로 park 확인 후 맥락을 수락하고 Web이 검증까지 반복한다. 로컬 모델이 대기 도구를 반복 호출하거나
같은 테스트를 재실행하지 않는다. 호스트 미지원은 폴링 대체가 아니라 활성화 차단이다.

1. 로컬 감독자가 새 `request_id`, 한정된 작업, 현재 checkpoint, 수용 조건을 등록한다.
2. 브리지가 `queued`를 기록한 뒤 확장에 전달한다.
3. 확장은 실제 전송 버튼을 클릭하고 대화의 marker를 확인해 `submitted`를 보고한다.
4. Web worker가 `worker_context`를 호출하면 `working`을 기록한다.
5. 여러 산출물은 예상 파일 체크리스트와 적용 파일 수로 추적한다.
6. Web worker가 모든 변경을 마치고 `worker_finish`를 호출한다.
7. 브리지가 Web 답변을 회수한 뒤 seal하여 쓰기 grant를 폐기하고 source revision을 고정한다.
8. 로컬 감독자가 예상 파일 목록과 내용을 다시 읽고 diff, 테스트, 빌드 등 필요한 검증을 실행한다.
9. 같은 revision에 checkpoint를 기록한다. 실패하거나 drift가 있으면 완료하지 않는다.
10. 전체 수용 조건을 만족한 경우에만 네이티브 Goal 완료를 판단하고 브리지 세션을 닫는다.

## 완료 판정

다음 조건을 모두 확인한다.

- 예상 파일이 실제 워크스페이스에 존재한다.
- 각 파일의 목록과 필요한 내용 또는 SHA를 read-back했다.
- `worker_finish`가 해당 turn에서 수신되었다.
- Web 답변이 같은 marker 뒤에서 회수되었다.
- 쓰기 grant가 폐기되고 검증 대상 revision이 seal되었다.
- 로컬 검증이 같은 revision에서 통과했다.
- 전체 목표라면 네이티브 Goal의 수용 조건도 충족했고 세션 종료가 기록되었다.

`submitted`, ChatGPT 답변 텍스트, `worker_finish`, 파일 생성, checkpoint는 서로를 대신하지 않는다.

## 중단·재시작

- 탭 새로고침/재생성: 같은 대화 URL을 열어 자동 재바인딩과 기존 turn 재조정을 기다린다.
- 대화 URL 변경: 현재 세션을 멈추고 기존 turn을 조정한 뒤 명시적으로 새 대화를 선택한다.
- 확장 팝업이 전면 창: 작업 대화 탭을 활성화한 뒤 바인딩을 확인한다.
- 네트워크/터널 단절: MCP 호출을 멈추고 기존 작업의 외부 효과를 조회한다.
- 오래된 TUI 표시: `web_goal_status`를 새로 읽고 브리지 이벤트 및 파일 상태와 대조한다.
- 권한 승인 재등장: 승인을 우회하지 않는다. 승인 전후 동일 turn인지 확인한다.

불확실한 전송의 상세 절차는 [상태와 재조정](state-and-reconciliation.md), 증상별 조치는
[트러블슈팅](troubleshooting.md)을 따른다.
