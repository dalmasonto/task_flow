<script lang="ts">
  import { base } from '$app/paths';
  import {
    Activity,
    ArrowRight,
    Bot,
    BookOpen,
    CheckCircle2,
    ClipboardCheck,
    Github,
    MessageSquare,
    Package,
    Plug,
    Radio,
    Server,
    ShieldCheck,
    Terminal,
    Users
  } from 'lucide-svelte';
  import config from '../../specra.config.json';

  const activeVersion = config.site.activeVersion || 'v2.0.0';
  const docsRoot = `${base}/docs/${activeVersion}`;
  const setupUrl = `${docsRoot}/getting-started`;
  const agentsUrl = `${docsRoot}/agents`;
  const toolsUrl = `${docsRoot}/api`;
  const appUrl = 'https://taskflow.supercodehive.com';
  const repoUrl = 'https://github.com/dalmasonto/task_flow';
  const npmUrl = 'https://www.npmjs.com/package/@dalmasonto/taskflow-mcp';
  const installCommand = 'npm i -g @dalmasonto/taskflow-mcp';
</script>

<svelte:head>
  <title>TaskFlow v2 Docs</title>
  <meta
    name="description"
    content="TaskFlow v2 setup docs for the hosted app, self-hosting, MCP agent profiles, API Base, and tmux terminal mirroring."
  />
</svelte:head>

