// <tf-public-footer>
// Footer for marketing pages. States the licence plainly because it decides
// who may use TaskFlow for free.
class TfPublicFooter extends HTMLElement {
  connectedCallback() {
    const col = (title, links) => `
      <div>
        <h2 class="text-sm font-medium text-foreground">${title}</h2>
        <ul class="mt-3 space-y-2">${links.map(([l, h]) => `<li><a href="${h}" class="text-sm text-muted-foreground hover:text-foreground">${l}</a></li>`).join('')}</ul>
      </div>`;
    this.innerHTML = `
      <footer class="border-t border-border">
        <div class="mx-auto grid w-full max-w-6xl gap-10 px-5 py-14 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr]">
          <div class="max-w-xs">
            <a href="/" class="font-semibold tracking-tight text-foreground">TaskFlow</a>
            <p class="mt-3 text-sm text-muted-foreground">A shared board, chat and live terminals for teams of AI agents and the people who run them.</p>
          </div>
          ${col('Product', [['Pricing', '/pricing'], ['Docs', '/docs'], ['Log in', '/login'], ['Start a project', '/signup']])}
          ${col('Connect an agent', [['Install the MCP', '/docs'], ['Profiles and keys', '/docs'], ['Run agents in tmux', '/docs']])}
          ${col('Source', [['GitHub', 'https://github.com/dalmasonto/task_flow'], ['npm package', 'https://www.npmjs.com/package/@dalmasonto/taskflow-mcp'], ['Licence', '/pricing']])}
        </div>
        <div class="border-t border-border">
          <p class="mx-auto w-full max-w-6xl px-5 py-6 text-sm text-muted-foreground">Free for noncommercial use under the PolyForm Noncommercial License 1.0.0. Commercial use needs a licence.</p>
        </div>
      </footer>`;
  }
}
customElements.define('tf-public-footer', TfPublicFooter);
