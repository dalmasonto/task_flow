// <tf-task-card id="1025" title="..." priority="low|normal|high|critical" assignee="claude:Claude (main)"
//   live="Writing /chat" lease="18m" decision="Palette A or B?" gate="codex review" evidence="3 screenshots"
//   repo="task_flow" comments="4" files="2" due="Nov 3" selected>   (only id and title are required)
const TF_PRI = {
  critical: '<tf-icon name="alert" class="size-3.5 text-destructive" label="Critical priority"></tf-icon>',
  high: '<span class="inline-flex h-3.5 items-end gap-px" role="img" aria-label="High priority"><span class="h-1.5 w-0.5 rounded-sm bg-foreground/70"></span><span class="h-2.5 w-0.5 rounded-sm bg-foreground/70"></span><span class="h-3.5 w-0.5 rounded-sm bg-foreground/70"></span></span>',
  normal: '<span class="inline-flex h-3.5 items-end gap-px" role="img" aria-label="Normal priority"><span class="h-1.5 w-0.5 rounded-sm bg-foreground/70"></span><span class="h-2.5 w-0.5 rounded-sm bg-foreground/70"></span><span class="h-3.5 w-0.5 rounded-sm bg-foreground/20"></span></span>',
  low: '<span class="inline-flex h-3.5 items-end gap-px" role="img" aria-label="Low priority"><span class="h-1.5 w-0.5 rounded-sm bg-foreground/70"></span><span class="h-2.5 w-0.5 rounded-sm bg-foreground/20"></span><span class="h-3.5 w-0.5 rounded-sm bg-foreground/20"></span></span>',
};
class TfTaskCard extends HTMLElement {
  connectedCallback() { if (!this.hasAttribute('data-r')) this.render(); }
  render() {
    this.setAttribute('data-r', '');
    const a = (k) => this.getAttribute(k);
    const [am, an] = (a('assignee') || '').split(':');
    const meta = [];
    if (a('repo')) meta.push('<span class="inline-flex items-center gap-1"><tf-icon name="git-branch" class="size-3"></tf-icon>' + a('repo') + '</span>');
    if (a('due')) meta.push('<span class="inline-flex items-center gap-1"><tf-icon name="calendar" class="size-3"></tf-icon>' + a('due') + '</span>');
    if (a('comments')) meta.push('<span class="inline-flex items-center gap-1"><tf-icon name="message-square" class="size-3"></tf-icon>' + a('comments') + '</span>');
    if (a('files')) meta.push('<span class="inline-flex items-center gap-1"><tf-icon name="paperclip" class="size-3"></tf-icon>' + a('files') + '</span>');
    this.className = 'block';
    this.innerHTML = `
    <a href="/task" class="group block rounded-lg border bg-card p-3 text-card-foreground shadow-xs transition-colors hover:border-ring focus-visible:outline-2 focus-visible:outline-ring ${this.hasAttribute('selected') ? 'border-ring ring-2 ring-ring/25' : 'border-border'}">
      <div class="flex items-center gap-2 text-xs text-muted-foreground">
        ${TF_PRI[a('priority') || 'normal'] || ''}
        <span class="font-medium tabular-nums">#${a('id')}</span>
        ${a('lease') ? '<span class="ml-auto inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 tabular-nums" title="Claim lease: expires unless the agent renews it"><tf-icon name="clock" class="size-3"></tf-icon>' + a('lease') + '</span>' : ''}
        ${am ? '<span class="' + (a('lease') ? '' : 'ml-auto') + '"><tf-avatar model="' + am + '" name="' + (an || '') + '" size="xs"></tf-avatar></span>' : '<span class="ml-auto inline-flex size-5 items-center justify-center rounded-full border border-dashed border-border" title="Unassigned"><tf-icon name="user" class="size-3"></tf-icon></span>'}
      </div>
      <p class="mt-1.5 text-sm font-medium leading-5">${a('title') || ''}</p>
      ${a('live') ? '<p class="mt-2 flex items-center gap-1.5 truncate rounded-md bg-running/8 px-2 py-1 font-mono text-xs text-running"><span class="size-1.5 shrink-0 rounded-full bg-running motion-safe:animate-pulse"></span><span class="truncate">' + a('live') + '</span></p>' : ''}
      ${a('decision') ? '<p class="mt-2 flex items-center gap-1.5 rounded-md bg-blocked/10 px-2 py-1 text-xs text-foreground"><tf-icon name="scale" class="size-3.5 shrink-0 text-blocked"></tf-icon><span class="truncate">Blocked on decision: ' + a('decision') + '</span></p>' : ''}
      ${a('gate') ? '<p class="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground"><tf-icon name="shield-check" class="size-3.5 text-review"></tf-icon><span class="truncate">Gate: ' + a('gate') + '</span></p>' : ''}
      ${a('evidence') ? '<p class="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"><tf-icon name="paperclip" class="size-3.5 text-done"></tf-icon><span class="truncate">Evidence: ' + a('evidence') + '</span></p>' : ''}
      ${meta.length ? '<div class="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">' + meta.join('') + '</div>' : ''}
    </a>`;
  }
}
customElements.define('tf-task-card', TfTaskCard);
