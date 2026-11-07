// <tf-agent-rail room="design-room" context="Board / column header" context-kind="page|model|row"
//   agents="claude:Claude (main):running|codex:reviewer (codex):running" placeholder="Ask the design agents"
//   hint="Messages here carry the selected page, so agents know what you mean.">
//   <tf-message ...>...</tf-message> ...   (the conversation, oldest first)
// </tf-agent-rail>
// The agent chat that sits beside a working surface (Design, Database). It is the
// same room as /chat, filtered to this surface; the context chip rides on every
// message you send, so "make this bigger" reaches the agent with the target attached.
// Width and visibility belong to the page: wrap it in an aside that is a static
// column on wide screens and an overlay sheet on narrow ones.
const TF_RAIL_CTX_ICON = { page: 'layout', model: 'database', row: 'table' };
function tfRailParsed(el, fn) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => fn.call(el), { once: true });
  else fn.call(el);
}
class TfAgentRail extends HTMLElement {
  connectedCallback() { if (!this._q) { this._q = true; tfRailParsed(this, this.build); } }
  build() {
    if (this.hasAttribute('data-r')) return; this.setAttribute('data-r', '');
    const a = (k) => this.getAttribute(k);
    const room = a('room') || 'room';
    const ctx = a('context');
    const kind = a('context-kind') || 'page';
    const agents = (a('agents') || '').split('|').filter(Boolean).map((s) => { const [model, name, status] = s.split(':'); return { model, name, status }; });
    const here = agents.filter((x) => x.status !== 'offline').length;
    const messages = this.innerHTML;
    this.className = 'flex h-full w-full min-w-0 min-h-0 flex-col bg-background';
    this.innerHTML = `
      <div class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2.5">
        <tf-icon name="hash" class="size-4 text-muted-foreground"></tf-icon>
        <h2 class="min-w-0 truncate text-sm font-semibold">${room}</h2>
        <span class="ml-auto flex -space-x-1.5" aria-label="${here} agents here">${agents.map((x) => '<tf-avatar model="' + x.model + '" name="' + x.name + '" status="' + x.status + '" size="xs"></tf-avatar>').join('')}</span>
        <span class="text-xs tabular-nums text-muted-foreground">${here} here</span>
        <a href="/chat" class="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Open ${room} in Chat" title="Open in Chat"><tf-icon name="external" class="size-4"></tf-icon></a>
        <button type="button" class="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Close chat"><tf-icon name="x" class="size-4"></tf-icon></button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto py-2 [&_tf-message]:px-3" role="log" aria-label="${room} messages">${messages}</div>
      <div class="shrink-0 space-y-2 border-t border-border p-3">
        ${ctx ? `<div class="flex items-center gap-2 text-xs">
          <span class="text-muted-foreground">About</span>
          <span class="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-ring/40 bg-accent px-2 py-1 font-medium text-accent-foreground">
            <tf-icon name="${TF_RAIL_CTX_ICON[kind] || 'layout'}" class="size-3.5 shrink-0"></tf-icon><span class="truncate">${ctx}</span>
            <button type="button" class="-mr-1 rounded p-0.5 hover:bg-background" aria-label="Remove ${ctx} from the message"><tf-icon name="x" class="size-3"></tf-icon></button>
          </span>
        </div>` : ''}
        <tf-composer placeholder="${a('placeholder') || 'Message #' + room}" compact></tf-composer>
        ${a('hint') ? '<p class="text-xs text-muted-foreground">' + a('hint') + '</p>' : ''}
      </div>`;
  }
}
customElements.define('tf-agent-rail', TfAgentRail);
