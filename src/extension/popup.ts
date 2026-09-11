const element = (id: string) => document.getElementById(id)!;
async function send(message: unknown) { const result = await chrome.runtime.sendMessage(message); if (result?.error) throw new Error(result.error); return result; }
async function refresh() {
  const state = await send({ type: 'status' }); element('status').textContent = state.connectionStatus;
  element('chat').textContent = state.chatUrl ?? '현재 ChatGPT 대화에서 연결 버튼을 누르세요.';
  if (state.lastError) element('error').textContent = state.lastError;
  if (state.base) (element('base') as HTMLInputElement).value = state.base;
}
for (const id of ['pair', 'bind', 'reconnect']) element(id).addEventListener('click', () => {
  element('error').textContent = '';
  const message = id === 'pair' ? { type: 'pair', base: (element('base') as HTMLInputElement).value, code: (element('code') as HTMLInputElement).value.trim() } : { type: id === 'bind' ? 'bind_active' : 'reconnect' };
  void send(message).then(refresh).catch(error => { element('error').textContent = String(error); });
});
void refresh(); setInterval(() => { void refresh(); }, 1000);
