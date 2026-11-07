// <tf-password-field field-id="pw" label="Password" autocomplete="current-password|new-password"
//                    hint="At least 10 characters" error="" value="">
// Label above, hint and error below, show/hide toggle. Error replaces the hint.
// field-id (not id) names the input, so the host and the input never share an id.
class TfPasswordField extends HTMLElement {
  connectedCallback() {
    const id = this.getAttribute('field-id') || 'password';
    const label = this.getAttribute('label') || 'Password';
    const ac = this.getAttribute('autocomplete') || 'current-password';
    const hint = this.getAttribute('hint') || '';
    const error = this.getAttribute('error') || '';
    const value = this.getAttribute('value') || '';
    const desc = error ? `${id}-error` : hint ? `${id}-hint` : '';
    this.classList.add('block');
    this.innerHTML = `
      <label for="${id}" class="text-sm font-medium text-foreground">${label}</label>
      <div class="relative mt-2">
        <input id="${id}" name="${id}" type="password" autocomplete="${ac}" value="${value}" required
          ${desc ? `aria-describedby="${desc}"` : ''} ${error ? 'aria-invalid="true"' : ''}
          class="block h-11 w-full rounded-md border ${error ? 'border-destructive' : 'border-input'} bg-background pl-3 pr-16 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring">
        <button type="button" class="absolute inset-y-1 right-1 rounded px-3 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-ring" aria-controls="${id}" aria-pressed="false">Show</button>
      </div>
      ${error ? `<p id="${id}-error" class="mt-2 flex items-start gap-1.5 text-sm text-destructive"><tf-icon name="circle-alert" class="mt-0.5 size-4 shrink-0"></tf-icon>${error}</p>`
        : hint ? `<p id="${id}-hint" class="mt-2 text-sm text-muted-foreground">${hint}</p>` : ''}`;
    const input = this.querySelector('input');
    const btn = this.querySelector('button');
    btn.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? 'Hide' : 'Show';
      btn.setAttribute('aria-pressed', String(show));
    });
  }
}
customElements.define('tf-password-field', TfPasswordField);
