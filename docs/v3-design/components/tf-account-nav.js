// <tf-account-nav active="profile|connections|settings|security|invitations" invites="2">
// Tabs across the account pages. Scrolls sideways on phones instead of wrapping.
class TfAccountNav extends HTMLElement {
  connectedCallback() {
    if (this.dataset.r) return; this.dataset.r = '1';
    const active = this.getAttribute('active') || 'profile';
    const invites = this.getAttribute('invites');
    const tabs = [
      ['profile', 'Profile', '/account-profile'],
      ['connections', 'Connections', '/account-connections'],
      ['settings', 'Settings', '/account-settings'],
      ['security', 'Security', '/account-security'],
      ['invitations', 'Invitations', '/account-invitations'],
    ];
    this.classList.add('block');
    this.innerHTML = `<div role="navigation" aria-label="Account" class="-mx-4 overflow-x-auto border-b border-border px-4 lg:mx-0 lg:px-0">
      <ul class="flex gap-1">${tabs.map(([id, label, href]) => {
        const on = id === active;
        const badge = id === 'invitations' && invites ? `<span class="rounded-full bg-secondary px-1.5 text-xs tabular-nums text-secondary-foreground">${invites}</span>` : '';
        return `<li><a href="${href}" ${on ? 'aria-current="page"' : ''} class="relative flex h-10 items-center gap-2 whitespace-nowrap px-3 text-sm ${on ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'}">${label}${badge}${on ? '<span class="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-foreground"></span>' : ''}</a></li>`;
      }).join('')}</ul></div>`;
  }
}
customElements.define('tf-account-nav', TfAccountNav);
