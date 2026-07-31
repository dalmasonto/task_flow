<script lang="ts">
  import { base } from '$app/paths';
  let { data } = $props();
  const config = data.config;
  const activeVersion = config.site.activeVersion || 'v1.0.0';
  const docsUrl = `${base}/docs/${activeVersion}/getting-started`;
  const agentsUrl = `${base}/docs/${activeVersion}/agents`;
</script>

<svelte:head>
  <title>TaskFlow - Task Tracking for AI-Powered Development</title>
  <meta name="description" content="Local-first task and time tracking with 50 MCP tools. Your AI agent creates tasks, tracks time, manages dependencies, and logs progress while you code. Open source, runs on your machine." />
</svelte:head>

<div class="taskflow-landing" style="font-family: 'Geist', sans-serif; background-color: #030303; color: #ededed; overflow-x: hidden;">

  <!-- Navigation -->
  <nav class="fixed top-0 w-full z-50 bg-[#030303]/80 backdrop-blur-md border-b border-[#171717]">
    <div class="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
      <div class="font-medium tracking-tighter text-lg flex items-center gap-2">
        <div class="w-4 h-4 rounded-sm bg-[#69fd5d] flex items-center justify-center" style="box-shadow: 0 0 40px -10px rgba(105, 253, 93, 0.15);">
          <div class="w-1.5 h-1.5 bg-[#030303]"></div>
        </div>
        TASKFLOW
      </div>
      <div class="flex items-center gap-6 text-sm text-neutral-400">
        <a href="#features" class="hover:text-white transition-colors hidden md:block">Features</a>
        <a href="#setup" class="hover:text-white transition-colors hidden md:block">Setup</a>
        <a href="#remote" class="hover:text-white transition-colors hidden md:block">Remote</a>
        <a href={docsUrl} class="hover:text-white transition-colors hidden md:block">Docs</a>
        <a href="https://github.com/dalmasonto/task_flow" target="_blank" class="flex items-center gap-1.5 hover:text-white transition-colors">
          <iconify-icon icon="solar:github-linear" class="text-base"></iconify-icon>
          GitHub
        </a>
      </div>
    </div>
  </nav>

  <!-- Hero Section -->
  <section class="relative pt-32 pb-20 overflow-hidden">
    <div class="absolute inset-0 opacity-40 pointer-events-none" style="background-size: 40px 40px; background-image: linear-gradient(to right, rgba(255, 255, 255, 0.03) 1px, transparent 1px), linear-gradient(to bottom, rgba(255, 255, 255, 0.03) 1px, transparent 1px); mask-image: radial-gradient(ellipse at center, black 20%, transparent 80%); -webkit-mask-image: radial-gradient(ellipse at center, black 20%, transparent 80%);"></div>
    <div class="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-[#69fd5d] rounded-full blur-[120px] opacity-[0.05] pointer-events-none"></div>

    <div class="max-w-6xl mx-auto px-6 relative z-10 flex flex-col items-center text-center">
      <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-neutral-800 bg-neutral-900/50 text-xs text-neutral-300 mb-8 animate-slide-up">
        <span class="w-1.5 h-1.5 rounded-full bg-[#69fd5d] animate-pulse-dot"></span>
        Currently available for Linux
        <div class="flex items-center gap-1 ml-2 text-neutral-500 border-l border-neutral-700 pl-2">
          <iconify-icon icon="solar:box-linear"></iconify-icon>
          <iconify-icon icon="solar:monitor-linear"></iconify-icon>
        </div>
      </div>

      <h1 class="text-5xl md:text-7xl font-medium tracking-tighter text-white max-w-4xl mb-6 animate-slide-up" style="text-shadow: 0 0 30px rgba(105, 253, 93, 0.4); animation-delay: 0.1s; opacity: 0;">
        Your AI Agent's
        <br class="hidden md:block" />
        Task Manager
      </h1>

      <p class="text-base md:text-lg text-neutral-400 max-w-2xl mb-10 animate-slide-up" style="animation-delay: 0.2s; opacity: 0;">
        Local-first task tracking with MCP integration. Your AI agent creates tasks, tracks time, and manages your projects while you focus on code.
      </p>

      <div class="flex flex-col sm:flex-row items-center gap-4 w-full sm:w-auto animate-slide-up" style="animation-delay: 0.3s; opacity: 0;">
        <a href="#setup" class="w-full sm:w-auto px-6 py-2.5 rounded-lg bg-[#69fd5d]/10 text-[#69fd5d] border border-[#69fd5d]/30 hover:bg-[#69fd5d]/20 transition-all flex items-center justify-center gap-2 text-sm font-medium no-underline" style="box-shadow: 0 0 40px -10px rgba(105, 253, 93, 0.15);">
          <iconify-icon icon="solar:download-minimalistic-linear" class="text-lg"></iconify-icon>
          Download for Linux
        </a>
        <div class="w-full sm:w-auto px-4 py-2.5 rounded-lg bg-neutral-900/50 border border-neutral-800 hover:border-neutral-700 transition-colors flex items-center justify-between gap-4 text-sm font-mono text-neutral-300 cursor-copy group">
          <span>npm i -g @dalmasonto/taskflow-mcp</span>
          <iconify-icon icon="solar:copy-linear" class="text-neutral-500 group-hover:text-white transition-colors"></iconify-icon>
        </div>
      </div>

      <!-- Hero Screenshot -->
      <div class="mt-20 w-full max-w-5xl rounded-xl border border-neutral-800 bg-[#0a0a0a] shadow-2xl overflow-hidden animate-slide-up relative" style="box-shadow: 0 0 40px -10px rgba(105, 253, 93, 0.15); animation-delay: 0.5s; opacity: 0;">
        <img src="{base}/images/dashboard.png" alt="TaskFlow Dashboard — Command Center showing tasks grouped by status with live timers" class="w-full h-auto" />
      </div>
    </div>
  </section>

  <!-- Problem -> Solution -->
  <section class="py-24 border-t border-[#171717] bg-[#050505] relative">
    <div class="max-w-6xl mx-auto px-6">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-12 md:gap-24">
        <div class="space-y-6">
          <div class="text-neutral-500 text-sm font-medium tracking-wide flex items-center gap-2">
            <iconify-icon icon="solar:close-circle-linear"></iconify-icon>
            THE PROBLEM
          </div>
          <h2 class="text-2xl font-medium tracking-tight text-white leading-snug">
            Using AI to code, but manually managing your board.
          </h2>
          <ul class="space-y-4 text-sm text-neutral-400 list-none p-0">
            <li class="flex items-start gap-3">
              <iconify-icon icon="solar:minus-circle-linear" class="text-neutral-600 mt-0.5"></iconify-icon>
              Your AI finishes a bug fix, but you still have to open Jira to update status.
            </li>
            <li class="flex items-start gap-3">
              <iconify-icon icon="solar:minus-circle-linear" class="text-neutral-600 mt-0.5"></iconify-icon>
              Context switching between terminal, editor, and browser kills flow state.
            </li>
            <li class="flex items-start gap-3">
              <iconify-icon icon="solar:minus-circle-linear" class="text-neutral-600 mt-0.5"></iconify-icon>
              Cloud-based trackers index all your private project details.
            </li>
          </ul>
        </div>
        <div class="space-y-6 relative">
          <div class="absolute -left-12 top-0 bottom-0 w-px bg-gradient-to-b from-transparent via-[#171717] to-transparent hidden md:block"></div>
          <div class="text-[#69fd5d] text-sm font-medium tracking-wide flex items-center gap-2">
            <iconify-icon icon="solar:check-circle-linear"></iconify-icon>
            THE SOLUTION
          </div>
          <h2 class="text-2xl font-medium tracking-tight text-white leading-snug" style="text-shadow: 0 0 30px rgba(105, 253, 93, 0.4);">
            Autonomous task management via MCP.
          </h2>
          <ul class="space-y-4 text-sm text-neutral-300 list-none p-0">
            <li class="flex items-start gap-3">
              <iconify-icon icon="solar:bolt-linear" class="text-[#69fd5d] mt-0.5"></iconify-icon>
              Provide 50 tools to Claude/Codex/Cursor. The agent fixes a bug, creates a task, and marks it done.
            </li>
            <li class="flex items-start gap-3">
              <iconify-icon icon="solar:bolt-linear" class="text-[#69fd5d] mt-0.5"></iconify-icon>
              Zero context switching. You watch the board update via real-time SSE while you review code.
            </li>
            <li class="flex items-start gap-3">
              <iconify-icon icon="solar:bolt-linear" class="text-[#69fd5d] mt-0.5"></iconify-icon>
              100% local SQLite database. Your data never leaves your machine.
            </li>
          </ul>
        </div>
      </div>
    </div>
  </section>

  <!-- Demo Video -->
  <section class="py-24 bg-black border-y border-[#171717]">
    <div class="max-w-4xl mx-auto px-6 text-center">
      <h2 class="text-3xl font-medium tracking-tight mb-4">See It Work</h2>
      <p class="text-sm text-neutral-400 mb-10 max-w-2xl mx-auto">
        A Claude Code agent builds a feature from scratch. It creates tasks, tracks time, logs what it finds, and marks things done. Nobody touched the board.
      </p>
      <div class="relative w-full aspect-video rounded-xl border border-neutral-800 bg-[#0a0a0a] overflow-hidden" style="box-shadow: 0 0 40px -10px rgba(105, 253, 93, 0.15);">
        <iframe
          src="https://www.youtube.com/embed/P4fOaxADNqM?rel=0&amp;modestbranding=1"
          title="TaskFlow MCP Demo"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowfullscreen
          class="absolute inset-0 w-full h-full border-0"
          loading="lazy"
        ></iframe>
      </div>
    </div>
  </section>

  <!-- Feature Showcase -->
  <section id="features" class="py-24 bg-[#030303]">
    <div class="max-w-6xl mx-auto px-6">
      <div class="text-center mb-16">
        <h2 class="text-3xl font-medium tracking-tight mb-4">What You Get</h2>
        <p class="text-sm text-neutral-400 max-w-xl mx-auto">
          Tools for managing real software projects, built to work with AI agents through the Model Context Protocol.
        </p>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <!-- Feature 1: MCP Server -->
        <div class="col-span-1 md:col-span-2 rounded-2xl border border-[#171717] bg-[#0a0a0a] p-6 flex flex-col overflow-hidden relative group hover:border-neutral-700 transition-colors">
          <div class="absolute top-0 right-0 w-64 h-64 bg-[#69fd5d] rounded-full blur-[100px] opacity-0 group-hover:opacity-10 transition-opacity"></div>
          <iconify-icon icon="solar:cpu-linear" class="text-2xl text-[#69fd5d] mb-4"></iconify-icon>
          <h3 class="text-lg font-medium tracking-tight mb-2">50 MCP Tools for AI Agents</h3>
          <p class="text-sm text-neutral-400 mb-6 max-w-md">
            One install command. Your AI gets tools for tasks, projects, timers, and analytics. It creates tasks, logs what it finds, and marks work done on its own.
          </p>
          <div class="mt-auto bg-[#030303] border border-neutral-800 rounded-lg p-4 font-mono text-xs text-neutral-300">
            <div class="flex items-center gap-2 mb-2 text-neutral-500">
              <iconify-icon icon="solar:terminal-linear"></iconify-icon>
              ~/.mcp.json
            </div>
            <span class="text-blue-400">"mcpServers"</span>: {'{'}<br />
            &nbsp;&nbsp;<span class="text-blue-400">"taskflow"</span>: {'{'}<br />
            &nbsp;&nbsp;&nbsp;&nbsp;<span class="text-blue-400">"command"</span>: <span class="text-green-400">"taskflow-mcp"</span>,<br />
            &nbsp;&nbsp;&nbsp;&nbsp;<span class="text-blue-400">"args"</span>: []<br />
            &nbsp;&nbsp;{'}'}<br />
            {'}'}
          </div>
        </div>

        <!-- Feature 2: Live Sync -->
        <div class="rounded-2xl border border-[#171717] bg-[#0a0a0a] p-6 flex flex-col overflow-hidden relative group hover:border-neutral-700 transition-colors">
          <iconify-icon icon="solar:refresh-circle-linear" class="text-2xl text-white mb-4"></iconify-icon>
          <h3 class="text-lg font-medium tracking-tight mb-2">Real-Time Live Sync</h3>
          <p class="text-sm text-neutral-400 mb-6">
            Agent writes to SQLite, SSE fires, Tauri app updates IndexedDB, UI re-renders. All instant.
          </p>
          <div class="mt-auto h-32 bg-[#030303] border border-neutral-800 rounded-lg p-3 relative flex items-center justify-center overflow-hidden">
            <div class="absolute left-4 w-12 h-12 rounded border border-neutral-800 bg-neutral-900 flex items-center justify-center font-mono text-xs text-neutral-500">AI</div>
            <div class="absolute left-16 right-16 h-px bg-gradient-to-r from-neutral-800 via-[#69fd5d] to-neutral-800">
              <div class="absolute top-1/2 -translate-y-1/2 left-1/2 w-2 h-2 rounded-full bg-[#69fd5d] shadow-[0_0_10px_#69fd5d] animate-ping"></div>
            </div>
            <div class="absolute right-4 w-12 h-12 rounded border border-[#69fd5d]/30 bg-[#69fd5d]/10 flex items-center justify-center text-[#69fd5d]">
              <iconify-icon icon="solar:monitor-linear"></iconify-icon>
            </div>
          </div>
        </div>

        <!-- Feature 3: Dependency Graph -->
        <div class="col-span-1 lg:col-span-3 rounded-2xl border border-[#171717] bg-[#0a0a0a] p-6 flex flex-col md:flex-row gap-8 overflow-hidden relative group hover:border-neutral-700 transition-colors">
          <div class="flex-1 flex flex-col justify-center">
            <iconify-icon icon="solar:share-circle-linear" class="text-2xl text-white mb-4"></iconify-icon>
            <h3 class="text-lg font-medium tracking-tight mb-2">Visual Task Dependencies</h3>
            <p class="text-sm text-neutral-400">
              Tasks have dependencies. Dependencies have a graph. Interactive DAG visualization with automatic cycle detection. Your AI agent can query the graph to understand blockers before starting work.
            </p>
          </div>
          <div class="flex-1 rounded-lg overflow-hidden border border-neutral-800">
            <img src="{base}/images/dependency-graph.png" alt="TaskFlow Dependency Graph" class="w-full h-full object-cover" />
          </div>
        </div>

        <!-- Feature 4: Timers -->
        <div class="rounded-2xl border border-[#171717] bg-[#0a0a0a] p-6 flex flex-col overflow-hidden relative group hover:border-neutral-700 transition-colors">
          <iconify-icon icon="solar:stopwatch-linear" class="text-2xl text-[#00fbfb] mb-4"></iconify-icon>
          <h3 class="text-lg font-medium tracking-tight mb-2">Concurrent Timers</h3>
          <p class="text-sm text-neutral-400 mb-6">Track time across multiple tasks. Every session is logged with precise timestamps.</p>
          <div class="mt-auto space-y-2">
            <div class="bg-[#030303] border border-neutral-800 rounded p-2 flex justify-between items-center">
              <div class="w-1/2 h-2 bg-neutral-800 rounded"></div>
              <span class="text-[10px] font-mono text-[#00fbfb]">01:12:45</span>
            </div>
            <div class="bg-[#030303] border border-neutral-800 rounded p-2 flex justify-between items-center opacity-50">
              <div class="w-2/3 h-2 bg-neutral-800 rounded"></div>
              <span class="text-[10px] font-mono text-neutral-500">PAUSED</span>
            </div>
          </div>
        </div>

        <!-- Feature 5: Activity Pulse -->
        <div class="rounded-2xl border border-[#171717] bg-[#0a0a0a] p-6 flex flex-col overflow-hidden relative group hover:border-neutral-700 transition-colors">
          <iconify-icon icon="solar:pulse-linear" class="text-2xl text-white mb-4"></iconify-icon>
          <h3 class="text-lg font-medium tracking-tight mb-2">Activity Pulse</h3>
          <p class="text-sm text-neutral-400 mb-6">AI agents use log_debug to leave notes as they work. Hypotheses, errors, what they tried, what they found.</p>
          <div class="mt-auto border-l-2 border-neutral-800 ml-2 pl-4 space-y-3">
            <div class="relative">
              <div class="absolute -left-[21px] top-1 w-2 h-2 rounded-full bg-yellow-500"></div>
              <div class="text-[10px] text-neutral-500">10:42 AM &bull; AI Agent</div>
              <div class="text-xs text-neutral-300">Logged debug: Found null pointer in parser.</div>
            </div>
            <div class="relative">
              <div class="absolute -left-[21px] top-1 w-2 h-2 rounded-full bg-[#69fd5d]"></div>
              <div class="text-[10px] text-neutral-500">10:45 AM &bull; AI Agent</div>
              <div class="text-xs text-neutral-300">Marked task as done.</div>
            </div>
          </div>
        </div>

        <!-- Feature 6: Terminal -->
        <div class="rounded-2xl border border-[#171717] bg-[#0a0a0a] p-6 flex flex-col overflow-hidden relative group hover:border-neutral-700 transition-colors">
          <iconify-icon icon="solar:command-linear" class="text-2xl text-white mb-4"></iconify-icon>
          <h3 class="text-lg font-medium tracking-tight mb-2">Built-in Terminal</h3>
          <p class="text-sm text-neutral-400 mb-6">Ctrl+K opens a full xterm.js terminal. Create tasks, navigate, and manage state without a mouse.</p>
          <div class="mt-auto bg-[#030303] border border-neutral-800 rounded-lg p-3 font-mono text-xs text-neutral-400">
            <span class="text-[#69fd5d]">taskflow&gt;</span> task create "Fix CORS"<br />
            <span class="text-neutral-500">Created task #42</span><br />
            <span class="text-[#69fd5d]">taskflow&gt;</span> timer start 42<span class="animate-pulse">_</span>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- App Screenshots Gallery -->
  <section class="py-24 border-t border-[#171717] bg-[#050505]">
    <div class="max-w-6xl mx-auto px-6">
      <div class="text-center mb-16">
        <h2 class="text-3xl font-medium tracking-tight mb-4">See It in Action</h2>
        <p class="text-sm text-neutral-400 max-w-xl mx-auto">Real screenshots from the TaskFlow desktop app.</p>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div class="rounded-xl border border-neutral-800 bg-[#0a0a0a] overflow-hidden group hover:border-neutral-700 transition-colors">
          <div class="px-4 py-3 border-b border-neutral-800 bg-[#050505] flex items-center justify-between">
            <span class="text-xs font-medium text-neutral-300 flex items-center gap-2">
              <iconify-icon icon="solar:chart-2-linear" class="text-[#00fbfb]"></iconify-icon>
              Analytics
            </span>
          </div>
          <img src="{base}/images/analytics.png" alt="TaskFlow Analytics" class="w-full h-auto" />
        </div>
        <div class="rounded-xl border border-neutral-800 bg-[#0a0a0a] overflow-hidden group hover:border-neutral-700 transition-colors">
          <div class="px-4 py-3 border-b border-neutral-800 bg-[#050505] flex items-center justify-between">
            <span class="text-xs font-medium text-neutral-300 flex items-center gap-2">
              <iconify-icon icon="solar:command-linear" class="text-[#69fd5d]"></iconify-icon>
              Terminal
            </span>
          </div>
          <img src="{base}/images/terminal.png" alt="TaskFlow Terminal" class="w-full h-auto" />
        </div>
        <div class="rounded-xl border border-neutral-800 bg-[#0a0a0a] overflow-hidden group hover:border-neutral-700 transition-colors">
          <div class="px-4 py-3 border-b border-neutral-800 bg-[#050505] flex items-center justify-between">
            <span class="text-xs font-medium text-neutral-300 flex items-center gap-2">
              <iconify-icon icon="solar:pulse-linear" class="text-yellow-400"></iconify-icon>
              Activity Pulse
            </span>
          </div>
          <img src="{base}/images/activity-pulse.png" alt="TaskFlow Activity Pulse" class="w-full h-auto" />
        </div>
        <div class="rounded-xl border border-neutral-800 bg-[#0a0a0a] overflow-hidden group hover:border-neutral-700 transition-colors">
          <div class="px-4 py-3 border-b border-neutral-800 bg-[#050505] flex items-center justify-between">
            <span class="text-xs font-medium text-neutral-300 flex items-center gap-2">
              <iconify-icon icon="solar:document-text-linear" class="text-white"></iconify-icon>
              Task Detail
            </span>
          </div>
          <img src="{base}/images/single_task.png" alt="TaskFlow Task Detail" class="w-full h-auto" />
        </div>
        <div class="rounded-xl border border-neutral-800 bg-[#0a0a0a] overflow-hidden group hover:border-neutral-700 transition-colors">
          <div class="px-4 py-3 border-b border-neutral-800 bg-[#050505] flex items-center justify-between">
            <span class="text-xs font-medium text-neutral-300 flex items-center gap-2">
              <iconify-icon icon="solar:stopwatch-linear" class="text-[#00fbfb]"></iconify-icon>
              Floating Timer Bar
            </span>
          </div>
          <div class="p-6 flex items-center justify-center bg-[#030303]">
            <img src="{base}/images/task-timer.png" alt="TaskFlow Floating Timer" class="w-full max-w-lg h-auto" />
          </div>
        </div>
        <div class="rounded-xl border border-neutral-800 bg-[#0a0a0a] overflow-hidden group hover:border-neutral-700 transition-colors">
          <div class="px-4 py-3 border-b border-neutral-800 bg-[#050505] flex items-center justify-between">
            <span class="text-xs font-medium text-neutral-300 flex items-center gap-2">
              <iconify-icon icon="solar:settings-linear" class="text-neutral-400"></iconify-icon>
              Settings
            </span>
          </div>
          <img src="{base}/images/settings.png" alt="TaskFlow Settings" class="w-full h-auto" />
        </div>
        <div class="md:col-span-2 rounded-xl border border-neutral-800 bg-[#0a0a0a] overflow-hidden group hover:border-neutral-700 transition-colors">
          <div class="px-4 py-3 border-b border-neutral-800 bg-[#050505] flex items-center justify-between">
            <span class="text-xs font-medium text-neutral-300 flex items-center gap-2">
              <iconify-icon icon="solar:archive-linear" class="text-[#69fd5d]"></iconify-icon>
              Completed Tasks
            </span>
          </div>
          <img src="{base}/images/archived.png" alt="TaskFlow Archive" class="w-full h-auto" />
        </div>
      </div>
    </div>
  </section>

  <!-- Setup Guide -->
  <section id="setup" class="py-24 border-t border-[#171717] bg-[#050505]">
    <div class="max-w-4xl mx-auto px-6">
      <h2 class="text-3xl font-medium tracking-tight mb-4 text-center text-white">Get Started in 4 Steps</h2>
      <p class="text-sm text-neutral-400 mb-12 text-center">
        Quick setup for Claude Code. <a href={agentsUrl} class="text-[#69fd5d] hover:underline">View setup guides for Codex, Cursor, Windsurf, and more →</a>
      </p>

      <div class="space-y-12">
        <!-- Step 1 -->
        <div class="flex gap-6">
          <div class="flex-shrink-0 w-8 h-8 rounded-full border border-neutral-700 bg-neutral-900 flex items-center justify-center text-sm font-mono text-[#69fd5d]">1</div>
          <div class="w-full">
            <h3 class="text-lg font-medium tracking-tight mb-2">Download TaskFlow Desktop</h3>
            <p class="text-sm text-neutral-400 mb-4">Choose your Linux distribution format (macOS/Windows planned):</p>
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <a href="https://tokenkit.s3.amazonaws.com/TaskFlow_1.0.0_amd64_6ff8a943c8a748ddbca99a5f0d6adb43.AppImage" download class="p-3 rounded-lg border border-neutral-800 bg-[#0a0a0a] hover:border-[#69fd5d]/40 hover:bg-[#69fd5d]/5 transition-colors text-left group no-underline">
                <iconify-icon icon="solar:box-minimalistic-linear" class="text-xl text-neutral-400 group-hover:text-[#69fd5d] mb-2"></iconify-icon>
                <div class="text-sm font-medium text-white">AppImage</div>
                <div class="text-[10px] text-neutral-500">Universal, run anywhere</div>
              </a>
              <a href="https://tokenkit.s3.amazonaws.com/TaskFlow_1.0.0_amd64_25121113c29d4ba8a2498b4ffca6bd69.deb" download class="p-3 rounded-lg border border-neutral-800 bg-[#0a0a0a] hover:border-[#69fd5d]/40 hover:bg-[#69fd5d]/5 transition-colors text-left group no-underline">
                <iconify-icon icon="solar:server-square-linear" class="text-xl text-neutral-400 group-hover:text-[#69fd5d] mb-2"></iconify-icon>
                <div class="text-sm font-medium text-white">.deb</div>
                <div class="text-[10px] text-neutral-500">Debian / Ubuntu</div>
              </a>
              <a href="https://tokenkit.s3.amazonaws.com/TaskFlow-1.0.0-1.x86_64_9348356077224db98ecb5a3b3b1418e6.rpm" download class="p-3 rounded-lg border border-neutral-800 bg-[#0a0a0a] hover:border-[#69fd5d]/40 hover:bg-[#69fd5d]/5 transition-colors text-left group no-underline">
                <iconify-icon icon="solar:server-square-update-linear" class="text-xl text-neutral-400 group-hover:text-[#69fd5d] mb-2"></iconify-icon>
                <div class="text-sm font-medium text-white">.rpm</div>
                <div class="text-[10px] text-neutral-500">Fedora / RHEL</div>
              </a>
            </div>
          </div>
        </div>

        <!-- Step 2 -->
        <div class="flex gap-6">
          <div class="flex-shrink-0 w-8 h-8 rounded-full border border-neutral-700 bg-neutral-900 flex items-center justify-center text-sm font-mono text-[#69fd5d]">2</div>
          <div class="w-full">
            <h3 class="text-lg font-medium tracking-tight mb-2">Install the MCP Globally</h3>
            <p class="text-sm text-neutral-400 mb-4">Make the TaskFlow MCP server available to your system via npm.</p>
            <div class="bg-[#0a0a0a] border border-neutral-800 rounded-lg overflow-hidden">
              <div class="px-4 py-2 border-b border-neutral-800 bg-[#050505] text-xs font-mono text-neutral-500 flex items-center gap-2">
                <iconify-icon icon="solar:terminal-linear"></iconify-icon>
                Terminal
              </div>
              <div class="p-4 text-xs font-mono text-neutral-300 overflow-x-auto">
                <span class="text-neutral-500"># Install the package globally</span><br />
                npm install -g @dalmasonto/taskflow-mcp
              </div>
            </div>
          </div>
        </div>

        <!-- Step 3 -->
        <div class="flex gap-6">
          <div class="flex-shrink-0 w-8 h-8 rounded-full border border-[#69fd5d]/50 bg-[#69fd5d]/10 flex items-center justify-center text-sm font-mono text-[#69fd5d]" style="box-shadow: 0 0 40px -10px rgba(105, 253, 93, 0.15);">3</div>
          <div class="w-full">
            <h3 class="text-lg font-medium tracking-tight mb-2">Configure Your Agent</h3>
            <p class="text-sm text-neutral-400 mb-4">
              Create a <code class="text-neutral-300 bg-neutral-800 px-1.5 py-0.5 rounded text-[11px] font-mono">.mcp.json</code> file in your project root (or home directory for global access). Claude Code will auto-detect it.
            </p>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div class="bg-[#0a0a0a] border border-neutral-800 rounded-lg overflow-hidden flex flex-col">
                <div class="px-4 py-2 border-b border-neutral-800 bg-[#050505] text-xs font-mono text-neutral-500 flex items-center gap-2">
                  <iconify-icon icon="solar:document-text-linear"></iconify-icon>
                  .mcp.json <span class="text-neutral-600">(project root or ~/.mcp.json)</span>
                </div>
                <div class="p-4 text-xs font-mono text-neutral-300 overflow-x-auto whitespace-nowrap">
                  {'{'}<br />
                  &nbsp;&nbsp;<span class="text-blue-400">"mcpServers"</span>: {'{'}<br />
                  &nbsp;&nbsp;&nbsp;&nbsp;<span class="text-blue-400">"taskflow"</span>: {'{'}<br />
                  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span class="text-blue-400">"command"</span>: <span class="text-green-400">"taskflow-mcp"</span>,<br />
                  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span class="text-blue-400">"args"</span>: []<br />
                  &nbsp;&nbsp;&nbsp;&nbsp;{'}'}<br />
                  &nbsp;&nbsp;{'}'}<br />
                  {'}'}
                </div>
              </div>
              <div class="bg-[#0a0a0a] border border-neutral-800 rounded-lg overflow-hidden flex flex-col">
                <div class="px-4 py-2 border-b border-neutral-800 bg-[#050505] text-xs font-mono text-neutral-500 flex items-center gap-2">
                  <iconify-icon icon="solar:settings-linear"></iconify-icon>
                  Grant permissions
                </div>
                <div class="p-4 text-xs font-mono text-neutral-300 overflow-x-auto whitespace-nowrap">
                  <span class="text-neutral-500">// ~/.claude/settings.json or</span><br />
                  <span class="text-neutral-500">// .claude/settings.local.json (per project)</span><br /><br />
                  {'{'}<br />
                  &nbsp;&nbsp;<span class="text-blue-400">"permissions"</span>: {'{'}<br />
                  &nbsp;&nbsp;&nbsp;&nbsp;<span class="text-blue-400">"allow"</span>: [<br />
                  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span class="text-green-400">"mcp__taskflow__*"</span><br />
                  &nbsp;&nbsp;&nbsp;&nbsp;]<br />
                  &nbsp;&nbsp;{'}'}<br />
                  {'}'}
                </div>
              </div>
            </div>
            <p class="text-xs text-neutral-500 mt-3">
              The agent calls <code class="text-neutral-400 bg-neutral-800 px-1 py-0.5 rounded text-[10px]">get_agent_instructions</code> on startup and learns how to use TaskFlow on its own.
              <a href={agentsUrl} class="text-[#69fd5d] hover:underline ml-1">Setup guides for Codex, Cursor, Windsurf &amp; more →</a>
            </p>
          </div>
        </div>

        <!-- Step 4 -->
        <div class="flex gap-6">
          <div class="flex-shrink-0 w-8 h-8 rounded-full border border-neutral-700 bg-neutral-900 flex items-center justify-center text-sm font-mono text-[#00fbfb]">4</div>
          <div class="w-full">
            <h3 class="text-lg font-medium tracking-tight mb-2">Enable Live Agent Chat with tmux</h3>
            <p class="text-sm text-neutral-400 mb-4">
              Run Claude Code inside a <code class="text-neutral-300 bg-neutral-800 px-1.5 py-0.5 rounded text-[11px] font-mono">tmux</code> session so agents can receive your responses in real-time from the TaskFlow UI.
            </p>
            <div class="bg-[#0a0a0a] border border-neutral-800 rounded-lg overflow-hidden mb-4">
              <div class="px-4 py-2 border-b border-neutral-800 bg-[#050505] text-xs font-mono text-neutral-500 flex items-center gap-2">
                <iconify-icon icon="solar:terminal-linear"></iconify-icon>
                Start your agent
              </div>
              <div class="p-4 text-xs font-mono text-neutral-300 overflow-x-auto">
                <span class="text-neutral-500"># Create a tmux session and start Claude Code</span><br />
                tmux new -s agent<br />
                claude
              </div>
            </div>
            <div class="p-4 rounded-lg border border-[#00fbfb]/20 bg-[#00fbfb]/5 space-y-3">
              <div class="text-sm font-medium text-[#00fbfb] flex items-center gap-2">
                <iconify-icon icon="solar:chat-round-dots-linear" class="text-base"></iconify-icon>
                How live chat works
              </div>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs text-neutral-400">
                <div class="flex items-start gap-2">
                  <span class="text-[#00fbfb] mt-0.5 font-mono font-bold">1</span>
                  Agent calls <code class="text-neutral-300 bg-neutral-800 px-1 py-0.5 rounded text-[10px]">ask_user</code> and the question shows up in the <strong class="text-white">Agent Inbox</strong>
                </div>
                <div class="flex items-start gap-2">
                  <span class="text-[#00fbfb] mt-0.5 font-mono font-bold">2</span>
                  You respond from the TaskFlow UI (phone, browser, any device)
                </div>
                <div class="flex items-start gap-2">
                  <span class="text-[#00fbfb] mt-0.5 font-mono font-bold">3</span>
                  MCP server injects your response into the agent's tmux pane
                </div>
                <div class="flex items-start gap-2">
                  <span class="text-[#00fbfb] mt-0.5 font-mono font-bold">4</span>
                  Agent picks up where it left off, as if you typed it yourself
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- Architecture & Performance -->
  <section class="py-24 bg-[#030303] border-t border-[#171717]">
    <div class="max-w-6xl mx-auto px-6 grid grid-cols-1 lg:grid-cols-2 gap-16">
      <div>
        <h2 class="text-2xl font-medium tracking-tight mb-6 text-white">Local-First Architecture</h2>
        <p class="text-sm text-neutral-400 mb-8">Designed for privacy and speed. No cloud sync, no accounts. Just an SQLite file and an SSE broadcast.</p>
        <div class="space-y-3 font-mono text-xs">
          <div class="p-3 border border-neutral-800 rounded bg-[#0a0a0a] flex items-center justify-between text-neutral-300">
            <span>Claude / Codex / Cursor</span>
            <span class="text-neutral-500">MCP Client</span>
          </div>
          <div class="flex justify-center text-neutral-600">
            <iconify-icon icon="solar:round-arrow-down-linear"></iconify-icon> stdio
          </div>
          <div class="p-3 border border-[#69fd5d]/30 rounded bg-[#69fd5d]/5 flex items-center justify-between text-[#69fd5d]">
            <span>taskflow-mcp (Node.js)</span>
            <span>Server</span>
          </div>
          <div class="flex gap-4 px-4">
            <div class="flex-1 flex flex-col items-center">
              <div class="text-neutral-600 my-1"><iconify-icon icon="solar:round-arrow-down-linear"></iconify-icon> FS</div>
              <div class="w-full p-2 border border-neutral-800 rounded bg-[#0a0a0a] text-center text-neutral-400">SQLite DB</div>
            </div>
            <div class="flex-1 flex flex-col items-center">
              <div class="text-neutral-600 my-1"><iconify-icon icon="solar:round-arrow-down-linear"></iconify-icon> SSE :3456</div>
              <div class="w-full p-2 border border-neutral-800 rounded bg-[#0a0a0a] text-center text-neutral-400">Tauri App</div>
            </div>
          </div>
        </div>
        <div class="mt-8 flex flex-wrap gap-2">
          <span class="px-2 py-1 text-[10px] border border-neutral-800 rounded text-neutral-400">React 19</span>
          <span class="px-2 py-1 text-[10px] border border-neutral-800 rounded text-neutral-400">Tauri v2</span>
          <span class="px-2 py-1 text-[10px] border border-neutral-800 rounded text-neutral-400">Dexie.js</span>
          <span class="px-2 py-1 text-[10px] border border-neutral-800 rounded text-neutral-400">better-sqlite3</span>
        </div>
      </div>
      <div>
        <h2 class="text-2xl font-medium tracking-tight mb-6 text-white">Small Token Footprint</h2>
        <p class="text-sm text-neutral-400 mb-8">MCP responses are kept compact. Null fields are dropped and JSON is minimal, so your AI has more context window for actual work.</p>
        <div class="grid grid-cols-2 gap-4 mb-6">
          <div class="p-4 border border-neutral-800 rounded-lg bg-[#0a0a0a]">
            <div class="text-2xl font-medium text-white mb-1">61%</div>
            <div class="text-xs text-neutral-500">Token reduction vs v1.0.0</div>
          </div>
          <div class="p-4 border border-neutral-800 rounded-lg bg-[#0a0a0a]">
            <div class="text-2xl font-medium text-white mb-1">72%</div>
            <div class="text-xs text-neutral-500">Smaller list_tasks payload</div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- Remote Execution -->
  <section id="remote" class="py-24 border-t border-[#171717] bg-[#030303]">
    <div class="max-w-4xl mx-auto px-6">
      <h2 class="text-2xl font-medium tracking-tight mb-2 text-center text-white">Remote Agent Control</h2>
      <p class="text-sm text-neutral-400 mb-12 text-center">
        Control your agents from anywhere. A small relay server sits between your machine and remote clients. All connections are outbound, no VPN needed.
      </p>
      <div class="mb-12 font-mono text-xs space-y-3">
        <div class="grid grid-cols-3 gap-3 items-center">
          <div class="p-3 border border-[#69fd5d]/30 rounded bg-[#69fd5d]/5 text-center text-[#69fd5d]">Local MCP Server</div>
          <div class="p-3 border border-[#de8eff]/30 rounded bg-[#de8eff]/5 text-center text-[#de8eff]">Relay (mailbox)</div>
          <div class="p-3 border border-neutral-700 rounded bg-neutral-900 text-center text-neutral-300">Remote TaskFlow App</div>
        </div>
        <div class="grid grid-cols-3 gap-3 text-center text-neutral-500 text-[10px]">
          <span>Pushes events + state →<br>Polls commands ←</span>
          <span>Event buffer + command queue</span>
          <span>← SSE stream + state<br>Posts commands →</span>
        </div>
      </div>
    </div>
  </section>

  <!-- Open Source CTA -->
  <section class="py-32 border-t border-[#171717] bg-[#030303] relative overflow-hidden">
    <div class="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(105,253,93,0.05)_0%,transparent_50%)] pointer-events-none"></div>
    <div class="max-w-3xl mx-auto px-6 text-center relative z-10">
      <h2 class="text-4xl md:text-5xl font-medium tracking-tighter mb-6 text-white" style="text-shadow: 0 0 30px rgba(105, 253, 93, 0.4);">
        Open Source. Fork It. Ship It.
      </h2>
      <p class="text-base text-neutral-400 mb-10">
        TaskFlow is open source under Apache 2.0 with Commons Clause. Free to use, modify, and share.
      </p>
      <div class="flex flex-col sm:flex-row items-center justify-center gap-4">
        <a href="https://github.com/dalmasonto/task_flow" target="_blank" class="px-6 py-3 rounded-full bg-white text-black hover:bg-neutral-200 transition-colors flex items-center gap-2 text-sm font-medium w-full sm:w-auto justify-center no-underline">
          <iconify-icon icon="solar:star-linear" class="text-lg"></iconify-icon>
          Star on GitHub
        </a>
        <a href="https://www.npmjs.com/package/@dalmasonto/taskflow-mcp" target="_blank" class="px-6 py-3 rounded-full bg-transparent border border-neutral-800 hover:border-neutral-600 text-white transition-colors flex items-center gap-2 text-sm font-medium w-full sm:w-auto justify-center no-underline">
          <iconify-icon icon="solar:box-linear" class="text-lg"></iconify-icon>
          npm package
        </a>
        <a href={docsUrl} class="px-6 py-3 rounded-full bg-transparent border border-[#69fd5d]/30 hover:border-[#69fd5d]/60 text-[#69fd5d] transition-colors flex items-center gap-2 text-sm font-medium w-full sm:w-auto justify-center no-underline">
          <iconify-icon icon="solar:book-linear" class="text-lg"></iconify-icon>
          Read the Docs
        </a>
      </div>
    </div>
  </section>

  <!-- Footer -->
  <footer class="py-12 border-t border-[#171717] bg-[#050505] text-sm">
    <div class="max-w-6xl mx-auto px-6 grid grid-cols-1 md:grid-cols-4 gap-8 mb-12">
      <div class="col-span-1 md:col-span-2">
        <div class="font-medium tracking-tighter text-lg flex items-center gap-2 mb-4 text-white">
          <div class="w-4 h-4 rounded-sm bg-[#69fd5d] flex items-center justify-center">
            <div class="w-1.5 h-1.5 bg-[#030303]"></div>
          </div>
          TASKFLOW
        </div>
        <p class="text-neutral-500 max-w-xs">Local-first task tracking for AI-powered development.</p>
      </div>
      <div>
        <div class="font-medium text-white mb-4">Downloads (Linux)</div>
        <ul class="space-y-2 text-neutral-400 list-none p-0">
          <li><a href="https://tokenkit.s3.amazonaws.com/TaskFlow_1.0.0_amd64_6ff8a943c8a748ddbca99a5f0d6adb43.AppImage" class="hover:text-white transition-colors">.AppImage (Universal)</a></li>
          <li><a href="https://tokenkit.s3.amazonaws.com/TaskFlow_1.0.0_amd64_25121113c29d4ba8a2498b4ffca6bd69.deb" class="hover:text-white transition-colors">.deb (Debian/Ubuntu)</a></li>
          <li><a href="https://tokenkit.s3.amazonaws.com/TaskFlow-1.0.0-1.x86_64_9348356077224db98ecb5a3b3b1418e6.rpm" class="hover:text-white transition-colors">.rpm (Fedora/RHEL)</a></li>
        </ul>
      </div>
      <div>
        <div class="font-medium text-white mb-4">Links</div>
        <ul class="space-y-2 text-neutral-400 list-none p-0">
          <li><a href="https://github.com/dalmasonto/task_flow" class="hover:text-white transition-colors">GitHub Repository</a></li>
          <li><a href="https://www.npmjs.com/package/@dalmasonto/taskflow-mcp" class="hover:text-white transition-colors">npm Package</a></li>
          <li><a href={docsUrl} class="hover:text-white transition-colors">Documentation</a></li>
          <li><a href="https://github.com/dalmasonto/task_flow/blob/main/LICENSE" target="_blank" class="hover:text-white transition-colors">License</a></li>
        </ul>
      </div>
    </div>
    <div class="max-w-6xl mx-auto px-6 pt-8 border-t border-[#171717] flex flex-col md:flex-row items-center justify-between text-neutral-600 text-xs">
      <div>&copy; 2026 TaskFlow. Built by Dalmas Otieno.</div>
      <div class="mt-4 md:mt-0 flex gap-4">
        <a href="https://x.com/dalaborta" target="_blank" class="hover:text-white transition-colors">X / Twitter</a>
        <a href="https://github.com/dalmasonto/task_flow" target="_blank" class="hover:text-white transition-colors">GitHub</a>
      </div>
    </div>
  </footer>
</div>

<style>
  @keyframes pulse-dot { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(0.8); } }
  @keyframes slide-up { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
  :global(.animate-pulse-dot) { animation: pulse-dot 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
  :global(.animate-slide-up) { animation: slide-up 0.5s ease-out forwards; }
</style>
