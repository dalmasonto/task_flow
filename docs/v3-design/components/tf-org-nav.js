// <tf-org-nav active="overview|members|agents|licence|audit|settings" org="Supercode Hive" plan="Noncommercial">
// Org identity and its tabs. Sits at the top of every org page, inside tf-shell.
class TfOrgNav extends HTMLElement {
  connectedCallback() {
    if (this.dataset.r) return; this.dataset.r = '1';
    const active = this.getAttribute('active') || 'overview';
    const org = this.getAttribute('org') || 'Supercode Hive';
    const plan = this.getAttribute('plan') || 'Noncommercial';
    const tabs = [
      ['overview', 'Overview', '/org'],
      ['members', 'People', '/org-members'],
      ['agents', 'Agents and budget', '/org-agents'],
      ['licence', 'Licence', '/org-licence'],
      ['audit', 'Audit log', '/org-audit'],
      ['settings', 'Settings', '/org-settings'],
    ];
    const initials = org.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
    this.classList.add('block');
    this.innerHTML = `
      <div class="flex flex-wrap items-center gap-3">
        <span class="grid size-10 shrink-0 place-items-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground" aria-hidden="true">${initials}</span>
        <div class="min-w-0 flex-1">
          <p class="truncate text-lg font-semibold tracking-tight text-foreground">${org}</p>
          <p class="text-xs text-muted-foreground">Organisation. <a href="/org-licence" class="text-link underline underline-offset-4">${plan} licence</a></p>
        </div>
      </div>
      <div role="navigation" aria-label="Organisation" class="-mx-4 mt-4 overflow-x-auto border-b border-border px-4 lg:mx-0 lg:px-0">
        <ul class="flex gap-1">${tabs.map(([id, label, href]) => {
          const on = id === active;
          return `<li><a href="${href}" ${on ? 'aria-current="page"' : ''} class="relative flex h-10 items-center whitespace-nowrap px-3 text-sm ${on ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'}">${label}${on ? '<span class="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-foreground"></span>' : ''}</a></li>`;
        }).join('')}</ul>
      </div>`;
  }
}
customElements.define('tf-org-nav', TfOrgNav);
