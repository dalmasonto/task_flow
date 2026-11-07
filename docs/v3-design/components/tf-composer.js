// <tf-composer placeholder="Message #design-room" reply-name="reviewer (codex)" reply-text="quoted text"
//              mentions-open="de" dictating compact send-label="Send">   (all optional)
// Type "@" to open the mention picker: Everyone (@all, @here), Agents (logo + state), People.
// Up/Down move, Enter or Tab inserts a chip, Esc closes. Dictation (#739) uses the shared tf-mic control.
const TF_MENTION_GROUPS = [
  { label: 'Everyone', items: [
    { kind: 'all', handle: 'all', name: '@all', hint: 'Notify all 7 members and agents in this room' },
    { kind: 'all', handle: 'here', name: '@here', hint: 'Notify only who is online now (4)' },
  ] },
  { label: 'Agents', items: [
    { kind: 'agent', model: 'claude', handle: 'claude-main', name: 'Claude (main)', status: 'running', hint: 'Running, writing the chat page' },
    { kind: 'agent', model: 'codex', handle: 'reviewer', name: 'reviewer (codex)', status: 'running', hint: 'Running, reviewing tokens' },
    { kind: 'agent', model: 'deepseek', handle: 'deepseek-api', name: 'DeepSeek (api)', status: 'blocked', hint: 'Blocked, waiting on review' },
    { kind: 'agent', model: 'claude', handle: 'claude-bear', name: 'Claude (bear)', status: 'offline', hint: 'Offline, last seen 2h ago' },
  ] },
  { label: 'People', items: [
    { kind: 'user', handle: 'dalmasonto', name: 'Dalmas Ogembo', hint: '@dalmasonto, owner', status: 'running' },
    { kind: 'user', handle: 'achieng', name: 'Achieng Otieno', hint: '@achieng, member', status: 'offline' },
  ] },
];
let tfComposerSeq = 0;
function tfChip(item) {
  const all = item.kind === 'all';
  const cls = all ? 'bg-blocked/15 text-foreground' : 'bg-primary/12 text-primary';
  const text = all ? item.name : '@' + item.name;
  return '<span contenteditable="false" data-mention="' + item.kind + ':' + item.handle + '" class="rounded px-1 py-px font-medium ' + cls + '">' + text + '</span>&nbsp;';
}
class TfComposer extends HTMLElement {
  connectedCallback() { if (!this.hasAttribute('data-r')) { this.setAttribute('data-r', ''); this.render(); } }
  render() {
    const ph = this.getAttribute('placeholder') || 'Write a message';
    const replyName = this.getAttribute('reply-name');
    const replyText = this.getAttribute('reply-text') || '';
    const compact = this.hasAttribute('compact');
    const dictating = this.hasAttribute('dictating');
    const fid = 'tf-composer-' + (++tfComposerSeq);
    const bars = [3, 5, 8, 4, 9, 6, 3, 7, 5, 2, 6, 8, 4];
    this.className = 'block';
    this.innerHTML = `
    <div class="relative rounded-xl border border-input bg-card shadow-sm focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
      ${replyName ? `<div class="flex items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <tf-icon name="reply" class="size-3.5 text-muted-foreground"></tf-icon>
        <span class="shrink-0 text-muted-foreground">Replying to <span class="font-medium text-foreground">${replyName}</span></span>
        <span class="min-w-0 flex-1 truncate text-muted-foreground">${replyText}</span>
        <button class="rounded p-0.5 text-muted-foreground hover:bg-accent" aria-label="Cancel reply"><tf-icon name="x" class="size-3.5"></tf-icon></button></div>` : ''}
      <div data-c="dictation" class="${dictating ? 'flex' : 'hidden'} items-center gap-3 border-b border-border bg-primary/5 px-3 py-2" aria-live="polite">
        <span class="relative flex size-6 items-center justify-center"><span class="absolute inset-0 rounded-full bg-destructive/25 motion-safe:animate-ping"></span><span class="relative size-2.5 rounded-full bg-destructive"></span></span>
        <span class="text-sm font-medium">Listening</span>
        <span class="flex h-5 items-end gap-0.5" aria-hidden="true">${bars.map((h, i) => '<span class="w-0.5 rounded-full bg-primary motion-safe:animate-pulse" style="height:' + (h * 2) + 'px;animation-delay:' + (i * 90) + 'ms"></span>').join('')}</span>
        <span class="hidden text-xs text-muted-foreground sm:inline">On-device, nothing leaves this machine</span>
      </div>
      <div id="${fid}" data-c="input" contenteditable="true" role="textbox" aria-multiline="true" aria-label="${ph}" data-ph="${ph}"
        class="tf-input max-h-60 overflow-y-auto px-3.5 ${compact ? 'min-h-10 py-2.5' : 'min-h-12 py-3'} text-base leading-6 outline-none sm:text-sm">${dictating ? 'Ask <span contenteditable="false" data-mention="agent:deepseek-api" class="rounded px-1 py-px font-medium bg-primary/12 text-primary">@DeepSeek (api)</span>&nbsp;to run the migration on staging first and post the' : ''}</div>
      <div class="flex items-center gap-0.5 px-2 pb-2">
        <button class="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Attach files"><tf-icon name="paperclip" class="size-4"></tf-icon></button>
        <button data-c="at" class="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Mention someone"><tf-icon name="at-sign" class="size-4"></tf-icon></button>
        <button class="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Add emoji"><tf-icon name="smile" class="size-4"></tf-icon></button>
        ${compact ? '' : `<button class="hidden rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground sm:inline-flex" aria-label="Ask a question form"><tf-icon name="list" class="size-4"></tf-icon></button>
        <span class="mx-1 hidden h-5 w-px bg-border sm:block"></span>
        <span class="hidden text-xs text-muted-foreground md:inline">Enter to send, Shift Enter for a new line</span>`}
        <div class="ml-auto flex items-center gap-1">
          <tf-mic for="${fid}" state="${dictating ? 'listening' : 'idle'}"></tf-mic>
          <button class="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90" aria-label="Send"><tf-icon name="send" class="size-4"></tf-icon><span class="hidden sm:inline">${this.getAttribute('send-label') || 'Send'}</span></button>
        </div>
      </div>
      <div data-c="pop" role="listbox" aria-label="Mention" class="absolute bottom-full left-2 right-2 z-20 mb-2 hidden max-h-80 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg sm:right-auto sm:w-96"></div>
    </div>`;
    if (!document.getElementById('tf-composer-style')) {
      const st = document.createElement('style');
      st.id = 'tf-composer-style';
      st.textContent = '.tf-input:empty::before{content:attr(data-ph);color:var(--muted-foreground);pointer-events:none}';
      document.head.appendChild(st);
    }
    this.wire();
    const q = this.getAttribute('mentions-open');
    if (q !== null) { this.input.textContent = 'Can @' + q; this.open(q); }
  }
  wire() {
    this.input = this.querySelector('[data-c="input"]');
    this.pop = this.querySelector('[data-c="pop"]');
    const mic = this.querySelector('tf-mic');
    const dict = this.querySelector('[data-c="dictation"]');
    new MutationObserver(() => {
      const on = mic.getAttribute('state') === 'listening';
      dict.classList.toggle('hidden', !on); dict.classList.toggle('flex', on);
    }).observe(mic, { attributes: true, attributeFilter: ['state'] });
    this.querySelector('[data-c="at"]').addEventListener('click', () => { this.input.focus(); document.execCommand('insertText', false, '@'); this.open(''); });
    this.input.addEventListener('input', () => {
      const m = this.textBeforeCaret().match(/@([a-z0-9_-]*)$/i);
      if (m) this.open(m[1]); else this.close();
    });
    this.input.addEventListener('keydown', (e) => {
      if (this.pop.classList.contains('hidden')) return;
      const n = this.items.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); this.sel = (this.sel + (e.key === 'ArrowDown' ? 1 : -1) + n) % n; this.paint(); }
      else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); if (n) this.pick(this.items[this.sel]); }
      else if (e.key === 'Escape') this.close();
    });
  }
  textBeforeCaret() {
    const s = getSelection(); if (!s.rangeCount || !this.input.contains(s.anchorNode)) return '';
    const r = s.getRangeAt(0).cloneRange(); r.collapse(true); r.setStart(this.input, 0); return r.toString();
  }
  open(q) {
    const ql = q.toLowerCase();
    this.items = []; let html = '';
    for (const g of TF_MENTION_GROUPS) {
      const hits = g.items.filter((i) => !ql || i.handle.includes(ql) || i.name.toLowerCase().includes(ql));
      if (!hits.length) continue;
      html += '<div class="px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">' + g.label + '</div>';
      for (const i of hits) {
        const idx = this.items.push(i) - 1;
        const lead = i.kind === 'all'
          ? '<span class="inline-flex size-6 items-center justify-center rounded-md bg-blocked/15"><tf-icon name="' + (i.handle === 'all' ? 'users' : 'zap') + '" class="size-3.5"></tf-icon></span>'
          : '<tf-avatar model="' + (i.model || 'human') + '" name="' + i.name + '" status="' + i.status + '" size="sm"></tf-avatar>';
        html += '<div role="option" data-i="' + idx + '" class="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5">' + lead +
          '<span class="min-w-0 flex-1"><span class="block truncate text-sm font-medium">' + i.name + '</span><span class="block truncate text-xs text-muted-foreground">' + i.hint + '</span></span>' +
          (i.kind === 'agent' ? '<span class="rounded border border-border px-1 text-xs text-muted-foreground">agent</span>' : '') + '</div>';
      }
    }
    if (!this.items.length) html = '<div class="px-3 py-4 text-sm text-muted-foreground">No one matches @' + q + '. Only members and agents of this project can be mentioned.</div>';
    this.pop.innerHTML = html + '<div class="mt-1 flex gap-3 border-t border-border px-2 pb-1 pt-1.5 text-xs text-muted-foreground"><span>Up and down to move</span><span>Enter to mention</span><span>Esc to close</span></div>';
    this.pop.classList.remove('hidden'); this.sel = 0; this.paint();
    this.pop.querySelectorAll('[role="option"]').forEach((o) => {
      o.addEventListener('mousedown', (e) => { e.preventDefault(); this.pick(this.items[+o.dataset.i]); });
      o.addEventListener('mousemove', () => { this.sel = +o.dataset.i; this.paint(); });
    });
  }
  paint() {
    this.pop.querySelectorAll('[role="option"]').forEach((o, i) => {
      const on = i === this.sel; o.setAttribute('aria-selected', on); o.classList.toggle('bg-accent', on); o.classList.toggle('text-accent-foreground', on);
    });
  }
  close() { this.pop.classList.add('hidden'); }
  pick(item) {
    this.close(); this.input.focus();
    const s = getSelection(); if (!s.rangeCount) return;
    const m = this.textBeforeCaret().match(/@[a-z0-9_-]*$/i);
    if (m) for (let i = 0; i < m[0].length; i++) s.modify('extend', 'backward', 'character');
    document.execCommand('insertHTML', false, tfChip(item));
  }
}
customElements.define('tf-composer', TfComposer);
