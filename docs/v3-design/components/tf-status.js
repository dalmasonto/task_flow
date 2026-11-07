// <tf-status value="running|idle|blocked|review|done|failed|todo|paused" [label="In review"]>
const TF_STATUS = {
  running: { icon: 'circle-dot', label: 'In progress', cls: 'text-running bg-running/10' },
  idle: { icon: 'circle', label: 'Idle', cls: 'text-muted-foreground bg-muted' },
  todo: { icon: 'circle-dashed', label: 'Not started', cls: 'text-muted-foreground bg-muted' },
  paused: { icon: 'circle-pause', label: 'Paused', cls: 'text-muted-foreground bg-muted' },
  blocked: { icon: 'alert', label: 'Blocked', cls: 'text-blocked bg-blocked/12' },
  review: { icon: 'eye', label: 'In review', cls: 'text-review bg-review/10' },
  done: { icon: 'circle-check', label: 'Done', cls: 'text-done bg-done/10' },
  failed: { icon: 'circle-x', label: 'Failed', cls: 'text-failed bg-failed/10' },
};
class TfStatus extends HTMLElement {
  static get observedAttributes() { return ['value', 'label']; }
  connectedCallback() { this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  render() {
    const s = TF_STATUS[this.getAttribute('value')] || TF_STATUS.idle;
    const label = this.getAttribute('label') || s.label;
    this.className = 'inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium ' + s.cls;
    this.innerHTML = '<tf-icon name="' + s.icon + '" class="size-3.5"></tf-icon><span>' + label + '</span>';
  }
}
customElements.define('tf-status', TfStatus);
