// <tf-shell active="board" title="Board" flush back="/chat" rail>   (flush, back and rail are optional)
//   <div slot="actions">header buttons</div>   (optional, moved into the top bar)
//   page content
// </tf-shell>
// active: home|overview|board|chat|agents|reviews|usage|design|activity|decisions|daily|database|toolbox|media|invites|api|settings|account
// flush: content fills the main area edge to edge with no padding (chat, design).
// rail: start with the desktop sidebar collapsed to an icon rail (the toggle in the sidebar header switches it).
const TF_GROUPS = [
  { title: 'Work', items: [
    { id: 'inbox', label: 'Inbox', icon: 'inbox', href: '/inbox', badge: '4', tip: 'Inbox, 4 waiting on you' },
    { id: 'overview', label: 'Overview', icon: 'layout-dashboard', href: '/overview' },
    { id: 'board', label: 'Board', icon: 'kanban', href: '/board', views: [
      { label: 'Agents at work', href: '/board-filters', count: '6' },
      { label: 'Needs review', href: '/board-filters', count: '2' },
      { label: 'Blocked on me', href: '/board-filters', count: '2' },
    ] },
    { id: 'chat', label: 'Chat', icon: 'messages', href: '/chat', badge: '12', mention: true, tip: 'Chat, 12 unread, 1 mention' },
    { id: 'agents', label: 'Agents', icon: 'bot', href: '/agents', live: '4', tip: 'Agents, 4 live' },
    { id: 'reviews', label: 'Reviews', icon: 'check-check', href: '/reviews', badge: '2', tip: 'Reviews, 2 waiting' },
  ] },
  { title: 'Insights', items: [
    { id: 'usage', label: 'Usage', icon: 'gauge', href: '/usage' },
    { id: 'decisions', label: 'Decisions', icon: 'scale', href: '/decisions', badge: '2', tip: 'Decisions, 2 open' },
    { id: 'activity', label: 'Activity', icon: 'activity', href: '/activity' },
    { id: 'daily', label: 'Daily update', icon: 'file-text', href: '/daily-update' },
  ] },
  { title: 'Project', collapsible: true, items: [
    { id: 'design', label: 'Design', icon: 'palette', href: '/design' },
    { id: 'database', label: 'Database', icon: 'database', href: '/database' },
    { id: 'toolbox', label: 'Toolbox', icon: 'wrench', href: '/toolbox' },
    { id: 'media', label: 'Media', icon: 'image', href: '/media' },
    { id: 'invites', label: 'Invites', icon: 'user-plus', href: '/invites' },
    { id: 'api', label: 'API keys', icon: 'key', href: '/api-keys' },
    { id: 'settings', label: 'Settings', icon: 'settings', href: '/project-settings' },
  ] },
];
const TF_FAVS = [
  { label: '#1025 v2_fe redesign', icon: 'circle-dot', tone: 'text-running', href: '/task' },
  { label: 'Agents at work', icon: 'list-filter', tone: 'text-muted-foreground', href: '/board-filters' },
  { label: 'design-room', icon: 'hash', tone: 'text-muted-foreground', href: '/chat', unread: true },
];
const TF_ROOMS = [
  { name: 'project-room', unread: '3', mention: true },
  { name: 'design-room', unread: '8' },
  { name: 'backend' },
];
const TF_DMS = [
  { name: 'reviewer (codex)', model: 'codex', status: 'running' },
  { name: 'DeepSeek (api)', model: 'deepseek', status: 'blocked', unread: '1' },
  { name: 'Achieng Otieno', model: 'human', status: 'offline' },
];
const TF_LIVE = [
  { name: 'Claude (main)', model: 'claude', status: 'running', doing: 'Improving the sidebar' },
  { name: 'reviewer (codex)', model: 'codex', status: 'running', doing: 'Building org pages' },
  { name: 'DeepSeek (api)', model: 'deepseek', status: 'blocked', doing: 'Waiting on your approval' },
  { name: 'Gemini (docs)', model: 'gemini', status: 'running', doing: 'Matchday fixtures copy' },
];
const TF_TAB_DEFS = [
  { id: 'board', label: 'Board', icon: 'kanban', href: '/board' },
  { id: 'chat', label: 'Chat', icon: 'messages', href: '/chat', badge: '12' },
  { id: 'agents', label: 'Agents', icon: 'bot', href: '/agents', live: '3' },
  { id: 'activity', label: 'Activity', icon: 'activity', href: '/activity' },
];

