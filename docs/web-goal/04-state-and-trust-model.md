# 04. 상태와 신뢰 모델

## 설계 명제

기존 local-supervised 흐름과 선택형 web-controlled 모드를 구분한다.
[실행·맥락·호스트 계약](web-controlled-execution.md)은 새 모드의 기준이다. 실제 호스트 스케줄러
연동은 아직 미완료이며, 기본 모드의 로컬 검증 순서를 새 모드에 그대로 적용하지 않는다.

[공통 위임 계약](shared-delegation.md)은 일반 요청에도 적용한다. 일반 요청의 완료 권위는 원래 대화이고,
Goal의 완료 권위는 네이티브 Goal이다. `result_captured`는 answer/files 계약의 결과 수집이며 실행 검증이
아니다. `local_assistance`/`handed_off`는 정상 로컬 협업 경로이며 작업 실패·완료와 구분한다.
아래 실행·파일 중심 완료 게이트는 verified-files에 적용하며, 분석 요청에 파일/실행을 강제하지 않는다.

연결, 전달, Web 작업, 파일 효과, 검증, 전체 Goal 완료는 서로 다른 사실이다. 한 단계의 성공을
다음 단계의 성공으로 추론하지 않는다.

| 관찰 | 증명하는 것 | 증명하지 못하는 것 |
| --- | --- | --- |
| 확장 `connected` | 인증된 로컬 WebSocket | 올바른 대화 바인딩, 요청 전달 |
| 대화 `bound` | 정규화 URL과 현재 탭의 연결 | 메시지 전송, Web 작업 시작 |
| `submitted` | marker가 사용자 메시지로 렌더링됨 | 도구 실행, 파일 생성, 답변 완료 |
| `working` | `worker_context`가 활성 turn을 확인함 | 모든 파일 반영, `worker_finish` |
| `worker_finished` | 해당 turn의 쓰기 grant가 닫힘 | 답변 회수, 로컬 검증 |
| 파일 write 성공 | 한 파일 효과가 적용됨 | 전체 산출물 완성, read-back, 다중 파일 원자성 |
| `answered` | 같은 marker 뒤의 안정된 Web 답변 회수 | 파일 내용 정확성, 테스트 통과 |
| `sealed` | 원격 쓰기 회수와 source revision 고정 | 검증 통과 |
| `locally_validated` | 같은 revision의 checkpoint 기록 | 전체 네이티브 Goal 완료 |
| 네이티브 Goal `complete` | Codex가 전체 목적 완료를 판정 | 외부 배포·push 등 별도 효과 |
| 맥락 digest 수락 | 특정 버전의 전달 확인 | 전체 로컬 이력 공유, 지시 이해·준수 |
| 호스트 `waiting_external` | 연동 호스트의 모델 대기 확인 | 사용자 pause와 동일한 의미, 실제 호스트 검증 완료 |
| 실행기 `passed` | 특정 사본·정책의 명령 결과 통과 | 현재 원본 일치, 검사 충분성, 최종 목적 달성 |
| `runner_validated` | 필수 증거·원본 read-back·revision·seal 결합 | 네이티브 Goal 자동 완료 |
| `result_captured` | 선언한 answer/files 결과 계약 수집·seal | 명령 검사 통과, 사용자 수락 |
| MCP 이미지 반환 | 선택한 이미지 바이트·hash 반환 | composer 첨부 완료, 모델의 시각 이해 |
| capability 승인 | 정확한 도구·인자 호출 승인 | 실행 성공, 모든 외부 부작용의 롤백 가능성 |
| `handed_off` | 로컬 지원 결과 기록 및 이전 Web 권한 폐기 | 새로운 맥락 수락, 자동 작업 재개 |

## 교차 불변식

1. 같은 `request_id`는 같은 요청 본문에만 대응한다.
2. `uncertain`인 전송은 새 요청이나 자동 클릭으로 재실행하지 않는다.
3. 새 탭은 저장된 정규화 대화 URL이 같을 때만 바인딩을 승계한다.
4. `worker_finish` 이후 같은 turn의 파일 쓰기는 거부한다.
5. 기본 모드의 로컬 검증은 seal revision과 일치해야 한다. 새 모드는 먼저 사본에서 반복 검증하고,
   최종 finish 시 원본 revision/read-back 확인 후 권한 회수·seal·checkpoint한다.
6. 브리지 checkpoint가 네이티브 Goal을 자동 완료하지 않는다.
7. 오래된 복사 상태가 권위 상태를 덮어쓰거나 종료를 유발하지 않는다.
8. token 노출 가능성이 있는 DOM·접근성·화면 출력은 민감 데이터로 취급한다.
9. 맥락·정책 버전이 다르거나 호스트 lease가 무효이면 새 파일·명령 효과를 허용하지 않는다.
10. Codex 승인·샌드박스는 Web 도구에 상속되지 않는다. 브리지 정책과 실행기 OS 경계가 각각 검사한다.
11. UI heartbeat·정상 실행·복구 가능한 테스트 실패는 로컬 모델을 깨우는 이유가 아니다.
12. 사용자 입력/중단은 외부 대기와 오래된 wake보다 우선하며 기존 grant를 부활시키지 않는다.

## 실패 상태

- `uncertain`: 외부 효과가 발생했을 수 있으나 안전한 증거가 부족하다.
- `blocked`: 다음 진행에 필요한 UI, 권한, 탭, 도구 또는 사용자 행동이 없다.
- `disconnected`: 통신 채널이 끊겼다. 이미 발생한 효과의 부재를 뜻하지 않는다.
- `reconnecting`: 같은 식별자의 채널을 복구 중이며 작업을 재실행하지 않는다.
- `reconciling`: 외부 효과 없이 기존 기록을 비교해 권위 상태를 복원한다.
- `stale`: 표시가 최신 권위 상태임을 보장할 수 없다.
- `failed`: 확인된 오류로 해당 단계의 수용 조건을 만족하지 못했다.

## 완료 게이트

전체 완료는 단일 상태 전이가 아니라 다음 증거의 결합이다.

```text
conversation evidence
  + worker_finish
  + expected files read-back
  + write grant revoked / source sealed
  + local checks on the sealed revision
  + native Goal acceptance
  = completion eligible
```

상세 재조정 절차는 [state-and-reconciliation.md](state-and-reconciliation.md), 운영 순서는
[operations-runbook.md](operations-runbook.md)를 따른다.

web-controlled의 완료 후보는 `context acknowledged + host wait + required runner checks + expected
files read-back + revision match + worker_finish + grant revoked + seal/checkpoint`로 판단한다.
답변 텍스트는 별도 관찰이며 위 증거를 대신하지 않는다. 최종 완료는 네이티브 Goal 수용 이후다.
실제 호스트의 자동 continuation 억제 검증 없이 '로컬 사용량 0'으로 표시하지 않는다. 시작/최종 판정/
예외의 모델 사용량과 정상 대기 구간의 호출 수를 분리 측정한다.
