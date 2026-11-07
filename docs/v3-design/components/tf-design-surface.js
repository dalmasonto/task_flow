// <tf-design-surface tab="inspect|comments|pages|tokens|components" [commenting] [batch="2"]>
// The Design page body: grouped toolbar, left design chat, canvas, right panel.
// `commenting` shows the on-canvas comment box at the picked element (Comment tool on).
// Glyphs are written as HTML entities on purpose (#1027: multibyte before a bracket 500s).
const TFD_TABS = [['inspect', 'Inspect'], ['comments', 'Comments'], ['pages', 'Pages'], ['tokens', 'Tokens'], ['components', 'Components']];
const tfdBtn = 'inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2 text-sm hover:bg-accent';
const tfdBtnLg = 'hidden h-8 items-center gap-1.5 rounded-md border border-border px-2 text-sm hover:bg-accent lg:inline-flex';
const tfdSeg = (on) => 'inline-flex h-7 items-center gap-1 rounded px-2 ' + (on ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:text-foreground');
const tfdPin = (n, tone, extra) => '<span class="absolute z-10 grid size-5 place-items-center rounded-full rounded-bl-none text-[0.6875rem] font-semibold shadow-sm ' + tone + ' ' + (extra || '') + '">' + n + '</span>';
const tfdSw = (cls) => '<span class="size-4 shrink-0 rounded border border-border ' + cls + '"></span>';

function tfdToolbar(a, comment) {
  const batch = a('batch');
  return `
  <div class="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border px-2 py-2 lg:px-3 [&>*]:shrink-0">
    <button type="button" aria-pressed="true" class="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-2 text-sm font-medium text-accent-foreground" title="Hide design chat"><tf-icon name="panel-left" class="size-4"></tf-icon><span class="hidden 2xl:inline">Chat</span></button>
    <span class="mx-0.5 hidden h-5 w-px bg-border lg:block"></span>
    <button type="button" class="${tfdBtnLg}" title="Devices on the canvas"><tf-icon name="laptop" class="size-4"></tf-icon><span class="hidden xl:inline">2 devices</span><tf-icon name="chevron-down" class="size-3.5 text-muted-foreground"></tf-icon></button>
    <div class="hidden rounded-md border border-border p-0.5 text-sm 2xl:inline-flex" role="group" aria-label="Frame">
      <button aria-pressed="true" class="${tfdSeg(true)}">Device</button><button aria-pressed="false" class="${tfdSeg(false)}">Classic</button><button aria-pressed="false" class="${tfdSeg(false)}">Plain</button>
    </div>
    <button type="button" class="${tfdBtnLg} 2xl:hidden" title="Frame: Device"><tf-icon name="smartphone" class="size-4"></tf-icon><tf-icon name="chevron-down" class="size-3.5 text-muted-foreground"></tf-icon></button>
    <button type="button" class="${tfdBtnLg}" title="Canvas layout"><tf-icon name="layout-grid" class="size-4"></tf-icon><span class="hidden 2xl:inline">Groups</span><tf-icon name="chevron-down" class="size-3.5 text-muted-foreground"></tf-icon></button>
    <div class="hidden items-center rounded-md border border-border text-sm lg:inline-flex"><button class="rounded-l-md p-1.5 text-muted-foreground hover:bg-accent" aria-label="Zoom out"><tf-icon name="minus" class="size-3.5"></tf-icon></button><span class="px-1.5 text-xs tabular-nums">62%</span><button class="rounded-r-md p-1.5 text-muted-foreground hover:bg-accent" aria-label="Zoom in"><tf-icon name="plus" class="size-3.5"></tf-icon></button></div>
    <span class="mx-0.5 h-5 w-px bg-border"></span>
    <div class="inline-flex rounded-md border border-border p-0.5 text-sm" role="group" aria-label="Canvas tool">
      <button aria-pressed="${!comment}" class="${tfdSeg(!comment)}" title="Select (V)"><tf-icon name="mouse-pointer" class="size-3.5"></tf-icon><span class="hidden xl:inline">Select</span></button>
      <button aria-pressed="false" class="${tfdSeg(false)}" title="Pan (H)"><tf-icon name="hand" class="size-3.5"></tf-icon><span class="hidden xl:inline">Pan</span></button>
      <button aria-pressed="${comment}" class="inline-flex h-7 items-center gap-1 rounded px-2 ${comment ? 'bg-primary font-medium text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}" title="Comment on an element (C)"><tf-icon name="message-square-plus" class="size-3.5"></tf-icon>Comment</button>
    </div>
    <div class="ml-auto flex items-center gap-1.5">
      ${batch ? `<span class="hidden h-8 lg:inline-flex items-center gap-2 rounded-md border border-blocked/40 bg-blocked/10 pl-2.5 pr-1 text-sm"><span class="font-medium tabular-nums">${batch} queued</span><button class="h-6 rounded bg-primary px-2 text-xs font-medium text-primary-foreground">Send</button></span>` : ''}
      <button class="${tfdBtnLg}" title="Open the task board (Ctrl B)"><tf-icon name="kanban" class="size-4"></tf-icon><span class="hidden 2xl:inline">Board</span></button>
      <button class="${tfdBtnLg}" title="Theme"><tf-icon name="sun" class="size-4"></tf-icon><span class="hidden 2xl:inline">Light</span><tf-icon name="chevron-down" class="size-3.5 text-muted-foreground"></tf-icon></button>
      <button class="${tfdBtn}" aria-label="More: Export, Compare, Responsive review" title="Devices, frame, zoom, theme, Export, Compare (all in here on small screens)"><tf-icon name="more" class="size-4"></tf-icon></button>
      <button type="button" aria-pressed="true" class="inline-flex h-8 items-center rounded-md bg-accent px-2 text-sm text-accent-foreground" aria-label="Hide side panel" title="Hide side panel"><tf-icon name="panel-right" class="size-4"></tf-icon></button>
    </div>
  </div>`;
}

function tfdChat() {
  const card = `<div class="mt-1 overflow-hidden rounded-lg border border-border bg-card text-xs">
      <div class="flex items-center gap-2 border-b border-border px-2.5 py-1.5"><span class="grid size-4 place-items-center rounded-full rounded-bl-none bg-link text-[0.625rem] font-semibold text-background">3</span><span class="font-medium">Comment on /board</span><span class="ml-auto text-link">Sent</span></div>
      <div class="flex gap-2 p-2.5"><span class="flex h-10 w-14 shrink-0 gap-0.5 rounded border border-border bg-background p-0.5" aria-hidden="true"><span class="flex-1 rounded-sm bg-muted"></span><span class="flex-1 rounded-sm bg-running/30 outline outline-1 outline-primary"></span><span class="flex-1 rounded-sm bg-muted"></span></span>
      <div class="min-w-0"><p class="text-sm leading-5">Make the column title bigger and put the count beside it.</p><p class="mt-0.5 truncate font-mono text-muted-foreground">h3.column-title, board.html:42</p></div></div></div>`;
  return `<div role="complementary" class="absolute inset-y-0 left-0 z-30 hidden w-full max-w-sm border-r border-border shadow-lg lg:static lg:z-auto lg:flex lg:w-80 lg:shrink-0 lg:shadow-none" aria-label="Design chat">
    <tf-agent-rail room="design-room" context="Board &#183; column title" context-kind="page"
      agents="claude:Claude (main):running|codex:reviewer (codex):running|deepseek:DeepSeek (api):offline"
      placeholder="Ask the design agents" hint="Comments you send land here too, so the reply sits under what you asked.">
      <tf-message model="human" name="Dalmas Ogembo" time="16:40" role="Owner">${card}</tf-message>
      <tf-message model="claude" name="Claude (main)" time="16:41" reply-name="Dalmas Ogembo" reply-text="Comment 3 on /board"><p>On it. I'll post before and after renders here.</p></tf-message>
      <tf-message model="codex" name="reviewer (codex)" time="16:49"><p>The Done column also falls off at 1440. Worth a right-edge fade while you are in there.</p></tf-message>
    </tf-agent-rail>
  </div>`;
}

function tfdCanvas(popover) {
  const batchSheet = '<p class="mt-3 flex items-center gap-2 border-t border-border pt-3 text-xs md:hidden"><span class="font-medium">1 queued</span><button class="ml-auto h-7 rounded-md border border-border px-2">Send all</button></p>';
  const pop = popover ? `
    <div class="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl border border-border bg-popover p-4 pb-6 md:absolute md:inset-x-auto md:bottom-auto md:left-[5.5rem] md:top-[14.25rem] md:z-30 md:w-72 md:rounded-xl md:p-3 text-popover-foreground shadow-xl" role="dialog" aria-label="Comment on h3.column-title">
      <span class="absolute -top-1.5 left-[7.5rem] hidden size-3 rotate-45 border-l border-t border-border bg-popover md:block"></span><span class="mx-auto -mt-1 mb-3 block h-1 w-10 rounded-full bg-border md:hidden" aria-hidden="true"></span>
      <p class="flex items-center gap-1.5 font-mono text-xs text-muted-foreground"><tf-icon name="crosshair" class="size-3.5 text-primary"></tf-icon>h3.column-title</p>
      <label for="pop-body" class="sr-only">What should change?</label>
      <textarea id="pop-body" rows="3" placeholder="What should change?" class="mt-2 w-full rounded-md border border-ring bg-background p-2 text-sm outline-none ring-2 ring-ring/20">Make the column title bigger and put the count beside it.</textarea>
      <div class="mt-2 inline-flex rounded-md border border-border p-0.5 text-xs" role="radiogroup" aria-label="Scope">
        <button role="radio" aria-checked="true" class="rounded bg-accent px-2 py-1 font-medium text-accent-foreground">Just here</button>
        <button role="radio" aria-checked="false" class="rounded px-2 py-1 text-muted-foreground hover:text-foreground">All 3 pages</button>
      </div>
      <div class="mt-3 flex items-center gap-2 text-xs"><span class="text-muted-foreground">To</span><button type="button" class="inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-border bg-background px-2 hover:bg-accent"><tf-avatar model="claude" name="Claude (main)" status="running" size="xs"></tf-avatar><span class="truncate">Claude (main)</span><tf-icon name="chevron-down" class="size-3 text-muted-foreground"></tf-icon></button></div>
      <div class="mt-2 flex items-center gap-2">
        <button type="button" class="h-8 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent">Add to batch</button>
        <button type="submit" class="ml-auto inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"><tf-icon name="send" class="size-3.5"></tf-icon>Send</button>
      </div>
      <p class="mt-2 text-xs text-muted-foreground"><span class="hidden md:inline">Ctrl Enter sends. Esc closes. Opens below the element here because the right side has no room.</span></p>${batchSheet}
    </div>` : '';
  return `<div class="relative min-w-0 flex-1 overflow-auto bg-muted/50 [background-image:radial-gradient(var(--border)_1px,transparent_1px)] [background-size:20px_20px]" aria-label="Canvas, Board group">
    ${popover ? '<p class="sticky left-0 top-0 z-20 flex items-center gap-2 border-b border-primary/20 bg-background/90 px-4 py-1.5 text-xs backdrop-blur"><tf-icon name="message-square-plus" class="size-3.5 text-primary"></tf-icon><span class="font-medium">Comment tool.</span><span class="text-muted-foreground">Click any element. Esc to stop.</span></p>' : ''}
    <div class="relative flex min-w-max items-start gap-10 p-6">
      <figure class="relative">
        <figcaption class="mb-2 flex items-center gap-2 text-xs"><span class="font-medium">Board</span><span class="text-muted-foreground">Laptop</span><span class="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 text-muted-foreground"><span class="size-1.5 rounded-full bg-running motion-safe:animate-pulse"></span>Claude writing</span></figcaption>
        <div class="relative w-72 rounded-lg border border-border bg-card p-1.5 shadow-md">
          ${tfdPin(1, 'bg-primary text-primary-foreground', '-left-2 top-10')}
          ${tfdPin(3, 'bg-link text-background', 'left-[8.6rem] -top-2')}
          ${tfdPin(2, 'bg-running text-background', 'right-3 top-24')}
          <div class="flex h-44 overflow-hidden rounded bg-background">
            <div class="w-10 shrink-0 space-y-1.5 border-r border-border bg-sidebar p-1.5"><span class="block h-2 rounded bg-foreground/20"></span><span class="block h-1.5 rounded bg-foreground/10"></span><span class="block h-1.5 rounded bg-accent"></span></div>
            <div class="flex flex-1 gap-1.5 p-1.5">
              <div class="flex-1 space-y-1 rounded bg-muted p-1"><span class="block h-1.5 w-1/2 rounded bg-idle/50"></span><span class="block h-6 rounded border border-border bg-card"></span><span class="block h-6 rounded border border-border bg-card"></span></div>
              <div class="flex-1 space-y-1 rounded bg-muted p-1"><span class="block h-2 w-full rounded bg-running/60 ${popover ? 'outline outline-2 outline-offset-2 outline-primary' : ''}"></span><span class="block h-8 rounded border border-border bg-card"></span><span class="block h-6 rounded border border-border bg-card"></span></div>
              <div class="flex-1 space-y-1 rounded bg-muted p-1"><span class="block h-1.5 w-1/2 rounded bg-review/60"></span><span class="block h-6 rounded border border-border bg-card"></span></div>
            </div>
          </div>
        </div>
      </figure>
      ${pop}
      <figure>
        <figcaption class="mb-2 flex items-center gap-2 text-xs"><span class="font-medium">Board</span><span class="text-muted-foreground">iPhone 16 Pro</span></figcaption>
        <div class="w-28 rounded-2xl border-4 border-foreground/80 bg-card p-0.5 shadow-md">
          <div class="h-52 space-y-1.5 overflow-hidden rounded-xl bg-background p-1.5"><span class="mx-auto block h-1 w-8 rounded-full bg-foreground/30"></span><span class="block h-2 w-1/2 rounded bg-running/60"></span><span class="block h-8 rounded border border-border"></span><span class="block h-8 rounded border border-border"></span><span class="block h-8 rounded border border-border"></span></div>
        </div>
      </figure>
    </div>
    <div class="flex items-center gap-3 px-6 pb-6 text-xs text-muted-foreground"><span class="inline-flex items-center gap-1.5"><span class="size-2.5 rounded-full bg-primary"></span>open</span><span class="inline-flex items-center gap-1.5"><span class="size-2.5 rounded-full bg-link"></span>sent to an agent</span><span class="inline-flex items-center gap-1.5"><span class="size-2.5 rounded-full bg-running"></span>done</span></div>
  </div>`;
}

const TFD_PANEL = {
  inspect: () => `
    <div class="flex items-start gap-2">
      <div class="min-w-0 flex-1"><p class="font-mono text-sm font-semibold">h3.column-title</p><p class="text-xs text-muted-foreground">"In progress" on Board, laptop</p></div>
      <button class="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-primary px-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"><tf-icon name="message-square-plus" class="size-4"></tf-icon>Comment</button>
    </div>
    <div class="flex flex-wrap items-center gap-0.5 font-mono text-xs text-muted-foreground" aria-label="Element path"><button class="rounded px-1 hover:bg-accent">main</button>&#8250;<button class="rounded px-1 hover:bg-accent">section.board</button>&#8250;<button class="rounded px-1 hover:bg-accent">div.column</button>&#8250;<span class="rounded bg-primary/10 px-1 font-medium text-foreground">h3</span></div>
    <dl class="grid grid-cols-[5rem_1fr] gap-x-2 gap-y-2 rounded-lg border border-border p-3 text-xs">
      <dt class="text-muted-foreground">Source</dt><dd><a href="/board" class="font-mono text-link hover:underline">pages/board.html:42</a></dd>
      <dt class="text-muted-foreground">Component</dt><dd>none, page markup</dd>
      <dt class="text-muted-foreground">Shows on</dt><dd>Board, Board list, Board filters</dd>
    </dl>
    <section><h3 class="text-xs font-medium text-muted-foreground">Colours</h3>
      <ul class="mt-2 space-y-1.5 text-xs">
        <li class="flex items-center gap-2">${tfdSw('bg-foreground')}<span>Text</span><span class="ml-auto font-mono text-muted-foreground">foreground</span></li>
        <li class="flex items-center gap-2">${tfdSw('bg-running')}<span>Status dot</span><span class="ml-auto font-mono text-muted-foreground">running</span></li>
        <li class="flex items-center gap-2">${tfdSw('bg-muted')}<span>Column</span><span class="ml-auto font-mono text-muted-foreground">muted</span></li>
      </ul></section>
    <section><h3 class="text-xs font-medium text-muted-foreground">Type and spacing</h3>
      <div class="mt-2 flex flex-wrap gap-1.5 font-mono text-xs"><span class="rounded bg-muted px-1.5 py-0.5">text-sm</span><span class="rounded bg-muted px-1.5 py-0.5">font-medium</span><span class="rounded bg-muted px-1.5 py-0.5">px-1</span></div></section>
    <section><h3 class="text-xs font-medium text-muted-foreground">Comments here</h3>
      <a href="/design--comments" class="mt-2 flex items-center gap-2 rounded-lg border border-border p-2.5 text-sm hover:bg-accent"><span class="grid size-5 place-items-center rounded-full rounded-bl-none bg-link text-[0.6875rem] font-semibold text-background">3</span><span class="min-w-0 flex-1 truncate">Make the column title bigger</span><span class="text-xs text-link">Sent</span></a></section>
    <div class="flex gap-1.5 text-xs"><button class="flex-1 rounded-md border border-border py-1.5 hover:bg-accent">Select parent</button><button class="flex-1 rounded-md border border-border py-1.5 hover:bg-accent">Ask about this element</button></div>`,

  comments: () => {
    const c = (n, tone, page, el, body, status, who, extra) => `
      <li class="rounded-lg border border-border p-3 ${extra || ''}">
        <div class="flex items-center gap-2 text-xs"><span class="grid size-5 place-items-center rounded-full rounded-bl-none text-[0.6875rem] font-semibold ${tone}">${n}</span><a href="/board" class="font-medium hover:underline">${page}</a><span class="truncate font-mono text-muted-foreground">${el}</span></div>
        <p class="mt-1.5 text-sm leading-5">${body}</p>
        <div class="mt-2 flex items-center gap-2 text-xs">${status}${who}</div>
      </li>`;
    return `
    <div class="flex gap-1 text-xs" role="tablist" aria-label="Filter comments">
      <button role="tab" aria-selected="true" class="rounded-full bg-primary px-2.5 py-1 font-medium text-primary-foreground">Open 1</button>
      <button role="tab" aria-selected="false" class="rounded-full border border-border px-2.5 py-1 hover:bg-accent">Sent 2</button>
      <button role="tab" aria-selected="false" class="rounded-full border border-border px-2.5 py-1 hover:bg-accent">Done 5</button>
      <button class="ml-auto rounded-md px-1.5 text-muted-foreground hover:bg-accent" aria-label="This page or all pages" title="This page only"><tf-icon name="filter" class="size-3.5"></tf-icon></button>
    </div>
    <ul class="space-y-2">
      ${c(1, 'bg-primary text-primary-foreground', '/board', 'div.sidebar', 'The rail icons need labels on hover.', '<span class="text-muted-foreground">Not sent yet</span>', '<button class="ml-auto inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2 font-medium text-primary-foreground"><tf-icon name="send" class="size-3"></tf-icon>Send to Claude (main)</button>')}
    </ul>
    <p class="pt-1 text-xs font-medium text-muted-foreground">Sent</p>
    <ul class="space-y-2">
      ${c(3, 'bg-link text-background', '/board', 'h3.column-title', 'Make the column title bigger and put the count beside it.', '<span class="inline-flex items-center gap-1 text-link"><tf-avatar model="claude" name="Claude (main)" size="xs"></tf-avatar>Claude (main) is working</span>', '<a href="/design" class="ml-auto text-link hover:underline">In chat</a>')}
      ${c(2, 'bg-running text-background', '/board', 'div.column:last-child', 'Fade the right edge when Done is off screen.', '<span class="inline-flex items-center gap-1 text-running"><tf-icon name="circle-check" class="size-3.5"></tf-icon>Addressed, waiting for you</span>', '<button class="ml-auto h-7 rounded-md border border-border px-2 hover:bg-accent">Resolve</button>')}
    </ul>
    <p class="text-xs text-muted-foreground">Click a comment to jump to its pin. Dismissed comments are under Done.</p>`;
  },

  pages: () => {
    const row = (label, route, extra, on) => `<li><a href="${route}" ${on ? 'aria-current="page"' : ''} class="group flex h-8 items-center gap-2 rounded-md px-2 ${on ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}"><tf-icon name="grip" class="size-3.5 opacity-0 group-hover:opacity-60"></tf-icon><span class="min-w-0 flex-1 truncate">${label}</span>${extra || ''}</a></li>`;
    const grp = (name, n, open, body) => `<details class="group" ${open ? 'open' : ''}><summary class="flex h-8 cursor-pointer list-none items-center gap-2 rounded-md px-2 text-sm font-medium hover:bg-muted"><tf-icon name="chevron-right" class="size-3.5 text-muted-foreground transition-transform group-open:rotate-90"></tf-icon>${name}<span class="ml-auto text-xs font-normal tabular-nums text-muted-foreground">${n}</span></summary>${body || ''}</details>`;
    return `
    <div class="flex gap-1.5"><label class="flex h-8 flex-1 items-center gap-2 rounded-md border border-input bg-background px-2.5 text-sm text-muted-foreground"><tf-icon name="search" class="size-4"></tf-icon><input class="w-full bg-transparent text-foreground outline-none placeholder:text-muted-foreground" placeholder="Find a page or route" aria-label="Find a page"></label><button class="inline-flex size-8 items-center justify-center rounded-md border border-border hover:bg-accent" aria-label="New group" title="New group"><tf-icon name="folder-plus" class="size-4"></tf-icon></button></div>
    <div class="flex gap-1 text-xs"><button class="rounded-full bg-primary px-2.5 py-1 font-medium text-primary-foreground">All 92</button><button class="rounded-full border border-border px-2.5 py-1 hover:bg-accent">With comments 4</button><button class="rounded-full border border-border px-2.5 py-1 hover:bg-accent">Being edited 1</button></div>
    <div class="space-y-0.5 text-sm">
      ${grp('Marketing', 4)}
      ${grp('Auth &amp; onboarding', 15)}
      ${grp('Board', 8, true, `<ul class="ml-4 mt-0.5 space-y-0.5 border-l border-border pl-1.5">
        ${row('Board', '/board', '<span class="inline-flex items-center gap-1 text-xs"><span class="size-1.5 rounded-full bg-running motion-safe:animate-pulse"></span><tf-avatar model="claude" name="Claude (main)" size="xs"></tf-avatar></span><span class="rounded-full bg-primary/15 px-1.5 text-xs tabular-nums text-foreground">3</span>', true)}
        ${row('Board filters', '/board-filters')}
        ${row('Board list', '/board-list', '<span class="rounded-full bg-muted px-1.5 text-xs tabular-nums">1</span>')}
        ${row('Task', '/task')}
        ${row('Board, empty', '/board--empty', '<span class="text-xs">state</span>')}
      </ul>`)}
      ${grp('Agents &amp; chat', 12)}
      ${grp('Insights', 12)}
      ${grp('Workspace', 11)}
    </div>
    <div class="flex items-center justify-between border-t border-border pt-3 text-xs text-muted-foreground"><span>Drag to reorder or move between groups.</span><button class="inline-flex items-center gap-1 hover:text-foreground"><tf-icon name="trash" class="size-3.5"></tf-icon>Trash 2</button></div>`;
  },

  tokens: () => {
    const t = (name, l, d, changed) => `<li class="flex items-center gap-2 rounded-md px-1.5 py-1 ${changed ? 'bg-blocked/10' : 'hover:bg-muted'}"><span class="flex shrink-0 overflow-hidden rounded border border-border"><span class="size-5 ${l}"></span><span class="size-5 dark ${d}"></span></span><span class="min-w-0 flex-1 truncate font-mono text-xs">${name}</span>${changed ? '<span class="text-xs text-blocked">changed</span>' : ''}<button class="rounded p-1 text-muted-foreground hover:bg-accent" aria-label="Edit ${name}"><tf-icon name="pencil" class="size-3"></tf-icon></button></li>`;
    return `
    <div class="flex flex-wrap items-center gap-1 text-xs"><span class="text-muted-foreground">Themes</span><button class="rounded-full bg-primary px-2.5 py-1 font-medium text-primary-foreground">Light</button><button class="rounded-full border border-border px-2.5 py-1 hover:bg-accent">Dark</button><button class="rounded-full border border-dashed border-border px-2 py-1 text-muted-foreground hover:bg-accent">Add theme</button></div>
    <label class="flex h-8 items-center gap-2 rounded-md border border-input bg-background px-2.5 text-sm text-muted-foreground"><tf-icon name="search" class="size-4"></tf-icon><input class="w-full bg-transparent text-foreground outline-none placeholder:text-muted-foreground" placeholder="Find a token" aria-label="Find a token"></label>
    <section><h3 class="flex items-center text-xs font-medium text-muted-foreground">Surfaces<span class="ml-auto font-normal">light / dark</span></h3><ul class="mt-1">${t('background', 'bg-background', 'bg-background')}${t('card', 'bg-card', 'bg-card')}${t('muted', 'bg-muted', 'bg-muted')}${t('border', 'bg-border', 'bg-border')}</ul></section>
    <section><h3 class="text-xs font-medium text-muted-foreground">Brand</h3><ul class="mt-1">${t('primary', 'bg-primary', 'bg-primary', true)}${t('ring', 'bg-ring', 'bg-ring')}${t('link', 'bg-link', 'bg-link')}</ul></section>
    <section><h3 class="text-xs font-medium text-muted-foreground">Status</h3><ul class="mt-1">${t('running', 'bg-running', 'bg-running')}${t('blocked', 'bg-blocked', 'bg-blocked')}${t('review', 'bg-review', 'bg-review')}${t('failed', 'bg-failed', 'bg-failed')}</ul></section>
    <section class="rounded-lg border border-border p-3 text-xs"><p class="font-medium">Type</p><p class="mt-1 text-muted-foreground">Geist and Geist Mono, radius 0.625rem</p><button class="mt-2 text-link hover:underline">Change fonts</button></section>
    <div class="sticky bottom-0 -mx-3 flex items-center gap-2 border-t border-border bg-background px-3 pt-3"><span class="text-xs text-muted-foreground">1 unsaved, previewed on the canvas</span><button class="ml-auto h-8 rounded-md px-2 text-sm text-muted-foreground hover:bg-accent">Discard</button><button class="h-8 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground">Save</button></div>`;
  },

  components: () => {
    const c = (name, n, attrs, by, open) => `<li class="rounded-lg border border-border ${open ? 'bg-card' : ''}"><button class="flex w-full items-center gap-2 p-2.5 text-left"><tf-icon name="${open ? 'chevron-down' : 'chevron-right'}" class="size-3.5 text-muted-foreground"></tf-icon><span class="min-w-0 flex-1 truncate font-mono text-sm">&lt;${name}&gt;</span><span class="text-xs tabular-nums text-muted-foreground">${n} pages</span></button>${open ? `<div class="space-y-2 border-t border-border p-2.5 text-xs"><p class="text-muted-foreground">${by}</p><div class="flex flex-wrap gap-1 font-mono">${attrs}</div><div class="flex gap-1.5"><button class="flex-1 rounded-md border border-border py-1.5 hover:bg-accent">Show on canvas</button><button class="flex-1 rounded-md border border-border py-1.5 hover:bg-accent">Ask an agent</button></div></div>` : ''}</li>`;
    return `
    <label class="flex h-8 items-center gap-2 rounded-md border border-input bg-background px-2.5 text-sm text-muted-foreground"><tf-icon name="search" class="size-4"></tf-icon><input class="w-full bg-transparent text-foreground outline-none placeholder:text-muted-foreground" placeholder="Find a component" aria-label="Find a component"></label>
    <p class="text-xs text-muted-foreground">Change a component once and every page that uses it updates. Most used first.</p>
    <ul class="space-y-1.5">
      ${c('tf-shell', 67, '<span class="rounded bg-muted px-1.5 py-0.5">active</span><span class="rounded bg-muted px-1.5 py-0.5">title</span><span class="rounded bg-muted px-1.5 py-0.5">flush</span><span class="rounded bg-muted px-1.5 py-0.5">back</span>', 'App frame: sidebar, top bar, Live now. Last changed by Claude (main), v8.', true)}
      ${c('tf-message', 11)}
      ${c('tf-agent-rail', 2)}
      ${c('tf-composer', 5)}
      ${c('tf-status', 12)}
      ${c('tf-avatar', 46)}
    </ul>
    <p class="text-xs text-muted-foreground">Built in: ui-accordion, ui-dialog, ui-sheet, ui-tabs.</p>`;
  },
};

class TfDesignSurface extends HTMLElement {
  connectedCallback() {
    if (this.hasAttribute('data-r')) return; this.setAttribute('data-r', '');
    const a = (k) => this.getAttribute(k);
    const tab = a('tab') || 'inspect';
    const popover = this.hasAttribute('commenting');
    this.className = 'flex min-h-0 flex-1 flex-col';
    const tabs = TFD_TABS.map(([id, label]) => {
      const on = id === tab;
      const n = id === 'comments' ? ' <span class="rounded-full bg-primary/15 px-1 tabular-nums text-foreground">3</span>' : '';
      return `<a href="/design${id === 'inspect' ? '' : '--' + id}" role="tab" aria-selected="${on}" class="shrink-0 whitespace-nowrap border-b-2 px-1.5 pb-2 [scroll-snap-align:start] ${on ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}">${label}${n}</a>`;
    }).join('');
    this.innerHTML = `
      ${tfdToolbar(a, popover)}
      <div class="relative flex min-h-0 flex-1">
        ${tfdChat()}
        ${tfdCanvas(popover)}
        <div role="complementary" class="absolute inset-y-0 right-0 z-30 hidden w-full max-w-sm flex-col border-l border-border bg-background shadow-lg xl:static xl:z-auto xl:flex xl:w-[21rem] xl:shrink-0 xl:shadow-none" aria-label="Side panel">
          <div class="flex shrink-0 gap-0.5 overflow-x-auto border-b border-border px-1.5 pt-2 text-xs [mask-image:linear-gradient(to_right,black_88%,transparent)] [scrollbar-width:none]" role="tablist" aria-label="Side panel">${tabs}</div>
          <div class="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">${(TFD_PANEL[tab] || TFD_PANEL.inspect)()}</div>
        </div>
      </div>`;
  }
}
customElements.define('tf-design-surface', TfDesignSurface);
