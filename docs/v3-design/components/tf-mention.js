// <tf-mention kind="agent|user|all|here|page|task" model="codex" me>reviewer (codex)</tf-mention>   (model and me are optional)
// agent: tiny model logo + name. user: @name. all/here: highlighted broadcast chip. me: the viewer is mentioned.
// page: a design page link chip. task: #id chip.
const TF_MLOGO = { claude: 'claude-color', codex: 'codex-color', deepseek: 'deepseek-color', gemini: 'gemini-color', qwen: 'qwen-color', kimi: 'kimi-color', openai: 'openai' };
class TfMention extends HTMLElement {
  connectedCallback() {
    const go = () => {
      if (this.hasAttribute('data-r')) return;
      this.setAttribute('data-r', '');
      const kind = this.getAttribute('kind') || 'user';
      const label = this.textContent.trim().replace(/^@/, '');
      const me = this.hasAttribute('me');
      const model = this.getAttribute('model');
      let cls = 'bg-primary/12 text-primary hover:bg-primary/20';
      let inner = '@' + label;
      if (kind === 'all' || kind === 'here') { cls = 'bg-blocked/18 text-foreground'; inner = '@' + kind; }
      if (me) cls = 'bg-accent text-accent-foreground ring-1 ring-ring/50';
      if (kind === 'agent' && model && TF_MLOGO[model]) {
        inner = '@<img alt="" src="https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@1.101.0/icons/' + TF_MLOGO[model] + '.svg" class="mx-0.5 inline size-3.5 -translate-y-px ' + (model === 'openai' ? 'tf-logo-mono' : '') + '">' + label;
      }
      if (kind === 'page') inner = '<tf-icon name="palette" class="mr-0.5 size-3 -translate-y-px"></tf-icon>' + label;
      if (kind === 'task') { cls = 'bg-muted text-foreground hover:bg-accent'; inner = '<tf-icon name="circle-dot" class="mr-0.5 size-3 -translate-y-px text-muted-foreground"></tf-icon>' + label; }
      this.className = 'inline cursor-pointer whitespace-nowrap rounded px-1 py-px font-medium ' + cls;
      this.innerHTML = inner;
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true }); else go();
  }
}
customElements.define('tf-mention', TfMention);
