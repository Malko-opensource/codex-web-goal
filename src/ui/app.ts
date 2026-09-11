let credential = sessionStorage.getItem('web-goal-control') ?? '';
if (location.hash.length > 20 && !location.hash.includes('/')) { credential = location.hash.slice(1); sessionStorage.setItem('web-goal-control', credential); history.replaceState(null, '', '/'); }
const el = (id: string) => document.getElementById(id)!;
async function api(endpoint: string, payload?: unknown) {
  const response = await fetch(`/api/${endpoint}`, { method: payload === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? 'Request failed'); return data;
}
const showError = (error: unknown) => { el('error').hidden = false; el('error').textContent = String(error); };
function action(id: string, fn: () => Promise<unknown>) { el(id).addEventListener('click', () => { void fn().then(refresh).catch(showError); }); }
action('pair', async () => { const pair = await api('pair-code', {}); el('pair-code').textContent = pair.code; });
action('connector', async () => { const connector = await api('connector', {}); el('connector-path').textContent = connector.path; });
for (const name of ['pause', 'resume', 'close']) action(name, () => api('tools/web_goal_control', { action: name }));
function node(tag: string, text: string, className?: string) { const item = document.createElement(tag); item.textContent = text; if (className) item.className = className; return item; }
async function refresh() {
  try {
    const state = await api('status');
    el('error').hidden = true;
    const connected = state.conversationConnected ?? state.browserConnected;
    const surface = state.conversationSurface === 'codex-inapp' ? 'In-app' : 'Chrome';
    el('connection-status').textContent = connected ? `● ${surface} connected` : '○ Waiting for conversation';
    el('connection-status').className = `badge ${connected ? 'online' : ''}`;
    el('workspace').textContent = state.workspace.split(/[\\/]/).filter(Boolean).pop(); el('workspace').title = state.workspace;
    el('goal-state').textContent = state.session?.mode === 'task' ? '일반 요청' : state.native?.goal?.status ?? state.session?.mode ?? '대기 중';
    el('goal-objective').textContent = state.session?.reason ?? state.session?.binding.objective ?? '일반 요청 또는 Goal에서 Web 위임을 시작하세요.';
    const progress = state.turn?.progress;
    const execution = state.execution;
    const progressLabel = !state.turn ? '대기 중' :
      execution?.blocked === 'LOCAL_ASSISTANCE_PENDING' ? '로컬 작업에 위임됨 · Web 권한 대기' :
      state.turn.status === 'handed_off' ? '로컬 결과 수신 · 새 맥락으로 재개 필요' :
      execution?.blocked ? `확인 필요: ${execution.blocked}` :
      execution?.latestRun?.status === 'running' || execution?.latestRun?.status === 'queued' ? '격리 실행 중' :
      progress?.validation === 'runner_validated' ? '실행기 검증·seal 완료' :
      progress?.validation === 'result_captured' ? '결과 수집·seal 완료 · 원래 대화 수락 대기' :
      execution?.latestRun?.status === 'failed' ? 'Web 수정·재검증 중' :
      ['uncertain', 'blocked', 'cancelled'].includes(state.turn.status) ? state.turn.status :
      progress?.validation === 'locally_validated' ? '로컬 검증됨' :
      progress?.validation === 'sealed' ? '검증 대기' :
      progress?.work === 'worker_finished' ? 'Web 작업 종료' :
      progress?.work === 'working' ? 'Web 작업 중' :
      progress?.delivery === 'submitted' || progress?.delivery === 'answered' ? '전달됨' : '전달 중';
    el('turn-state').textContent = state.turn ? `#${state.turn.sequence} · ${progressLabel}` : progressLabel;
    el('turn-detail').textContent = state.turn?.reason ?? (progress ? `전달 ${progress.delivery} · 작업 ${progress.work} · 검증 ${progress.validation}` : 'Web 작업과 로컬 검증을 순서대로 진행합니다.');
    if (execution?.mode === 'web-controlled') el('turn-detail').textContent += ` · 맥락 v${execution.contextVersion ?? '?'} · 호스트 ${execution.hostWait ?? '대기 미확인'} · 검증 잔여 ${execution.remaining.verifications}회`;
    (el('pause') as HTMLButtonElement).disabled = state.session?.status !== 'active';
    (el('resume') as HTMLButtonElement).disabled = state.session?.status !== 'paused';
    (el('close') as HTMLButtonElement).disabled = !state.session || state.session.status === 'closed';
    if (state.chat?.url) { el('chat').textContent = state.chat.url; (el('chat') as HTMLAnchorElement).href = state.chat.url; }
    el('response').textContent = state.turn?.response ?? state.turn?.workerReport ?? '응답을 기다리고 있습니다.';
    el('jobs').replaceChildren();
    for (const job of state.jobs.toReversed()) {
      const card = node('article', '', 'job'); card.append(node('small', `${job.status} · ${job.cwd}`), node('pre', job.command));
      if (job.status === 'pending') for (const [label, allow] of [['실행 승인', true], ['거절', false]] as const) {
        const button = node('button', label); button.addEventListener('click', () => { void api('command', { id: job.id, allow }).then(refresh).catch(showError); }); card.append(button);
      }
      if (job.status === 'running') { const button = node('button', '실행 중지'); button.addEventListener('click', () => { void api('command-stop', { id: job.id }).then(refresh).catch(showError); }); card.append(button); }
      if (job.output) card.append(node('pre', job.output)); el('jobs').append(card);
    }
    for (const call of state.capabilityCalls ?? []) {
      const card = node('article', '', 'job');
      card.append(node('small', `외부 MCP · ${call.status} · ${call.capabilityId}`), node('pre', JSON.stringify(call.args, null, 2)));
      if (call.status === 'pending') for (const [label, allow] of [['이 호출 승인', true], ['거절', false]] as const) {
        const button = node('button', label); button.addEventListener('click', () => { void api('capability', { id: call.id, allow }).then(refresh).catch(showError); }); card.append(button);
      }
      if (call.output) card.append(node('pre', call.output)); el('jobs').append(card);
    }
    for (const request of state.localAssists ?? []) {
      const card = node('article', '', 'job'); card.append(node('small', `로컬 지원 · ${request.status}`), node('p', request.task), node('p', request.reason)); el('jobs').append(card);
    }
    if (!state.jobs.length && !state.capabilityCalls?.length && !state.localAssists?.length) el('jobs').append(node('p', '대기 중인 실행 요청이 없습니다.', 'subtle'));
    el('timeline').replaceChildren();
    for (const event of state.events.slice(-12).reverse()) {
      const row = node('div', '', 'event'), detail = node('div', '');
      detail.append(node('b', event.kind), node('p', event.detail)); row.append(node('time', new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })), detail); el('timeline').append(row);
    }
  } catch (error) { showError(error); }
}
void refresh(); setInterval(() => { void refresh(); }, 2000);
