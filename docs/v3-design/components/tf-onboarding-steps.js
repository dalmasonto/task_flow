// <tf-onboarding-steps current="1|2|3|4">
// The onboarding sequence. Numbered because it IS a sequence; completed steps
// link back so a person can change an earlier answer.
const TF_OB_STEPS = [
  { label: 'Project', href: '/onboarding' },
  { label: 'Pick two agents', href: '/onboarding-agents' },
  { label: 'Connect them', href: '/onboarding-connect' },
  { label: 'First conversation', href: '/onboarding-handshake' },
];
class TfOnboardingSteps extends HTMLElement {
  static get observedAttributes() { return ['current']; }
  connectedCallback() { this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  render() {
    const cur = Math.max(1, Math.min(4, parseInt(this.getAttribute('current') || '1', 10)));
    const items = TF_OB_STEPS.map((s, i) => {
      const n = i + 1;
      const state = n < cur ? 'done' : n === cur ? 'current' : 'todo';
      const dot = state === 'done'
        ? `<span class="grid size-6 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground"><svg viewBox="0 0 24 24" class="size-3.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg></span>`
        : `<span class="grid size-6 shrink-0 place-items-center rounded-full text-xs font-medium ${state === 'current' ? 'bg-primary text-primary-foreground' : 'border border-border text-muted-foreground'}">${n}</span>`;
      const text = `<span class="text-sm ${state === 'todo' ? 'text-muted-foreground' : 'font-medium text-foreground'} ${state === 'current' ? '' : 'hidden sm:inline'}">${s.label}</span>`;
      const inner = `${dot}${text}`;
      const body = state === 'done'
        ? `<a href="${s.href}" class="flex items-center gap-2 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">${inner}<span class="sr-only">(completed, edit)</span></a>`
        : `<span class="flex items-center gap-2" ${state === 'current' ? 'aria-current="step"' : ''}>${inner}</span>`;
      const bar = n < 4 ? `<span class="h-px min-w-4 flex-1 ${n < cur ? 'bg-primary' : 'bg-border'}" aria-hidden="true"></span>` : '';
      return `<li class="flex flex-1 items-center gap-3 last:flex-none">${body}${bar}</li>`;
    }).join('');
    this.innerHTML = `<nav aria-label="Setup progress"><p class="sr-only">Step ${cur} of 4</p><ol class="flex w-full items-center gap-3">${items}</ol></nav>`;
  }
}
customElements.define('tf-onboarding-steps', TfOnboardingSteps);
