# 상태와 재조정

## 하나의 상태로 합치지 않는다

`connected → bound → dispatched → submitted → working → worker_finished → locally_validated → sealed`
같은 표시는 사용자에게 유용하지만, 내부에서는 다음 축을 독립 보존해야 한다.

| 축 | 대표 상태 | 권위 |
| --- | --- | --- |
| 연결 | `disconnected`, `connected`, `reconnecting` | 확장과 브리지의 인증된 WebSocket |
| 대화 | `unbound`, `bound`, `stale` | 브리지의 정규화 대화 URL + 확장의 실제 탭 관찰 |
| 전달 | `queued`, `dispatching`, `submitted`, `answered`, `uncertain`, `blocked` | 브리지 전달 저널과 확장 전송 저널 |
| Web 작업 | `not_started`, `working`, `worker_finished` | `worker_context`, `worker_finish` 수신 기록 |
| 산출물 | `not_observed`, `files_written`, `read_back` | 워크스페이스 연산 기록과 실제 파일 조회 |
| 검증 | `not_started`, `sealed`, `locally_validated`, `failed`, `blocked`, `stale` | seal revision과 로컬 checkpoint |
| 전체 Goal | `active`, `paused`, `blocked`, `complete` 등 | 네이티브 Codex Goal |

**[현재 구현]** 기존 `turn.status`는 호환용 대표 상태로 유지하고, 브리지 응답의 `progress`에
전달·작업·검증과 적용 파일 수를 분리한다. 적용 파일 수는 read-back 성공을 뜻하지 않는다.

## 안전한 정상 순서

아래는 기본 local-supervised 순서다. web-controlled는 `맥락 수락 → 작성/실행/수정/재검증 반복 →
worker_finish → 원본 read-back/revision 확인 → 권한 회수/seal/checkpoint → 호스트 완료 후보`를 따른다.
사본 검증 전에는 쓰기 grant를 종료하지 않는다. [새 모드 계약](web-controlled-execution.md)을 따른다.
맥락·정책·호스트 대기·run 결과는 전달 상태와 독립이며 중간 답변은 새 모드의 쓰기를 종료하지 않는다.

```text
connected → bound → dispatching → submitted → working → worker_finished
                                                       ↓
answer captured → sealed(write grant revoked + revision fixed)
                                                       ↓
local read-back + tests → locally_validated → native Goal decision
```

seal은 검증 뒤의 장식이 아니라 **검증할 소스 revision을 먼저 고정하고 원격 쓰기를 회수하는 안전
경계**다. 사용자 화면의 최종 `완료`는 파일 read-back, `worker_finish`, 답변 회수, seal, 로컬 검증,
필요한 전체 Goal 완료가 모두 확인된 뒤에만 표시한다.

## `uncertain` 재조정 규칙

1. 새 `request_id`를 만들거나 같은 요청을 다시 전송하지 않는다.
2. 기존 요청 ID와 확장 저널의 `prepared`/`attempting`/`submitted`/`answered`를 조회한다.
3. 올바른 정규화 대화 URL의 탭을 열고 입력창과 렌더링된 marker 메시지를 확인한다.
4. 브리지 이벤트, 확장 저널, ChatGPT 대화 메시지를 대조한다.
5. marker가 있으면 `submitted`로 복원하고 기존 응답을 관찰한다.
6. `prepared`만 있고 클릭 시도가 없다는 증거가 있을 때만 `queued`로 복원할 수 있다.
7. 클릭 시도는 있으나 marker가 없으면 `uncertain`을 유지한다. 반복 실행의 안전성을 사람이 판단하기
   전에는 새 작업으로 전환하지 않는다.

입력창이 비어 있다는 사실 하나는 전송 성공의 증거가 아니다. 대화의 marker만으로도 파일 변경이나
`worker_finish`를 증명할 수 없다.

## `stale`과 `reconciling`

- `reconnecting`: 전송을 시도하지 않고 확장 WebSocket과 같은 대화 URL의 탭을 복구하는 중이다.
- `reconciling`: 외부 효과를 만들지 않고 기존 전송·응답·파일 기록을 비교하는 중이다.
- `stale`: 표시가 마지막 권위 상태보다 오래되었거나 현재 권위자에게 도달할 수 없음을 뜻한다.

**[요구]** 상태 표시에는 관찰 시각과 원인, 안전한 다음 행동을 함께 제공한다. TUI는 종료 제안 전에
브리지 상태를 새로 읽고 `submitted`, `working`, `uncertain`, `reconciling`이 남아 있으면 종료를 막는다.

새 모드에서 정상 대기는 호스트가 소유하며 TUI 모델이 위 조회를 반복하지 않는다. 재시작 시 queued/
running 실행은 uncertain으로 기록하고 재실행하지 않는다. pending wake는 영구 영수증과 사용자 입력
세대를 확인해 같은 ID로 전달한다. 이전 연결 generation의 관찰은 현재 turn을 변경하지 못한다.
