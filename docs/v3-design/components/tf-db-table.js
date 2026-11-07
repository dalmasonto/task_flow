// <tf-db-table name="TaskflowTask" plugin="tasks" rows="1,032" selected
//   fields="id:i64:pk|project:TaskflowProject:fk|title:String|assigned_agent_id:i64?">
// A model card for the schema view. Field spec: name:type[:pk|fk], ? marks optional.
// plugin picks the header stripe colour from the chart set, so relations to it match.
const TF_DB_PLUGIN = { projects: 'bg-chart-1', tasks: 'bg-chart-2', agents: 'bg-chart-3', design: 'bg-chart-4', toolbox: 'bg-chart-5', github: 'bg-muted-foreground' };
class TfDbTable extends HTMLElement {
  connectedCallback() {
    if (this.dataset.r) return; this.dataset.r = '1';
    const name = this.getAttribute('name') || 'Model';
    const plugin = this.getAttribute('plugin') || 'tasks';
    const rows = this.getAttribute('rows');
    const sel = this.hasAttribute('selected');
    const fields = (this.getAttribute('fields') || '').split('|').filter(Boolean).map((f) => f.split(':'));
    this.classList.add('block');
    this.innerHTML = `
      <div class="overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm ${sel ? 'border-ring ring-2 ring-ring/40' : 'border-border'}">
        <div class="flex items-center gap-2 border-b border-border px-3 py-2">
          <span class="size-2.5 shrink-0 rounded-sm ${TF_DB_PLUGIN[plugin] || 'bg-muted-foreground'}" aria-hidden="true"></span>
          <span class="truncate font-mono text-xs font-semibold">${name}</span>
          ${rows ? `<span class="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">${rows} rows</span>` : ''}
        </div>
        <ul class="divide-y divide-border/60">${fields.map(([f, t, k]) => `
          <li class="flex items-center gap-2 px-3 py-1 font-mono text-xs">
            <span class="w-5 shrink-0 text-xs font-sans font-medium ${k === 'pk' ? 'text-foreground' : 'text-link'}">${k === 'pk' ? 'PK' : k === 'fk' ? 'FK' : ''}</span>
            <span class="truncate">${f}</span>
            <span class="ml-auto truncate pl-2 text-muted-foreground">${t}</span>
          </li>`).join('')}</ul>
      </div>`;
  }
}
customElements.define('tf-db-table', TfDbTable);
