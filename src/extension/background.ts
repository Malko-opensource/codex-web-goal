type Config = { base: string; token: string; chatUrl?: string; tabId?: number };
let config: Config | undefined;
let socket: WebSocket | undefined;
let connectionStatus = 'Not paired';
let lastError = '';
let heartbeat: ReturnType<typeof setInterval> | undefined;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let connecting = false;

function baseUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) throw new Error('Use http://127.0.0.1:<control-port>.');
  return url.origin;
}
async function save() { await chrome.storage.local.set({ config }); }
async function getTab() {
  const selected = config;
  if (!selected?.chatUrl) return undefined;
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  const matches = tabs.filter(t => t.url?.split(/[?#]/)[0]?.replace(/\/$/, '') === selected.chatUrl);
  const exact = matches.find(t => t.id === selected.tabId);
  if (exact) return exact;
  if (matches.length > 1) throw new Error('Several tabs match the saved conversation. Explicitly bind the intended tab.');
  return matches[0];
}
async function rebindKnownTab(ws: WebSocket) {
  const tab = await getTab();
  if (!config?.chatUrl || !tab?.id) return false;
  try { await chrome.tabs.sendMessage(tab.id, { type: 'ping' }); }
  catch { return false; }
  config.tabId = tab.id; await save();
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'bind', url: config.chatUrl, tabId: tab.id }));
  return true;
}
async function relay(message: unknown) {
  const tab = await getTab();
  if (!tab?.id) throw new Error('Open the bound ChatGPT conversation in Chrome.');
  return chrome.tabs.sendMessage(tab.id, message);
}
async function connect() {
  if (!config || connecting || socket?.readyState === WebSocket.OPEN) return;
  connecting = true;
  const ws = new WebSocket(config.base.replace('http:', 'ws:') + '/extension'); socket = ws;
  connectionStatus = 'Connecting';
  ws.onopen = () => { ws.send(JSON.stringify({ type: 'auth', token: config!.token })); };
  ws.onmessage = async event => {
    if (socket !== ws) return;
    try {
      const message = JSON.parse(event.data);
      if (message.type === 'ready') {
        connecting = false; connectionStatus = 'Connected'; lastError = '';
        if (message.chat) { config!.chatUrl = message.chat.url; await save(); }
        await rebindKnownTab(ws);
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'heartbeat' })); }, 20_000);
      } else if (message.type === 'bound') {
        config!.chatUrl = message.chat.url; config!.tabId = message.chat.tabId; await save();
      } else if (['dispatch', 'reconcile', 'cancel'].includes(message.type)) {
        try { await relay(message); }
        catch (error) { ws.send(JSON.stringify({ type: 'blocked', turnId: message.turnId, generation: message.generation, reason: String(error) })); }
      } else if (message.type === 'error') lastError = `${message.code}: ${message.message}`;
    } catch (error) { lastError = String(error); }
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = undefined;
    connecting = false; connectionStatus = 'Disconnected'; if (heartbeat) clearInterval(heartbeat);
    reconnect = setTimeout(() => { void connect(); }, 3000);
  };
  ws.onerror = () => { lastError = 'Local bridge unavailable. Start codex-web-goal, then reconnect.'; };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  void (async () => {
    if (sender.id !== chrome.runtime.id) throw new Error('Unknown extension sender.');
    const isContent = !sender.url?.startsWith(chrome.runtime.getURL(''));
    if (isContent) {
      if (!sender.tab || sender.frameId !== 0) throw new Error('Only the top-level bound chat can send observations.');
      if (!config?.chatUrl || sender.tab!.url?.split(/[?#]/)[0]?.replace(/\/$/, '') !== config.chatUrl) return { error: 'This conversation is not bound.' };
      if (message.type === 'content_ready') {
        const selected = await getTab();
        if (selected?.id !== sender.tab.id) return { error: 'This tab was not selected.' };
        if (socket?.readyState === WebSocket.OPEN) await rebindKnownTab(socket);
        return { ok: true };
      }
      if (sender.tab.id !== config.tabId) return { error: 'This is not the currently bound tab.' };
      if (message.type === 'journal_get') return { journal: (await chrome.storage.local.get(`turn:${message.id}`))[`turn:${message.id}`] };
      if (message.type === 'journal_set') { await chrome.storage.local.set({ [`turn:${message.id}`]: message.journal }); return { ok: true }; }
      if (message.type === 'browser_event') { if (socket?.readyState !== WebSocket.OPEN) throw new Error('Bridge disconnected; observation will be reconciled.'); socket.send(JSON.stringify(message.event)); return { ok: true }; }
      throw new Error('Content scripts cannot access pairing or control configuration.');
    }
    if (message.type === 'status') return { connectionStatus, lastError, base: config?.base, chatUrl: config?.chatUrl };
    if (message.type === 'pair') {
      const base = baseUrl(message.base);
      const result = await fetch(base + '/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: message.code }) });
      const data = await result.json(); if (!result.ok) throw new Error(data.error?.message ?? 'Pairing failed');
      const old = socket; socket = undefined; connecting = false; old?.close(); if (reconnect) clearTimeout(reconnect);
      config = { base, token: data.token }; await save(); await connect(); return { ok: true };
    }
    if (message.type === 'bind_active') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url || !/^https:\/\/chatgpt\.com\/(?:g\/[^/]+\/)?c\/[a-zA-Z0-9-]+/.test(tab.url)) throw new Error('Open a saved ChatGPT chat first (a /c/ URL).');
      if (!config || socket?.readyState !== WebSocket.OPEN) throw new Error('Pair and connect first.');
      // Confirm content-script presence before claiming that binding succeeded.
      await chrome.tabs.sendMessage(tab.id!, { type: 'ping' });
      const url = tab.url.split(/[?#]/)[0]!.replace(/\/$/, '');
      socket.send(JSON.stringify({ type: 'bind', url, tabId: tab.id })); return { ok: true };
    }
    if (message.type === 'reconnect') { socket?.close(); if (reconnect) clearTimeout(reconnect); connecting = false; socket = undefined; await connect(); return { ok: true }; }
    return { error: 'Unknown extension request' };
  })().then(respond, error => respond({ error: String(error) }));
  return true;
});
chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => { void connect(); });
void (async () => { await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }); config = (await chrome.storage.local.get('config')).config as Config | undefined; await connect(); })();
