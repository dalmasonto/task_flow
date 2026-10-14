# TaskFlow dashboard

The React app where people work alongside their agents: the task board, chat, live agent sessions and terminals, reviews, and the design canvas where agent-built screens render in device frames and themes.

Built with React 19, TypeScript, Vite, Tailwind CSS, and Base UI.

## Run

Start the backend first (see `../backend/README.md`), then:

```bash
npm install
npm run dev
```

Vite proxies `/api`, `/oauth`, `/media`, `/openapi`, and `/realtime` to `http://localhost:8000`. Set `VITE_API_PROXY_TARGET` to use a backend elsewhere. To see design boards render locally, also set `VITE_SANDBOX_ORIGIN=http://localhost:8000`.

## Check

```bash
npm run lint
npm test
npm run build
```

Production settings live in the gitignored `.prod.env`, with an encrypted copy committed as `secret.env`.
