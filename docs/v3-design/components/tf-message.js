// <tf-message model="codex|claude|human" name="reviewer (codex)" time="15:12" role="Owner"
//   continued mentions-me pinned actions priority="important|urgent"
//   reply-name="Dalmas Ogembo" reply-text="quoted text"
//   reactions="eyes:2:me,check:1" seen="human:Dalmas Ogembo,codex:reviewer (codex)" delivered="Claude (main), pane %4"
//   thread="3 replies,claude|human:Dalmas Ogembo,last 2m ago">   (everything but model/name/time optional)
//   body HTML
// </tf-message>
const TF_REACT = { eyes: '&#x1F440;', check: '&#x2705;', rocket: '&#x1F680;', thumbs: '&#x1F44D;', heart: '&#x2764;&#xFE0F;', think: '&#x1F914;' };
function tfParsed(el, fn) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => fn.call(el), { once: true });
  else fn.call(el);
}
const tfAv = (spec, size) => { const [m, n] = spec.split(':'); return '<tf-avatar model="' + m + '" name="' + (n || '') + '" size="' + size + '"></tf-avatar>'; };
class TfMessage extends HTMLElement {
  connectedCallback() { if (!this._q) { this._q = true; tfParsed(this, this.build); } }
  build() {
    if (this.hasAttribute('data-r')) return; this.setAttribute('data-r', '');
    const a = (k) => this.getAttribute(k);
    const model = a('model') || 'human';
    const isAgent = model !== 'human';
    const name = a('name') || '';
    const cont = this.hasAttribute('continued');
    const me = this.hasAttribute('mentions-me');
    const pinned = this.hasAttribute('pinned');
    const pri = a('priority');
    const body = this.innerHTML;
    const reactions = (a('reactions') || '').split(',').filter(Boolean).map((r) => {
      const [k, n, mine] = r.split(':');
      return '<button class="inline-flex h-6 items-center gap-1 rounded-full border px-1.5 text-xs tabular-nums ' + (mine ? 'border-ring/50 bg-accent text-accent-foreground' : 'border-border bg-card text-muted-foreground hover:border-ring') + '" aria-label="' + k + ' reaction, ' + n + '">' + (TF_REACT[k] || k) + '<span>' + n + '</span></button>';
    }).join('');
    const seen = (a('seen') || '').split(',').filter(Boolean);
    const seenNames = seen.map((s) => s.split(':')[1] || s).join(', ');
    const thread = a('thread') ? a('thread').split(',') : null;
    this.className = 'group relative block px-4 lg:px-6 ' + (cont ? 'pt-0.5' : 'pt-3') + ' pb-0.5 ' +
      (me ? 'bg-accent/60 shadow-[inset_2px_0_0_var(--ring)] ' : pri === 'urgent' ? 'bg-destructive/5 shadow-[inset_2px_0_0_var(--destructive)] ' : 'hover:bg-muted/40 ');
    const quote = a('reply-name') ? '<div class="mb-1 flex max-w-xl items-baseline gap-1.5 border-l-2 border-border pl-2 text-xs text-muted-foreground"><tf-icon name="reply" class="size-3 shrink-0 translate-y-0.5"></tf-icon><span class="shrink-0 font-medium text-foreground/80">' + a('reply-name') + '</span><span class="truncate">' + (a('reply-text') || '') + '</span></div>' : '';
    const head = cont ? '' : `<div class="flex flex-wrap items-baseline gap-x-2">
        <span class="text-sm font-semibold">${name}</span>
        ${isAgent ? '<span class="rounded border border-border px-1 text-[0.6875rem] font-medium leading-4 text-muted-foreground">agent</span>' : a('role') ? '<span class="text-xs text-muted-foreground">' + a('role') + '</span>' : ''}
        <time class="text-xs tabular-nums text-muted-foreground">${a('time') || ''}</time>
        ${pri ? '<span class="inline-flex items-center gap-1 text-xs font-medium ' + (pri === 'urgent' ? 'text-destructive' : 'text-blocked') + '"><tf-icon name="flag" class="size-3"></tf-icon>' + (pri === 'urgent' ? 'Urgent' : 'Important') + '</span>' : ''}
        ${pinned ? '<span class="inline-flex items-center gap-1 text-xs text-muted-foreground"><tf-icon name="pin" class="size-3"></tf-icon>Pinned</span>' : ''}
      </div>`;
    this.innerHTML = `
      <div class="flex gap-3">
        <div class="w-9 shrink-0 ${quote ? 'pt-5' : 'pt-0.5'}">${cont ? '<time class="hidden pt-0.5 text-[0.6875rem] tabular-nums text-muted-foreground group-hover:block">' + (a('time') || '') + '</time>' : '<tf-avatar model="' + model + '" name="' + name + '" size="lg"></tf-avatar>'}</div>
        <div class="min-w-0 flex-1">
          ${quote}${head}
          <div class="tf-msg-body mt-0.5 space-y-2 text-sm leading-6 text-foreground/95 [overflow-wrap:anywhere]">${body}</div>
          ${reactions ? '<div class="mt-1.5 flex flex-wrap gap-1">' + reactions + '<button class="inline-flex size-6 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100" aria-label="Add reaction"><tf-icon name="smile" class="size-3.5"></tf-icon></button></div>' : ''}
          ${thread ? '<a href="/chat-thread" class="mt-1.5 inline-flex items-center gap-2 rounded-md px-1 py-0.5 text-xs hover:bg-accent"><span class="flex -space-x-1">' + thread[1].split('|').map((s) => tfAv(s, 'xs')).join('') + '</span><span class="font-medium text-link">' + thread[0] + '</span><span class="text-muted-foreground">' + (thread[2] || '') + '</span></a>' : ''}
          ${seen.length || a('delivered') ? `<div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              ${a('delivered') ? '<span class="inline-flex items-center gap-1"><tf-icon name="terminal" class="size-3.5"></tf-icon>Delivered to ' + a('delivered') + '</span>' : ''}
              ${seen.length ? '<span class="inline-flex items-center gap-1.5" aria-label="Seen by ' + seen.length + ': ' + seenNames + '"><tf-icon name="check-check" class="size-3.5 text-primary"></tf-icon><span aria-hidden="true">Seen by</span><span class="flex -space-x-1" aria-hidden="true">' + seen.map((s) => tfAv(s, 'xs')).join('') + '</span></span>' : ''}
            </div>` : ''}
        </div>
      </div>
      <div class="absolute -top-3 right-4 z-10 ${this.hasAttribute('actions') ? 'flex' : 'hidden group-hover:flex group-focus-within:flex'} items-center rounded-lg border border-border bg-popover p-0.5 shadow-sm" role="toolbar" aria-label="Message actions">
        ${[['smile', 'Add reaction'], ['reply', 'Reply'], ['thread', 'Reply in thread'], ['pin', pinned ? 'Unpin' : 'Pin'], ['bookmark', 'Save for later'], ['more', 'More actions']].map(([i, l]) => '<button class="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="' + l + '" title="' + l + '"><tf-icon name="' + i + '" class="size-4"></tf-icon></button>').join('')}
      </div>`;
  }
}
if (!document.getElementById('tf-message-style')) {
  const st = document.createElement('style');
  st.id = 'tf-message-style';
  st.textContent = '.tf-msg-body code{font-family:var(--font-mono);font-size:.8125rem;padding:.1rem .3rem;border-radius:.25rem;background:var(--muted)} .tf-msg-body a{color:var(--link);text-underline-offset:2px} .tf-msg-body a:hover{text-decoration:underline}';
  document.head.appendChild(st);
}
customElements.define('tf-message', TfMessage);
