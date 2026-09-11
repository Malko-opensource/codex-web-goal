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
    el('connection-status').textContent = state.browserConnected ? '● Chrome connected' : '○ Waiting for Chrome';
    el('connection-status').className = `badge ${state.browserConnected ? 'online' : ''}`;
    el('workspace').textContent = state.workspace.split(/[\\/]/).filter(Boolean).pop(); el('workspace').title = state.workspace;
    el('goal-state').textContent = state.native?.goal?.status ?? state.session?.mode ?? '대기 중';
    el('goal-objective').textContent = state.session?.reason ?? state.session?.binding.objective ?? 'Codex에서 /goal $web-goal로 시작하세요.';
    el('turn-state').textContent = state.turn ? `#${state.turn.sequence} · ${state.turn.status}` : '대기 중';
    el('turn-detail').textContent = state.turn?.reason ?? (state.turn?.workerFinished ? 'Web 편집 권한 회수됨' : 'Web 작업과 로컬 검증을 순서대로 진행합니다.');
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
    if (!state.jobs.length) el('jobs').append(node('p', '대기 중인 실행 요청이 없습니다.', 'subtle'));
    el('timeline').replaceChildren();
    for (const event of state.events.slice(-12).reverse()) {
      const row = node('div', '', 'event'), detail = node('div', '');
      detail.append(node('b', event.kind), node('p', event.detail)); row.append(node('time', new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })), detail); el('timeline').append(row);
    }
  } catch (error) { showError(error); }
}
void refresh(); setInterval(() => { void refresh(); }, 2000);
