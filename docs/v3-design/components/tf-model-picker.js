// <tf-model-picker name="first" selected="claude" [cols="2|3"] [models="claude,codex,..."]>
// Radio cards, one per agent model, with the model's real logo (via tf-avatar).
// The second line says how that model connects, so nobody picks one they cannot run.
// `models` limits and orders the list (default: all). "other" is any MCP client.
// At most 3 columns: in a half-width column 4 left the label under the check mark.
const TF_PICK_MODELS = [
  ['claude', 'Claude', 'Claude Code'],
  ['codex', 'Codex', 'Codex CLI'],
  ['gemini', 'Gemini', 'Gemini CLI'],
  ['deepseek', 'DeepSeek', 'via opencode'],
  ['qwen', 'Qwen', 'Qwen Code'],
  ['kimi', 'Kimi', 'via opencode'],
  ['cursor', 'Cursor', 'Cursor agent'],
  ['copilot', 'Copilot', 'Copilot agent'],
  ['ollama', 'Ollama', 'Local models'],
  ['mistral', 'Mistral', 'Vibe CLI'],
  ['grok', 'Grok', 'via opencode'],
  ['other', 'Other', 'Any MCP client'],
];
const TF_PICK_COLS = { '2': 'grid-cols-1 sm:grid-cols-2', '3': 'grid-cols-1 sm:grid-cols-2 2xl:grid-cols-3' };
class TfModelPicker extends HTMLElement {
  connectedCallback() { this.classList.add('block'); this.render(); }
  render() {
    const name = this.getAttribute('name') || 'model';
    const selected = this.getAttribute('selected') || 'claude';
    const cols = TF_PICK_COLS[this.getAttribute('cols') || '3'] || TF_PICK_COLS['3'];
    const only = (this.getAttribute('models') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const list = only.length ? only.map((k) => TF_PICK_MODELS.find((m) => m[0] === k)).filter(Boolean) : TF_PICK_MODELS;
    const card = ([k, label, how]) => {
      const on = k === selected;
      const logo = k === 'other'
        ? '<span class="grid size-8 shrink-0 place-items-center rounded-md border border-dashed border-border bg-card"><tf-icon name="box" class="size-4 text-muted-foreground"></tf-icon></span>'
        : `<tf-avatar model="${k}" name="${label}" size="md"></tf-avatar>`;
      return `<label class="relative flex min-w-0 cursor-pointer items-center gap-3 rounded-lg border p-3 pr-7 focus-within:outline-2 focus-within:outline-ring ${on ? 'border-primary bg-primary/5 ring-1 ring-primary' : `${k === 'other' ? 'border-dashed' : ''} border-border bg-card hover:bg-accent/50`}">
        <input type="radio" name="${name}-model" value="${k}" class="sr-only" ${on ? 'checked' : ''}>
        ${logo}
        <span class="min-w-0"><span class="block truncate text-sm font-medium text-card-foreground">${label}</span><span class="block text-xs leading-snug text-muted-foreground">${how}</span></span>
        ${on ? '<tf-icon name="circle-check" class="absolute right-2 top-2 size-4 text-primary"></tf-icon>' : ''}
      </label>`;
    };
    this.innerHTML = `<div role="radiogroup" class="grid gap-2 ${cols}">${list.map(card).join('')}</div>`;
    this.querySelectorAll('input').forEach((i) => i.addEventListener('change', () => {
      this.setAttribute('selected', i.value);
      this.render();
      this.querySelector(`input[value="${i.value}"]`).focus();
    }));
  }
}
customElements.define('tf-model-picker', TfModelPicker);
