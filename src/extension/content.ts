import { ChatDom } from './dom.js';

type Request = { type: 'dispatch' | 'reconcile'; turnId: string; marker: string; prompt: string; url: string };
type Journal = { state: 'prepared' | 'attempting' | 'submitted' | 'answered'; answer?: string };
const dom = new ChatDom(document);
let running: Request | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let stable = { text: '', since: 0 };
let processing = false;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function rpc(message: unknown) {
  const result = await chrome.runtime.sendMessage(message);
  if (result?.error) throw new Error(result.error);
  return result;
}
async function getJournal(id: string): Promise<Journal | undefined> { return (await rpc({ type: 'journal_get', id }))?.journal; }
async function setJournal(id: string, journal: Journal) { await rpc({ type: 'journal_set', id, journal }); }
async function report(type: string, request: Request, extra: object = {}) { await rpc({ type: 'browser_event', event: { type, turnId: request.turnId, ...extra } }); }

async function observe(request: Request) {
  if (running?.turnId !== request.turnId) return;
  if (location.origin + location.pathname.replace(/\/$/, '') !== request.url) {
    await report('blocked', request, { reason: 'The selected tab navigated to a different conversation.' }); return;
  }
  const answer = dom.answer(request.marker);
  if (answer && !dom.stop() && dom.composer()) {
    if (stable.text !== answer) stable = { text: answer, since: Date.now() };
    else if (Date.now() - stable.since >= 2000) {
      await setJournal(request.turnId, { state: 'answered', answer });
      await report('answer', request, { response: answer }); running = undefined; return;
    }
  } else stable = { text: '', since: 0 };
  timer = setTimeout(() => { void observe(request).catch(() => {}); }, 500);
}

async function process(request: Request) {
  if (processing) return;
  processing = true;
  try { await processOnce(request); } finally { processing = false; }
}
async function processOnce(request: Request) {
  if (running && running.turnId !== request.turnId) { await report('blocked', request, { reason: 'A different automatic turn is still being observed.' }); return; }
  running = request;
  if (timer) clearTimeout(timer);
  const journal = await getJournal(request.turnId);
  if (journal?.state === 'answered' && journal.answer) { await report('answer', request, { response: journal.answer }); running = undefined; return; }
  if (dom.hasMarker(request.marker)) {
    await setJournal(request.turnId, { state: 'submitted' }); await report('submitted', request); await observe(request); return;
  }
  if (request.type === 'reconcile') {
    // A durable pre-attempt journal proves no click was attempted by this installation.
    if (journal?.state === 'prepared') { await report('not_submitted', request); running = undefined; return; }
    await wait(2000);
    if (dom.hasMarker(request.marker)) { await report('submitted', request); await observe(request); return; }
    await report('uncertain', request, { reason: 'A send was attempted but the message is not visible. Open the correct conversation and retry observation; do not resend.' }); running = undefined; return;
  }
  if (journal && journal.state !== 'prepared') { await report('uncertain', request, { reason: 'A previous send attempt exists.' }); running = undefined; return; }
  await setJournal(request.turnId, { state: 'prepared' });
  if (!dom.composer()) { await report('blocked', request, { reason: 'ChatGPT composer not found. Sign in or check for a changed UI.' }); running = undefined; return; }
  if (!dom.ready()) { timer = setTimeout(() => { void process(request).catch(() => {}); }, 1000); return; }
  try {
    dom.fill(request.prompt);
    await wait(150);
    const button = dom.sendButton();
    if (!button || button.disabled) throw new Error('Send button unavailable. The draft is preserved for inspection.');
    // Persist before the only operation that can submit. Any later crash is ambiguous.
    await setJournal(request.turnId, { state: 'attempting' });
    if (running?.turnId !== request.turnId) return;
    button.click();
    for (let attempt = 0; attempt < 20 && !dom.hasMarker(request.marker); attempt++) await wait(250);
    if (!dom.hasMarker(request.marker)) throw new Error('Submission could not be confirmed from the rendered conversation.');
    await setJournal(request.turnId, { state: 'submitted' });
    await report('submitted', request); await observe(request);
  } catch (error) {
    const journalNow = await getJournal(request.turnId);
    await report(journalNow?.state === 'attempting' ? 'uncertain' : 'blocked', request, { reason: String(error) }); running = undefined;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message.type === 'ping') { respond({ ready: true }); return; }
  if (message.type === 'cancel') { running = undefined; if (timer) clearTimeout(timer); respond({ cancelled: true }); return; }
  if (message.type === 'dispatch' || message.type === 'reconcile') {
    void process(message as Request).catch(error => { void report('blocked', message as Request, { reason: String(error) }); }); respond({ received: true });
  }
});
void rpc({ type: 'content_ready', url: location.href }).catch(() => {});
