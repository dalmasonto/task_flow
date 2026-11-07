// <tf-terminal model="claude" name="Claude (main)" pane="%4" project="taskflow_v2"
//   preset="design|backend|review|handshake-a|handshake-b|idle" static compact delay="0">   (all optional)
// The live terminal mirror of an agent. Lines type in once, then a cursor blinks.
// static: show every line immediately (also forced by prefers-reduced-motion).
// {project} in a line is replaced by the project attribute. Non-ASCII glyphs are HTML entities on purpose.
const TF_TERM = {
  design: [
    ['cmd', 'design_read_layout'],
    ['dim', '&#x25CF; 8 groups: Marketing, Auth &amp; onboarding, App shell, Board, Agents &amp; chat, Insights, Account, System'],
    ['cmd', 'design_write_component tf-composer'],
    ['ok', '&#x2713; tf-composer v1 registered, mentions + dictation'],
    ['cmd', 'design_screenshot /chat --theme both --viewport iphone-16-pro'],
    ['ok', '&#x2713; 2 renders, no font or image warnings'],
    ['cmd', 'send_message #design-room @reviewer (codex)'],
    ['dim', '&#x2192; delivered to reviewer (codex), pane %7'],
    ['in', 'reviewer (codex): Mention chips read well. The @here chip needs more contrast in dark.'],
  ],
  backend: [
    ['sh', 'cargo test --workspace -p taskflow-agents'],
    ['dim', '   Compiling taskflow-agents v0.4.2'],
    ['dim', 'running 218 tests'],
    ['ok', 'test posting::dm_pair_is_reused ... ok'],
    ['ok', 'test posting::cross_project_dm_rejected ... ok'],
    ['ok', 'test capabilities::dm_gate_denies_when_off ... ok'],
    ['ok', 'test result: ok. 218 passed; 0 failed'],
    ['cmd', 'update_task_status #721 partial_done'],
    ['cmd', 'send_message @Claude (main) "DM pairing is in, migration 0042 needs your review"'],
  ],
  review: [
    ['cmd', 'list_tasks status=partial_done'],
    ['dim', '&#x25CF; #721 Agents can DM any user or agent, by DeepSeek (api)'],
    ['sh', 'git diff main...deepseek/dm-pairs --stat'],
    ['dim', ' 6 files changed, 412 insertions(+), 37 deletions(-)'],
    ['warn', '! posting.rs:88 the pair lookup is not unique per project'],
    ['cmd', 'report_review #721 changes_requested'],
  ],
  'handshake-a': [
    ['cmd', 'whoami'],
    ['ok', '&#x2713; Claude (main), project {project}, connected'],
    ['cmd', 'list_agents'],
    ['dim', '&#x25CF; reviewer (codex), online, joined 4s ago'],
    ['cmd', 'send_message #project-room "@reviewer (codex) hi, I am on the board. Want the design review?"'],
    ['in', 'reviewer (codex): Yes. Send me the first route when it lands.'],
  ],
  'handshake-b': [
    ['cmd', 'whoami'],
    ['ok', '&#x2713; reviewer (codex), project {project}, connected'],
    ['in', 'Claude (main): hi, I am on the board. Want the design review?'],
    ['cmd', 'send_message #project-room reply_to=4618'],
    ['ok', '&#x2713; replied in #project-room'],
  ],
  idle: [
    ['dim', 'Waiting for messages. Mention @this agent or assign it a task.'],
  ],
};
const TF_LINE = {
  cmd: (t) => '<span class="text-ring">&#x25B8; </span><span class="text-terminal-foreground">' + t + '</span>',
  sh: (t) => '<span class="text-running">$ </span><span class="text-terminal-foreground">' + t + '</span>',
  ok: (t) => '<span class="text-running">' + t + '</span>',
  warn: (t) => '<span class="text-blocked">' + t + '</span>',
  dim: (t) => '<span class="text-terminal-foreground/55">' + t + '</span>',
  in: (t) => '<span class="rounded bg-terminal-foreground/10 px-1 text-terminal-foreground">&#x21A9; ' + t + '</span>',
};
class TfTerminal extends HTMLElement {
  connectedCallback() { if (!this.hasAttribute('data-r')) { this.setAttribute('data-r', ''); this.render(); } }
  disconnectedCallback() { clearTimeout(this._t); }
  render() {
    const model = this.getAttribute('model') || 'claude';
    const name = this.getAttribute('name') || 'Claude (main)';
    const pane = this.getAttribute('pane') || '%4';
    const project = this.getAttribute('project') || 'taskflow_v2';
    const lines = (TF_TERM[this.getAttribute('preset') || 'design'] || TF_TERM.design).map((l) => [l[0], l[1].split('{project}').join(project)]);
    const compact = this.hasAttribute('compact');
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches || this.hasAttribute('static');
    this.className = 'block h-full min-h-0';
    this.innerHTML = `
    <div class="flex h-full flex-col overflow-hidden rounded-xl border border-border bg-terminal text-terminal-foreground shadow-lg">
      <div class="flex h-10 shrink-0 items-center gap-2 border-b border-terminal-foreground/10 px-3">
        <tf-avatar model="${model}" name="${name}" size="xs"></tf-avatar>
        <span class="truncate text-xs font-medium">${name}</span>
        <span class="hidden truncate font-mono text-xs text-terminal-foreground/50 sm:inline">tmux ${pane}</span>
        <span class="ml-auto inline-flex items-center gap-1.5 rounded-full bg-running/15 px-2 py-0.5 text-xs font-medium text-running"><span class="size-1.5 rounded-full bg-running motion-safe:animate-pulse"></span>Live</span>
        ${compact ? '' : '<button class="rounded p-1 text-terminal-foreground/60 hover:bg-terminal-foreground/10 hover:text-terminal-foreground" aria-label="Open full terminal"><tf-icon name="maximize" class="size-3.5"></tf-icon></button>'}
      </div>
      <div data-t="body" class="min-h-0 flex-1 space-y-1 overflow-hidden p-3 font-mono text-xs leading-5 ${compact ? '' : 'sm:text-[0.8125rem]'}" aria-live="off" aria-label="Live terminal of ${name}"></div>
    </div>`;
    const body = this.querySelector('[data-t="body"]');
    const cursor = '<span class="inline-block h-4 w-2 translate-y-0.5 bg-terminal-foreground/70 motion-safe:animate-pulse"></span>';
    const add = (l) => { const d = document.createElement('div'); d.className = 'break-words'; d.innerHTML = TF_LINE[l[0]](l[1]); body.appendChild(d); };
    if (reduce) { lines.forEach(add); body.insertAdjacentHTML('beforeend', '<div>' + cursor + '</div>'); return; }
    let i = 0;
    const step = () => {
      if (i < lines.length) { add(lines[i++]); body.scrollTop = body.scrollHeight; this._t = setTimeout(step, lines[i - 1][0] === 'cmd' || lines[i - 1][0] === 'sh' ? 650 : 380); }
      else body.insertAdjacentHTML('beforeend', '<div>' + cursor + '</div>');
    };
    this._t = setTimeout(step, +(this.getAttribute('delay') || 200));
  }
}
customElements.define('tf-terminal', TfTerminal);
