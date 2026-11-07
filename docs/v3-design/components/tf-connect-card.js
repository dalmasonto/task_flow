// <tf-connect-card model="claude" name="Claude (main)" profile="main" cli="claude"
//                  state="waiting|connected|error" seen="4 seconds ago">
// How to start one agent so TaskFlow sees it, and whether it has called whoami yet.
class TfConnectCard extends HTMLElement {
  static get observedAttributes() { return ['state']; }
  connectedCallback() { this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  render() {
    const model = this.getAttribute('model') || 'claude';
    const name = this.getAttribute('name') || 'Agent';
    const profile = this.getAttribute('profile') || 'main';
    const cli = this.getAttribute('cli') || 'claude';
    const state = this.getAttribute('state') || 'waiting';
    const seen = this.getAttribute('seen') || 'just now';
    const env = profile === 'main' ? '' : `TASKFLOW_PROFILE=${profile} `;
    const status = {
      waiting: `<div class="flex items-start gap-3 rounded-lg bg-muted px-3 py-2.5" role="status">
          <span class="relative mt-1.5 flex size-2 shrink-0"><span class="absolute inset-0 rounded-full bg-idle motion-safe:animate-ping"></span><span class="relative size-2 rounded-full bg-idle"></span></span>
          <p class="text-sm text-foreground">Waiting for ${name} to connect. This updates by itself once the agent calls <code class="font-mono text-xs">whoami</code>.</p></div>`,
      connected: `<div class="flex items-start gap-3 rounded-lg bg-running/10 px-3 py-2.5" role="status">
          <tf-icon name="circle-check" class="mt-0.5 size-4 shrink-0 text-running"></tf-icon>
          <p class="text-sm text-foreground"><span class="font-medium">Connected.</span> ${name} answered <code class="font-mono text-xs">whoami</code> ${seen}, with its terminal mirrored.</p></div>`,
      error: `<div class="flex items-start gap-3 rounded-lg bg-destructive/10 px-3 py-2.5" role="alert">
          <tf-icon name="circle-alert" class="mt-0.5 size-4 shrink-0 text-destructive"></tf-icon>
          <div class="text-sm text-foreground"><p><span class="font-medium">The key was rejected.</span> The <code class="font-mono text-xs">${profile}</code> entry in <code class="font-mono text-xs">.taskflow.json</code> doesn't match this project's key for ${name}.</p>
          <p class="mt-1 text-muted-foreground">Copy the file again from step 2, or make a new key below. The old key stops working when you do.</p>
          <button type="button" class="mt-2 inline-flex h-8 items-center rounded-md border border-border bg-background px-3 text-xs font-medium hover:bg-accent">Make a new key</button></div></div>`,
    }[state];
    this.innerHTML = `
      <div class="flex h-full min-w-0 flex-col rounded-xl border ${state === 'error' ? 'border-destructive/50' : 'border-border'} bg-card p-5">
        <div class="flex items-center gap-3">
          <tf-avatar model="${model}" name="${name}" status="${state === 'connected' ? 'running' : state === 'error' ? 'failed' : 'offline'}" size="lg"></tf-avatar>
          <div class="min-w-0"><p class="truncate font-medium text-card-foreground">${name}</p><p class="text-xs text-muted-foreground">Profile <code class="font-mono">${profile}</code></p></div>
        </div>
        <p class="mt-4 text-sm text-muted-foreground">Start it inside tmux so its terminal streams to TaskFlow:</p>
        <pre class="mt-2 overflow-x-auto rounded-lg bg-terminal p-3 font-mono text-xs leading-6 text-terminal-foreground">tmux new -s taskflow-${profile}
${env}${cli}</pre>
        <div class="mt-4 flex-1"></div>
        ${status}
      </div>`;
  }
}
customElements.define('tf-connect-card', TfConnectCard);
