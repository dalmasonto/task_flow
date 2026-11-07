// <tf-public-nav active="home|pricing|docs" variant="default|auth">
// Public top bar. variant="auth" drops the section links and keeps only the
// wordmark plus the opposite auth action, so sign-up and log-in stay focused.
// Both variants are sticky to the top of the viewport.
const TF_NAV_LINKS = [
  { id: 'docs', label: 'Docs', href: '/docs' },
  { id: 'pricing', label: 'Pricing', href: '/pricing' },
  { id: 'github', label: 'GitHub', href: 'https://github.com/dalmasonto/task_flow' },
];
const TF_NAV_SHELL = 'sticky top-0 z-40 border-b border-border/60 bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70';
class TfPublicNav extends HTMLElement {
  static get observedAttributes() { return ['active', 'variant', 'auth']; }
  connectedCallback() { this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  render() {
    const active = this.getAttribute('active') || '';
    const variant = this.getAttribute('variant') || 'default';
    const auth = this.getAttribute('auth') || 'login';
    const mark = `<a href="/" class="flex items-center gap-2 rounded-md font-semibold tracking-tight text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring" aria-label="TaskFlow home">
        <span class="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground" aria-hidden="true">
          <svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h9"/><path d="M4 12h16"/><path d="M11 17h9"/></svg>
        </span>
        <span class="text-base">TaskFlow</span></a>`;
    const link = (l) => {
      const ext = l.href.startsWith('http');
      const on = l.id === active;
      return `<a href="${l.href}" ${ext ? 'rel="noopener"' : ''} ${on ? 'aria-current="page"' : ''}
        class="rounded-md px-3 py-2 text-sm ${on ? 'text-foreground font-medium' : 'text-muted-foreground'} hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">${l.label}</a>`;
    };
    if (variant === 'auth') {
      const other = auth === 'login'
        ? `<span class="hidden text-sm text-muted-foreground sm:inline">New to TaskFlow?</span><a href="/signup" class="rounded-md px-3 py-2 text-sm font-medium text-foreground hover:bg-accent">Create an account</a>`
        : `<span class="hidden text-sm text-muted-foreground sm:inline">Already have an account?</span><a href="/login" class="rounded-md px-3 py-2 text-sm font-medium text-foreground hover:bg-accent">Log in</a>`;
      this.innerHTML = `<header class="${TF_NAV_SHELL}"><div class="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-5">${mark}<div class="flex items-center gap-1">${other}</div></div></header>`;
      return;
    }
    this.innerHTML = `
      <header class="${TF_NAV_SHELL}">
        <div class="mx-auto flex h-16 w-full max-w-6xl items-center gap-6 px-5">
          ${mark}
          <nav aria-label="Main" class="hidden items-center md:flex">${TF_NAV_LINKS.map(link).join('')}</nav>
          <div class="ml-auto hidden items-center gap-2 md:flex">
            <a href="/login" class="rounded-md px-3 py-2 text-sm font-medium text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring">Log in</a>
            <a href="/signup" class="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Start a project</a>
          </div>
          <details class="relative ml-auto md:hidden">
            <summary class="grid size-11 cursor-pointer list-none place-items-center rounded-md hover:bg-accent" aria-label="Open menu">
              <svg viewBox="0 0 24 24" class="size-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
            </summary>
            <div class="absolute right-0 mt-2 w-60 rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-lg">
              <nav aria-label="Main" class="flex flex-col">${TF_NAV_LINKS.map(link).join('')}</nav>
              <div class="my-2 h-px bg-border"></div>
              <a href="/login" class="block rounded-md px-3 py-2 text-sm hover:bg-accent">Log in</a>
              <a href="/signup" class="mt-1 flex h-10 items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground">Start a project</a>
            </div>
          </details>
        </div>
      </header>`;
  }
}
customElements.define('tf-public-nav', TfPublicNav);
