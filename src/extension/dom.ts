export type Message = { role: string; text: string; element: HTMLElement };
export class ChatDom {
  constructor(readonly document: Document) {}
  messages(): Message[] {
    return Array.from(this.document.querySelectorAll<HTMLElement>('[data-message-author-role]')).map(element => ({
      role: element.dataset.messageAuthorRole ?? '', text: element.innerText || element.textContent || '', element
    }));
  }
  composer() { return this.document.querySelector<HTMLElement>('#prompt-textarea, textarea[data-testid="prompt-textarea"], [contenteditable="true"][data-testid="prompt-textarea"]'); }
  stop() { return this.document.querySelector<HTMLElement>('[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="생성 중지"]'); }
  sendButton() { return this.document.querySelector<HTMLButtonElement>('button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="프롬프트 보내기"]'); }
  draft() { const composer = this.composer(); return composer instanceof HTMLTextAreaElement ? composer.value : composer?.innerText ?? ''; }
  ready() { return Boolean(this.composer() && !this.stop() && !this.draft().trim()); }
  hasMarker(marker: string) { return this.messages().some(m => m.role === 'user' && m.text.includes(marker)); }
  answer(marker: string) {
    const messages = this.messages(); const start = messages.findIndex(m => m.role === 'user' && m.text.includes(marker));
    if (start < 0) return undefined;
    const own: Message[] = [];
    for (const message of messages.slice(start + 1)) { if (message.role === 'user') break; if (message.role === 'assistant') own.push(message); }
    const last = own.at(-1);
    if (!last) return undefined;
    return this.markdown(last.element.querySelector('.markdown') ?? last.element).trim();
  }
  private markdown(node: Node): string {
    if (node.nodeType === 3) return node.textContent ?? '';
    if (!(node instanceof Element)) return '';
    const tag = node.tagName.toLowerCase();
    if (['button', 'script', 'style', 'svg'].includes(tag)) return '';
    if (tag === 'pre') { const code = node.querySelector('code'); return '\n```' + (code?.className.match(/language-([\w-]+)/)?.[1] ?? '') + '\n' + (code?.textContent ?? node.textContent ?? '').replace(/\n$/, '') + '\n```\n'; }
    const content = Array.from(node.childNodes).map(child => this.markdown(child)).join('');
    if (tag === 'code') return '`' + content + '`';
    if (tag === 'br') return '\n';
    if (/^h[1-6]$/.test(tag)) return '\n' + '#'.repeat(Number(tag[1])) + ' ' + content + '\n';
    if (tag === 'li') return '\n- ' + content;
    if (tag === 'strong') return '**' + content + '**';
    if (tag === 'a') { const href = node.getAttribute('href') ?? ''; return /^https?:\/\//.test(href) ? `[${content}](${href})` : content; }
    if (['p', 'div', 'section', 'ul', 'ol', 'table', 'tr', 'blockquote'].includes(tag)) return '\n' + content + '\n';
    if (tag === 'td' || tag === 'th') return content + ' | ';
    return content;
  }
  fill(text: string) {
    const composer = this.composer(); if (!composer || this.draft().trim()) throw new Error('Composer is missing or has a user draft.');
    composer.focus();
    if (composer instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(composer, text);
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // User-visible editing surface only: no ChatGPT application state or private APIs.
      // Chromium's editing command goes through the editable surface's input events,
      // unlike assigning textContent, which can leave a framework editor's state stale.
      if (!this.document.execCommand('insertText', false, text)) throw new Error('The editable composer rejected insertion.');
    }
  }
}