function tfWhenParsed(el, fn) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => fn.call(el), { once: true });
  else fn.call(el);
}
const tfCount = (n, strong) => '<span class="ml-auto rounded-full px-1.5 text-xs font-medium tabular-nums ' + (strong ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground') + '">' + n + '</span>';

class TfShell extends HTMLElement {
  connectedCallback() { if (!this._q) { this._q = true; tfWhenParsed(this, this.build); } }

  navLink(n, active) {
    const on = n.id === active;
    const right = n.badge ? tfCount(n.badge, n.mention)
      : n.live ? '<span class="ml-auto inline-flex items-center gap-1 text-xs tabular-nums text-muted-foreground"><span class="size-1.5 rounded-full bg-running"></span>' + n.live + '</span>' : '';
    const dot = n.mention ? '<span class="absolute right-0.5 top-0.5 rounded-full bg-primary px-1 text-[0.625rem] font-medium leading-4 text-primary-foreground">@</span>'
      : n.badge || n.live ? '<span class="absolute right-1.5 top-1.5 size-1.5 rounded-full ' + (n.live ? 'bg-running' : 'bg-foreground/60') + '"></span>' : '';
    let html = '<a href="' + n.href + '" ' + (on ? 'aria-current="page"' : '') + ' title="' + (n.tip || n.label) + '" class="tf-item relative flex h-8 items-center gap-2.5 rounded-md px-2 text-sm ' +
      (on ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground' : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground') + '">' +
      '<tf-icon name="' + n.icon + '" class="size-4 shrink-0 ' + (on ? 'text-sidebar-primary' : 'text-muted-foreground') + '"></tf-icon><span class="tf-label truncate">' + n.label + '</span><span class="tf-label contents">' + right + '</span><span class="tf-rail-only">' + dot + '</span></a>';
    if (on && n.views) {
      html += '<ul class="tf-label ml-4 mt-0.5 space-y-0.5 border-l border-sidebar-border pl-2">' + n.views.map((v) =>
        '<li><a href="' + v.href + '" class="flex h-7 items-center gap-2 rounded-md px-2 text-sm text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"><span class="truncate">' + v.label + '</span><span class="ml-auto text-xs tabular-nums text-muted-foreground">' + v.count + '</span></a></li>').join('') +
        '<li><a href="/board-filters" class="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground"><tf-icon name="plus" class="size-3"></tf-icon>New view</a></li></ul>';
    }
    return html;
  }

  section(id, title, count, body, action, open) {
    return '<details class="tf-sec group/sec" ' + (open ? 'open' : '') + ' data-sec="' + id + '">' +
      '<summary class="tf-label flex h-7 cursor-pointer list-none items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:text-foreground">' +
      '<tf-icon name="chevron-right" class="size-3 transition-transform group-open/sec:rotate-90"></tf-icon>' + title +
      (count ? '<span class="ml-1 tabular-nums group-open/sec:hidden">' + count + '</span>' : '') +
      (action ? '<button class="ml-auto rounded p-0.5 hover:bg-sidebar-accent" aria-label="' + action + '" title="' + action + '"><tf-icon name="plus" class="size-3.5"></tf-icon></button>' : '') +
      '</summary><div class="mt-0.5">' + body + '</div></details>';
  }

  sidebar(active, rail) {
        const liveShown = TF_LIVE.slice(0, 3);
    const liveBlock = this.section('live', 'Live now', String(TF_LIVE.length), '<ul class="space-y-0.5">' + liveShown.map((a) => `
            <li><a href="/agent-claude-main" class="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-sidebar-accent/60">
              <tf-avatar model="${a.model}" name="${a.name}" status="${a.status}" size="sm"></tf-avatar>
              <span class="min-w-0 flex-1"><span class="block truncate text-sm">${a.name}</span><span class="block truncate text-xs ${a.status === 'blocked' ? 'text-blocked' : 'text-muted-foreground'}">${a.doing}</span></span></a></li>`).join('') +
          (TF_LIVE.length > 3 ? '<li><a href="/agents" class="flex h-7 items-center gap-2 rounded-md px-2 text-xs text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground"><span class="flex -space-x-1">' + TF_LIVE.slice(3).map((a) => '<tf-avatar model="' + a.model + '" name="' + a.name + '" size="xs"></tf-avatar>').join('') + '</span>' + (TF_LIVE.length - 3) + ' more working</a></li>' : '') + '</ul>', '', true);
    const roomUnread = TF_ROOMS.filter((r) => r.unread).length;
    const dmUnread = TF_DMS.filter((d) => d.unread).length;
    return `
    <div class="flex h-full flex-col">
      <div class="tf-head flex h-14 shrink-0 items-center gap-1 px-2.5">
        <a href="/project-switcher" class="tf-switch flex min-w-0 flex-1 items-center gap-2.5 rounded-md p-1.5 text-left hover:bg-sidebar-accent/60" aria-label="Switch organisation or project" title="Supercode Hive / taskflow_v2">
          <span class="relative inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground"><tf-icon name="check-check" class="size-4"></tf-icon></span>
          <span class="tf-label min-w-0 flex-1"><span class="block truncate text-sm font-semibold">taskflow_v2</span><span class="block truncate text-xs text-muted-foreground">Supercode Hive</span></span>
          <tf-icon name="chevrons-up-down" class="tf-label size-4 text-muted-foreground"></tf-icon>
        </a>
        <button data-tf="rail" class="hidden size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground lg:inline-flex" aria-label="Collapse sidebar" aria-pressed="${rail}" title="Collapse sidebar (Ctrl B)"><tf-icon name="sidebar" class="size-4"></tf-icon></button>
      </div>

      <div class="flex items-center gap-1.5 px-2.5 pb-2">
        <button class="tf-search flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-sidebar-border bg-background px-2.5 text-sm text-muted-foreground hover:text-foreground" aria-label="Search or jump to (Ctrl K)" title="Search (Ctrl K)">
          <tf-icon name="search" class="size-4 shrink-0"></tf-icon><span class="tf-label truncate">Search</span><kbd class="tf-label ml-auto whitespace-nowrap rounded border border-border px-1 text-xs">Ctrl K</kbd>
        </button>
        <details class="tf-new relative">
          <summary class="inline-flex size-8 cursor-pointer list-none items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90" aria-label="Create" title="Create"><tf-icon name="plus" class="size-4"></tf-icon></summary>
          <div class="absolute right-0 top-full z-50 mt-1 w-56 rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg">
            <a href="/task-new" class="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent"><tf-icon name="circle-dot" class="size-4 text-muted-foreground"></tf-icon>New task<kbd class="ml-auto text-xs text-muted-foreground">C</kbd></a>
            <a href="/chat-inbox" class="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent"><tf-icon name="message-square" class="size-4 text-muted-foreground"></tf-icon>New message<kbd class="ml-auto text-xs text-muted-foreground">M</kbd></a>
            <a href="/chat--empty" class="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent"><tf-icon name="hash" class="size-4 text-muted-foreground"></tf-icon>New room</a>
            <a href="/agent-launch" class="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent"><tf-icon name="terminal" class="size-4 text-muted-foreground"></tf-icon>Launch an agent</a>
            <a href="/agent-new" class="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent"><tf-icon name="bot" class="size-4 text-muted-foreground"></tf-icon>Add an agent</a>
          </div>
        </details>
      </div>

      <div class="min-h-0 flex-1 space-y-4 overflow-y-auto px-2.5 pb-4">
        ${TF_GROUPS.map((g, gi) => {
          const inGroup = g.items.some((n) => n.id === active);
          const list = '<div class="space-y-0.5">' + g.items.map((n) => this.navLink(n, active)).join('') + '</div>';
          if (g.collapsible) return '<details class="tf-grp group/grp" ' + (inGroup ? 'open' : '') + '><summary class="tf-label flex h-7 cursor-pointer list-none items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:text-foreground"><tf-icon name="chevron-right" class="size-3 transition-transform group-open/grp:rotate-90"></tf-icon>' + g.title + '</summary><div class="mt-0.5">' + list + '</div></details>';
          return '<div><p class="tf-label px-2 pb-1 text-xs font-medium text-muted-foreground">' + g.title + '</p><div class="tf-rail-only mx-auto mb-1 h-px w-6 bg-sidebar-border"></div>' + list + '</div>' + (gi === 0 ? liveBlock : '');
        }).join('')}

        <div class="tf-rail-only"><div class="mx-auto mb-2 h-px w-6 bg-sidebar-border"></div><div class="flex flex-col items-center gap-2">${TF_LIVE.map((a) => '<a href="/agent-claude-main" title="' + a.name + ', ' + a.doing + '"><tf-avatar model="' + a.model + '" name="' + a.name + '" status="' + a.status + '" size="sm"></tf-avatar></a>').join('')}</div></div>

        ${this.section('favs', 'Favourites', '', '<ul class="space-y-0.5">' + TF_FAVS.map((f) =>
          '<li><a href="' + f.href + '" class="flex h-8 items-center gap-2 rounded-md px-2 text-sm ' + (f.unread ? 'font-medium text-sidebar-foreground' : 'text-sidebar-foreground/75') + ' hover:bg-sidebar-accent/60"><tf-icon name="' + f.icon + '" class="size-4 shrink-0 ' + f.tone + '"></tf-icon><span class="truncate">' + f.label + '</span>' + (f.unread ? '<span class="ml-auto size-1.5 rounded-full bg-primary"></span>' : '') + '</a></li>').join('') +
          '</ul><p class="px-2 pt-1 text-xs text-muted-foreground">Star a task, view or room to pin it here.</p>', '', true)}

        ${this.section('rooms', 'Rooms', roomUnread ? roomUnread + ' unread' : '', '<ul class="space-y-0.5">' + TF_ROOMS.map((r) => `
            <li><a href="/chat" class="flex h-8 items-center gap-2 rounded-md px-2 text-sm ${r.unread ? 'font-medium text-sidebar-foreground' : 'text-sidebar-foreground/70'} hover:bg-sidebar-accent/60">
              <tf-icon name="hash" class="size-4 shrink-0 text-muted-foreground"></tf-icon><span class="truncate">${r.name}</span>
              ${r.unread ? '<span class="ml-auto rounded-full px-1.5 text-xs font-medium tabular-nums ' + (r.mention ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground') + '" aria-label="' + r.unread + ' unread' + (r.mention ? ', you are mentioned' : '') + '">' + (r.mention ? '@' : '') + r.unread + '</span>' : ''}</a></li>`).join('') + '</ul>', 'New room', true)}

        ${this.section('dms', 'Direct messages', dmUnread ? dmUnread + ' unread' : '', '<ul class="space-y-0.5">' + TF_DMS.map((d) => `
            <li><a href="/chat" class="flex h-8 items-center gap-2 rounded-md px-2 text-sm ${d.unread ? 'font-medium' : 'text-sidebar-foreground/70'} hover:bg-sidebar-accent/60">
              <tf-avatar model="${d.model}" name="${d.name}" status="${d.status}" size="xs"></tf-avatar><span class="truncate">${d.name}</span>
              ${d.unread ? '<span class="ml-auto rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">' + d.unread + '</span>' : ''}</a></li>`).join('') + '</ul>', 'New message', true)}
      </div>

      <div class="tf-foot relative shrink-0 border-t border-sidebar-border p-2.5">
        <details class="tf-me relative">
          <summary class="flex cursor-pointer list-none items-center gap-2.5 rounded-md p-1 hover:bg-sidebar-accent/60" aria-label="dalmasonto, Available, on TaskFlow Cloud" title="dalmasonto, Available">
            <tf-avatar model="human" name="Dalmas Ogembo" status="running" size="sm"></tf-avatar>
            <span class="tf-label min-w-0 flex-1"><span class="block truncate text-sm font-medium">dalmasonto</span><span class="flex items-center gap-1 truncate text-xs text-muted-foreground"><tf-icon name="globe" class="size-3 shrink-0"></tf-icon><span class="truncate">TaskFlow Cloud</span></span></span>
            <tf-icon name="chevrons-up-down" class="tf-label size-4 text-muted-foreground"></tf-icon>
          </summary>
          <div class="absolute bottom-full left-0 z-50 mb-2 w-60 rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg">
            <p class="px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">Your status</p>
            <button class="flex w-full items-center gap-2 rounded-md bg-accent px-2 py-1.5 text-accent-foreground"><span class="size-2 rounded-full bg-running"></span>Available<tf-icon name="check" class="ml-auto size-4"></tf-icon></button>
            <button class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent"><span class="size-2 rounded-full bg-blocked"></span>Focus<span class="ml-auto text-xs text-muted-foreground">Agents queue messages</span></button>
            <button class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent"><span class="size-2 rounded-full border border-idle"></span>Away</button>
            <div class="my-1 h-px bg-border"></div>
            <a href="/account-profile" class="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent"><tf-icon name="user" class="size-4 text-muted-foreground"></tf-icon>Profile</a>
            <a href="/account-settings" class="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent"><tf-icon name="settings" class="size-4 text-muted-foreground"></tf-icon>Settings</a>
            <a href="/server-accounts" class="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent"><tf-icon name="globe" class="size-4 text-muted-foreground"></tf-icon>Switch server<span class="ml-auto truncate text-xs text-muted-foreground">Cloud</span></a>
            <a href="/login" class="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent"><tf-icon name="log-out" class="size-4 text-muted-foreground"></tf-icon>Sign out</a>
          </div>
        </details>
      </div>
    </div>`;
  }

  build() {
    if (this._done) return; this._done = true;
    const active = this.getAttribute('active') || '';
    const title = this.getAttribute('title') || '';
    this.removeAttribute('title');
    const flush = this.hasAttribute('flush');
    const back = this.getAttribute('back');
    const rail = this.hasAttribute('rail');
    const actions = this.querySelector(':scope > [slot="actions"]');
    if (actions) actions.remove();
    const content = document.createDocumentFragment();
    while (this.firstChild) content.appendChild(this.firstChild);
    this.className = 'block';
    if (!document.getElementById('tf-shell-style')) {
      const st = document.createElement('style');
      st.id = 'tf-shell-style';
      // Rail mode: hide labels, centre icons, keep sections as icon-only lists.
      st.textContent = '.tf-rail-only{display:none}' +
        '[data-rail="true"] .tf-label,[data-rail="true"] .tf-sec,[data-rail="true"] .tf-new{display:none}' +
        '[data-rail="true"] .tf-grp>div{display:block}' +
        '[data-rail="true"] .tf-rail-only{display:block}[data-rail="true"] a .tf-rail-only{display:inline}' +
        '[data-rail="true"] .tf-item,[data-rail="true"] .tf-switch,[data-rail="true"] .tf-search{justify-content:center;padding-left:0;padding-right:0}' +
        '[data-rail="true"] .tf-head{flex-direction:column;height:auto;padding-top:.625rem;padding-bottom:.25rem;gap:.25rem}' +
        '[data-rail="true"] .tf-item ul{display:none}' +
        '[data-rail="true"] .tf-item[aria-current="page"]::before{content:"";position:absolute;left:-0.625rem;top:.375rem;bottom:.375rem;width:2px;border-radius:2px;background:var(--foreground)}';
      document.head.appendChild(st);
    }
    this.innerHTML = `
    <a href="#tf-main" class="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground">Skip to content</a>
    <div class="flex h-dvh overflow-hidden bg-background text-foreground">
      <div data-tf="side" data-rail="${rail}" class="hidden shrink-0 border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 motion-reduce:transition-none lg:block ${rail ? 'w-14' : 'w-64'}">${this.sidebar(active, rail)}</div>
      <div class="fixed inset-0 z-40 hidden lg:hidden" data-tf="drawer" role="dialog" aria-modal="true" aria-label="Navigation">
        <div class="absolute inset-0 bg-black/50" data-tf="scrim"></div>
        <div class="absolute inset-y-0 left-0 w-72 max-w-[85%] border-r border-sidebar-border bg-sidebar text-sidebar-foreground shadow-xl" data-rail="false">${this.sidebar(active, false)}</div>
      </div>
      <div class="flex min-w-0 flex-1 flex-col">
        <div class="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background px-3 lg:px-6">
          ${back ? '<a href="' + back + '" class="-ml-1 rounded-md p-2 hover:bg-accent lg:hidden" aria-label="Back"><tf-icon name="chevron-left" class="size-5"></tf-icon></a>'
                 : '<button class="-ml-1 rounded-md p-2 hover:bg-accent lg:hidden" aria-label="Open menu" data-tf="open"><tf-icon name="menu" class="size-5"></tf-icon></button>'}
          <div class="min-w-0 flex-1"><h1 class="truncate text-base font-semibold">${title}</h1></div>
          <div class="flex items-center gap-1.5" data-tf="actions"></div>
          <a href="/agents" class="hidden items-center rounded-full border border-border py-0.5 pl-0.5 pr-2 hover:bg-accent sm:flex" aria-label="${TF_LIVE.length} agents live">
            <span class="flex -space-x-1.5">${TF_LIVE.slice(0, 3).map((a) => '<tf-avatar model="' + a.model + '" name="' + a.name + '" size="xs"></tf-avatar>').join('')}</span>
            <span class="ml-1.5 inline-flex items-center gap-1 text-xs tabular-nums text-muted-foreground"><span class="size-1.5 rounded-full bg-running"></span>${TF_LIVE.length}</span>
          </a>
          <a href="/inbox" class="relative rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Inbox, 4 unread"><tf-icon name="inbox" class="size-4.5"></tf-icon><span class="absolute right-1.5 top-1.5 size-2 rounded-full bg-primary ring-2 ring-background"></span></a>
        </div>
        <main id="tf-main" class="min-h-0 flex-1 ${flush ? 'flex flex-col overflow-hidden' : 'overflow-y-auto'} pb-16 lg:pb-0" data-tf="main"></main>
        <div class="fixed inset-x-0 bottom-0 z-30 grid h-16 grid-cols-5 border-t border-border bg-background lg:hidden" data-tf="tabbar">
          ${TF_TAB_DEFS.map((n) => '<a href="' + n.href + '" ' + (n.id === active ? 'aria-current="page"' : '') + ' class="relative flex flex-col items-center justify-center gap-1 text-xs ' + (n.id === active ? 'font-medium text-foreground' : 'text-muted-foreground') + '"><span class="relative"><tf-icon name="' + n.icon + '" class="size-5"></tf-icon>' + (n.badge ? '<span class="absolute -right-3 -top-1 rounded-full bg-primary px-1 text-[0.625rem] leading-4 text-primary-foreground tabular-nums">' + n.badge + '</span>' : '') + (n.live ? '<span class="absolute -right-1 -top-0.5 size-2 rounded-full bg-running ring-2 ring-background"></span>' : '') + '</span>' + n.label + (n.id === active ? '<span class="absolute inset-x-6 top-0 h-0.5 rounded-full bg-foreground"></span>' : '') + '</a>').join('')}
          <button class="flex flex-col items-center justify-center gap-1 text-xs text-muted-foreground" data-tf="open"><tf-icon name="menu" class="size-5"></tf-icon>More</button>
        </div>
      </div>
    </div>`;
    const main = this.querySelector('[data-tf="main"]');
    if (flush) main.appendChild(content);
    else { const wrap = document.createElement('div'); wrap.className = 'mx-auto w-full max-w-7xl px-4 py-5 lg:px-8 lg:py-6'; wrap.appendChild(content); main.appendChild(wrap); }
    if (actions) { actions.removeAttribute('slot'); actions.classList.add('flex', 'items-center', 'gap-1.5'); this.querySelector('[data-tf="actions"]').appendChild(actions); }
    const drawer = this.querySelector('[data-tf="drawer"]');
    const toggle = (open) => drawer.classList.toggle('hidden', !open);
    this.querySelectorAll('[data-tf="open"]').forEach((b) => b.addEventListener('click', () => toggle(true)));
    this.querySelector('[data-tf="scrim"]').addEventListener('click', () => toggle(false));
    const side = this.querySelector('[data-tf="side"]');
    const setRail = (on) => {
      side.dataset.rail = String(on);
      side.classList.toggle('w-14', on); side.classList.toggle('w-64', !on);
      const b = side.querySelector('[data-tf="rail"]');
      b.setAttribute('aria-pressed', String(on)); b.setAttribute('aria-label', on ? 'Expand sidebar' : 'Collapse sidebar');
    };
    side.querySelector('[data-tf="rail"]').addEventListener('click', () => setRail(side.dataset.rail !== 'true'));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { toggle(false); this.querySelectorAll('details.tf-new[open], details.tf-me[open]').forEach((d) => d.removeAttribute('open')); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); setRail(side.dataset.rail !== 'true'); }
    });
  }
}
customElements.define('tf-shell', TfShell);
