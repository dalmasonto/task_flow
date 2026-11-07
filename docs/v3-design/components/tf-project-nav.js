// <tf-project-nav active="general|instructions|endpoints|github|workflow|repos">
// Tabs across a project's settings. Workflow and Repositories are Claude's pages.
class TfProjectNav extends HTMLElement {
  connectedCallback() {
    if (this.dataset.r) return; this.dataset.r = '1';
    const active = this.getAttribute('active') || 'general';
    const tabs = [
      ['general', 'General', '/project-settings'],
      ['instructions', 'Agent instructions', '/project-instructions'],
      ['workflow', 'Workflow', '/project-workflow'],
      ['repos', 'Repositories', '/project-repos'],
      ['github', 'GitHub', '/project-github'],
      ['endpoints', 'Environments', '/project-endpoints'],
    ];
    this.classList.add('block');
    this.innerHTML = `<div role="navigation" aria-label="Project settings" class="-mx-4 overflow-x-auto border-b border-border px-4 lg:mx-0 lg:px-0">
      <ul class="flex gap-1">${tabs.map(([id, label, href]) => {
        const on = id === active;
        return `<li><a href="${href}" ${on ? 'aria-current="page"' : ''} class="relative flex h-10 items-center whitespace-nowrap px-3 text-sm ${on ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'}">${label}${on ? '<span class="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-foreground"></span>' : ''}</a></li>`;
      }).join('')}</ul></div>`;
  }
}
customElements.define('tf-project-nav', TfProjectNav);
