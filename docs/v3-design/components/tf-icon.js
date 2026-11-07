// <tf-icon name="mic" class="size-4"> — a Lucide icon (the same family v2_fe ships via lucide-react).
// `name` is kebab-case Lucide ("square-kanban", "message-square"); a few short aliases are mapped below.
// Decorative by default (aria-hidden); pass label="..." to make it a named image.
const TF_ICON_ALIAS = {
  kanban: 'square-kanban', terminal: 'square-terminal', more: 'ellipsis', 'more-v': 'ellipsis-vertical',
  send: 'send-horizontal', smile: 'smile-plus', stop: 'square', 'git-pr': 'git-pull-request',
  'git-commit': 'git-commit-horizontal', filter: 'list-filter', columns: 'columns-3', key: 'key-round',
  loader: 'loader-circle', trash: 'trash-2', thread: 'message-square-text', home: 'house',
  alert: 'triangle-alert', messages: 'messages-square', sidebar: 'panel-left', maximize: 'maximize-2',
  minimize: 'minimize-2', alarm: 'alarm-clock', refresh: 'refresh-cw', waves: 'audio-lines',
  volume: 'volume-2', external: 'external-link', sliders: 'sliders-horizontal',
};
const tfPascal = (s) => s.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
let tfLucide = window.lucide ? Promise.resolve(window.lucide) : null;
function tfLoadLucide() {
  if (!tfLucide) {
    tfLucide = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/lucide@0.469.0/dist/umd/lucide.min.js';
      s.onload = () => resolve(window.lucide);
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
    });
  }
  return tfLucide;
}
class TfIcon extends HTMLElement {
  static get observedAttributes() { return ['name']; }
  connectedCallback() { this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  async render() {
    const raw = this.getAttribute('name') || 'circle';
    const name = TF_ICON_ALIAS[raw] || raw;
    if (!this.className.includes('size-')) this.classList.add('size-4');
    this.classList.add('inline-flex', 'shrink-0');
    const label = this.getAttribute('label');
    if (label) { this.setAttribute('role', 'img'); this.setAttribute('aria-label', label); }
    else this.setAttribute('aria-hidden', 'true');
    const L = await tfLoadLucide();
    const node = L && (L.icons?.[tfPascal(name)] || L[tfPascal(name)]);
    if (!node) { this.innerHTML = ''; return; }
    const kids = (node[2] || node).map(([t, a]) =>
      `<${t} ${Object.entries(a).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`).join('');
    const sw = this.getAttribute('stroke') || '2';
    this.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" class="size-full">${kids}</svg>`;
  }
}
customElements.define('tf-icon', TfIcon);
