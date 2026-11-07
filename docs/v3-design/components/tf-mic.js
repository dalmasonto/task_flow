// <tf-mic state="idle|listening|unsupported" for="field-id">
// Dictation control (#739). Sits inside a text field's corner. Design-only:
// clicking toggles idle <-> listening so the states can be reviewed.
class TfMic extends HTMLElement {
  static get observedAttributes() { return ['state']; }
  connectedCallback() { this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  render() {
    const state = this.getAttribute('state') || 'idle';
    const target = this.getAttribute('for') || '';
    const icon = `<svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg>`;
    if (state === 'unsupported') {
      this.innerHTML = `<button type="button" disabled class="grid size-8 place-items-center rounded-md text-muted-foreground opacity-50" title="Dictation is not available in this browser" aria-label="Dictation is not available in this browser">${icon}</button>`;
      return;
    }
    const on = state === 'listening';
    this.innerHTML = `<button type="button" ${target ? `aria-controls="${target}"` : ''} aria-pressed="${on}"
      aria-label="${on ? 'Stop dictation' : 'Dictate'}" title="${on ? 'Stop dictation' : 'Dictate'}"
      class="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring ${on ? 'bg-destructive/10 text-destructive' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'}">
      ${on ? '<span class="size-2 rounded-full bg-destructive motion-safe:animate-pulse" aria-hidden="true"></span>Listening' : icon}
    </button>`;
    this.querySelector('button').addEventListener('click', () => {
      this.setAttribute('state', on ? 'idle' : 'listening');
    });
  }
}
customElements.define('tf-mic', TfMic);
