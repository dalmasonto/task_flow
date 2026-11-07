// <tf-avatar model="claude|codex|openai|deepseek|gemini|qwen|kimi|cursor|copilot|ollama|mistral|grok|human"
//            name="Claude (main)" status="running|idle|blocked|review|done|failed|offline" size="xs|sm|md|lg|xl">
// Agents: rounded square holding the model's real logo. Humans: a circle with initials.
// A status pip sits bottom-right when status is set. Hover shows the name.
const TF_LOGO_BASE = 'https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@1.101.0/icons/';
const TF_MODELS = {
  claude: { file: 'claude-color', label: 'Claude' },
  codex: { file: 'codex-color', label: 'Codex' },
  openai: { file: 'openai', label: 'OpenAI', invert: true },
  deepseek: { file: 'deepseek-color', label: 'DeepSeek' },
  gemini: { file: 'gemini-color', label: 'Gemini' },
  qwen: { file: 'qwen-color', label: 'Qwen' },
  kimi: { file: 'kimi-color', label: 'Kimi' },
  cursor: { file: 'cursor', label: 'Cursor', invert: true },
  copilot: { file: 'githubcopilot', label: 'GitHub Copilot', invert: true },
  ollama: { file: 'ollama', label: 'Ollama', invert: true },
  mistral: { file: 'mistral-color', label: 'Mistral' },
  grok: { file: 'grok', label: 'Grok', invert: true },
};
const TF_SIZES = {
  xs: { box: 'size-5', img: 'size-3', text: 'text-[0.55rem]', pip: 'size-2 ring-1' },
  sm: { box: 'size-6', img: 'size-3.5', text: 'text-[0.6rem]', pip: 'size-2.5 ring-2' },
  md: { box: 'size-8', img: 'size-4.5', text: 'text-xs', pip: 'size-2.5 ring-2' },
  lg: { box: 'size-10', img: 'size-6', text: 'text-sm', pip: 'size-3 ring-2' },
  xl: { box: 'size-14', img: 'size-8', text: 'text-lg', pip: 'size-3.5 ring-4' },
};
const TF_PIP = {
  running: 'bg-running', idle: 'bg-idle', blocked: 'bg-blocked', review: 'bg-review',
  done: 'bg-done', failed: 'bg-failed', offline: 'bg-background border border-idle',
};
class TfAvatar extends HTMLElement {
  static get observedAttributes() { return ['model', 'name', 'status', 'size']; }
  connectedCallback() { this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  render() {
    const model = (this.getAttribute('model') || 'human').toLowerCase();
    const name = this.getAttribute('name') || '';
    const status = this.getAttribute('status');
    const s = TF_SIZES[this.getAttribute('size') || 'md'] || TF_SIZES.md;
    const m = TF_MODELS[model];
    this.className = 'relative inline-flex shrink-0 align-middle';
    let inner, label;
    if (m) {
      label = name ? name + ', ' + m.label + ' agent' : m.label + ' agent';
      inner = '<span class="' + s.box + ' inline-flex items-center justify-center rounded-md border border-border bg-card" role="img" aria-label="' + label + '">' +
        '<img src="' + TF_LOGO_BASE + m.file + '.svg" alt="" class="' + s.img + ' ' + (m.invert ? 'tf-logo-mono' : '') + '" decoding="async"></span>';
    } else {
      label = name || 'Person';
      const initials = name.replace(/\(.*?\)/g, '').trim().split(/\s+/).map((w) => w[0] || '').join('').slice(0, 2).toUpperCase() || '?';
      inner = '<span class="' + s.box + ' ' + s.text + ' inline-flex items-center justify-center rounded-full bg-secondary font-semibold text-secondary-foreground" role="img" aria-label="' + label + '">' + initials + '</span>';
    }
    this.title = status ? label + ', ' + status : label;
    const pip = status && TF_PIP[status]
      ? '<span class="absolute -bottom-0.5 -right-0.5 rounded-full ring-background ' + s.pip + ' ' + TF_PIP[status] + '"></span>'
      : '';
    this.innerHTML = inner + pip;
  }
}
if (!document.getElementById('tf-avatar-style')) {
  const st = document.createElement('style');
  st.id = 'tf-avatar-style';
  st.textContent = ':root[data-theme="dark"] .tf-logo-mono, .dark .tf-logo-mono { filter: invert(1); }';
  document.head.appendChild(st);
}
customElements.define('tf-avatar', TfAvatar);
