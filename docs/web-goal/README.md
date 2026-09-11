# Web Goal 운영 설계 문서

이 디렉터리는 2026-09-11 실계정 연결에서 확인된 현상을 기존 구현 계약과 대조해 정리한다.
문서의 표시는 다음 의미를 가진다.

- **[현재 구현]** 저장소 코드 또는 자동 테스트에서 확인한 동작
- **[실연결 관찰]** 실제 ChatGPT Web 연결에서 사용자가 확인한 동작
- **[요구]** 제품이 지켜야 할 조건이며 아직 구현 완료를 뜻하지 않음
- **[미검증]** 실계정·현재 DOM·서비스 정책에서 추가 확인이 필요한 항목

문서 목록:

1. [연결 구조와 상태 소유권](connection-architecture.md)
2. [상태와 재조정](state-and-reconciliation.md)
3. [운영 런북](operations-runbook.md)
4. [보안 경계](security-boundary.md)
5. [트러블슈팅](troubleshooting.md)
6. [상태·신뢰 모델](04-state-and-trust-model.md)
7. [Web 실행·맥락·호스트 대기 계약](web-controlled-execution.md) — 구현 범위와 미완료 호스트 의존성
8. [일반 요청·Goal 공통 위임](shared-delegation.md) — 결과 계약, 스킬·이미지·MCP, 로컬 지원과 원래 대화 복귀

현재 동작의 간결한 계약은 상위 [ARCHITECTURE.md](../ARCHITECTURE.md), 실행 방법은
[OPERATIONS.md](../OPERATIONS.md), 공개 보안 고지는 [SECURITY.md](../../SECURITY.md)를 함께 본다.