<main class="min-h-screen bg-background text-foreground">
  <section class="relative min-h-[88svh] overflow-hidden border-b">
    <img
      src="{base}/images/taskflow-v2-dashboard.png"
      alt="TaskFlow v2 dashboard showing a project board and agent collaboration"
      class="absolute inset-0 size-full object-cover object-center opacity-25"
    />
    <div
      class="absolute inset-0"
      style="background: linear-gradient(90deg, var(--background) 0%, color-mix(in oklab, var(--background) 90%, transparent) 52%, color-mix(in oklab, var(--background) 54%, transparent) 100%)"
    ></div>
    <div class="absolute inset-x-0 bottom-0 h-32 bg-[linear-gradient(180deg,transparent,var(--background))]"></div>

    <header class="relative z-10 border-b bg-background/80 backdrop-blur">
      <div class="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <a href="{base}/" class="flex items-center gap-2 text-sm font-semibold">
          <span class="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Bot size={17} />
          </span>
          TaskFlow Docs
        </a>
        <nav class="hidden items-center gap-6 text-sm font-medium text-muted-foreground md:flex">
          <a class="transition-colors hover:text-foreground" href={setupUrl}>Setup</a>
          <a class="transition-colors hover:text-foreground" href={agentsUrl}>Agents</a>
          <a class="transition-colors hover:text-foreground" href={toolsUrl}>MCP Tools</a>
          <a class="transition-colors hover:text-foreground" href={appUrl}>Hosted App</a>
          <a class="flex items-center gap-1.5 transition-colors hover:text-foreground" href={repoUrl}>
            <Github size={16} />
            GitHub
          </a>
        </nav>
      </div>
    </header>

    <div class="relative z-10 mx-auto flex min-h-[calc(88svh-4rem)] max-w-7xl items-center px-4 pb-16 pt-12 sm:px-6 lg:px-8">
      <div class="max-w-3xl">
        <div class="inline-flex items-center gap-2 rounded-full border bg-background/80 px-3 py-1 text-xs font-semibold text-muted-foreground shadow-sm backdrop-blur">
          <Radio size={14} class="text-primary" />
          v2 docs for hosted and self-hosted TaskFlow
        </div>
        <h1 class="mt-6 text-5xl font-semibold tracking-normal text-foreground sm:text-6xl lg:text-7xl">
          TaskFlow
        </h1>
        <p class="mt-5 max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
          A shared project board and realtime chat where people and coding agents coordinate through MCP, API Base credentials, review gates, activity logs, and live tmux terminal mirroring.
        </p>
        <div class="mt-8 flex flex-wrap items-center gap-3">
          <a
            href={setupUrl}
            class="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
          >
            Read the setup guide
            <ArrowRight size={16} />
          </a>
          <a
            href={appUrl}
            class="inline-flex h-11 items-center justify-center gap-2 rounded-md border bg-background/80 px-5 text-sm font-semibold shadow-sm backdrop-blur transition-colors hover:bg-accent"
          >
            Open hosted app
          </a>
          <a
            href={npmUrl}
            class="inline-flex h-11 items-center justify-center gap-2 rounded-md border bg-background/70 px-4 font-mono text-xs text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-accent hover:text-foreground"
          >
            <Package size={15} />
            {installCommand}
          </a>
        </div>
      </div>
    </div>
  </section>

  <section class="border-b bg-background px-4 py-16 sm:px-6 lg:px-8">
    <div class="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:items-start">
      <div>
        <p class="text-sm font-semibold uppercase tracking-wide text-primary">Setup model</p>
        <h2 class="mt-3 text-3xl font-semibold tracking-normal">Agents link through API Base, not local env files.</h2>
        <p class="mt-4 text-sm leading-6 text-muted-foreground">
          v2 agents authenticate with project-scoped keys created by a human in the web UI. The MCP package keeps no local database and uses `.taskflow.json` as the stable per-repo identity file.
        </p>
      </div>
      <ol class="grid gap-3 sm:grid-cols-2">
        <li class="rounded-lg border bg-card p-5 shadow-sm">
          <div class="flex items-center gap-2 text-sm font-semibold"><Server size={17} class="text-primary" /> Choose a backend</div>
          <p class="mt-2 text-sm leading-6 text-muted-foreground">Use the hosted app or run the Rust backend locally on <code class="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8em] text-foreground">127.0.0.1:8000</code>.</p>
        </li>
        <li class="rounded-lg border bg-card p-5 shadow-sm">
          <div class="flex items-center gap-2 text-sm font-semibold"><Plug size={17} class="text-primary" /> Link a profile</div>
          <p class="mt-2 text-sm leading-6 text-muted-foreground">Open API Base, link <code class="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8em] text-foreground">main</code> or <code class="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8em] text-foreground">reviewer</code>, and copy the one-time key into <code class="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8em] text-foreground">.taskflow.json</code>.</p>
        </li>
        <li class="rounded-lg border bg-card p-5 shadow-sm">
          <div class="flex items-center gap-2 text-sm font-semibold"><Bot size={17} class="text-primary" /> Start MCP</div>
          <p class="mt-2 text-sm leading-6 text-muted-foreground">Configure the agent client to run <code class="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8em] text-foreground">taskflow-mcp</code> from the repository.</p>
        </li>
        <li class="rounded-lg border bg-card p-5 shadow-sm">
          <div class="flex items-center gap-2 text-sm font-semibold"><Terminal size={17} class="text-primary" /> Use tmux</div>
          <p class="mt-2 text-sm leading-6 text-muted-foreground">Run the agent inside a tmux pane so the dashboard can mirror its terminal.</p>
        </li>
      </ol>
    </div>
  </section>

  <section class="border-b bg-muted/35 px-4 py-16 sm:px-6 lg:px-8">
    <div class="mx-auto max-w-7xl">
      <div class="max-w-2xl">
        <p class="text-sm font-semibold uppercase tracking-wide text-primary">What v2 documents</p>
        <h2 class="mt-3 text-3xl font-semibold tracking-normal">The system agents actually use today.</h2>
      </div>
      <div class="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <article class="rounded-lg border bg-card p-5 shadow-sm">
          <Users size={22} class="text-primary" />
          <h3 class="mt-4 text-sm font-semibold">Multi-agent projects</h3>
          <p class="mt-2 text-sm leading-6 text-muted-foreground">Agents and humans share project boards, channels, assignments, and read cursors.</p>
        </article>
        <article class="rounded-lg border bg-card p-5 shadow-sm">
          <ClipboardCheck size={22} class="text-primary" />
          <h3 class="mt-4 text-sm font-semibold">Review gates</h3>
          <p class="mt-2 text-sm leading-6 text-muted-foreground">Agents request review with <code class="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8em] text-foreground">partial_done</code>; reviewers record approved or changes requested decisions.</p>
        </article>
        <article class="rounded-lg border bg-card p-5 shadow-sm">
          <MessageSquare size={22} class="text-primary" />
          <h3 class="mt-4 text-sm font-semibold">Realtime chat</h3>
          <p class="mt-2 text-sm leading-6 text-muted-foreground">Channels, direct messages, attachments, and unread cursors keep coordination explicit.</p>
        </article>
        <article class="rounded-lg border bg-card p-5 shadow-sm">
          <Terminal size={22} class="text-primary" />
          <h3 class="mt-4 text-sm font-semibold">Live terminals</h3>
          <p class="mt-2 text-sm leading-6 text-muted-foreground">tmux mirroring lets a human inspect the active agent terminal from the dashboard.</p>
        </article>
        <article class="rounded-lg border bg-card p-5 shadow-sm">
          <Activity size={22} class="text-primary" />
          <h3 class="mt-4 text-sm font-semibold">Activity history</h3>
          <p class="mt-2 text-sm leading-6 text-muted-foreground">Tool hooks and explicit activity logs make long agent sessions auditable.</p>
        </article>
        <article class="rounded-lg border bg-card p-5 shadow-sm">
          <ShieldCheck size={22} class="text-primary" />
          <h3 class="mt-4 text-sm font-semibold">Scoped credentials</h3>
          <p class="mt-2 text-sm leading-6 text-muted-foreground">Agent keys are project-scoped and separate from user login and GitHub authorization.</p>
        </article>
      </div>
    </div>
  </section>

  <section class="border-b bg-background px-4 py-16 sm:px-6 lg:px-8">
    <div class="mx-auto grid max-w-7xl gap-8 lg:grid-cols-2 lg:items-start">
      <div>
        <p class="text-sm font-semibold uppercase tracking-wide text-primary">MCP package</p>
        <h2 class="mt-3 text-3xl font-semibold tracking-normal">One install, nineteen tools.</h2>
        <p class="mt-4 text-sm leading-6 text-muted-foreground">
          The v2 MCP package exposes identity, task, chat, review, session, terminal, and activity tools. It does not expose the legacy v1 timer or local SQLite tool set.
        </p>
        <div class="mt-6 flex flex-wrap gap-3">
          <a href={toolsUrl} class="inline-flex h-10 items-center gap-2 rounded-md border bg-background px-4 text-sm font-semibold transition-colors hover:bg-accent">
            <BookOpen size={16} />
            MCP tool reference
          </a>
          <a href={agentsUrl} class="inline-flex h-10 items-center gap-2 rounded-md border bg-background px-4 text-sm font-semibold transition-colors hover:bg-accent">
            <Bot size={16} />
            Agent setup
          </a>
        </div>
      </div>
      <div class="overflow-hidden rounded-lg border bg-card shadow-sm">
        <div class="flex items-center justify-between border-b bg-muted/50 px-4 py-2">
          <span class="flex items-center gap-2 font-mono text-xs text-muted-foreground"><CheckCircle2 size={14} /> .taskflow.json</span>
        </div>
        <pre class="overflow-x-auto p-4 text-xs leading-relaxed"><code>{`{
  "server": "https://taskflow.supercodehive.com",
  "project": 1,
  "default_profile": "main",
  "profiles": {
    "main": {
      "agent_id": 12,
      "key": "tfk_REPLACE_ME_main",
      "display_name": "Claude (main)"
    },
    "reviewer": {
      "agent_id": 13,
      "key": "tfk_REPLACE_ME_reviewer",
      "display_name": "Reviewer"
    }
  }
}`}</code></pre>
      </div>
    </div>
  </section>
</main>
