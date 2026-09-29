# The `renderer` sidecar: headless Chromium for design screenshots, kept out
# of the backend image on purpose. It renders agent-authored HTML, so it
# gets no secrets, no database, and runs as the unprivileged `node` user.
# Chromium's own sandbox cannot start on the production host (Ubuntu 24.04
# restricts unprivileged user namespaces), hence DESIGN_RENDER_NO_SANDBOX
# and why this container, not Chromium, is the isolation boundary.
FROM node:22-bookworm-slim

# Debian's chromium instead of Puppeteer's download: glibc-matched, and the
# fonts below are what an un-fonted page falls back to.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium fonts-liberation fonts-dejavu-core fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /renderer
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    DESIGN_RENDER_NO_SANDBOX=1 \
    NODE_ENV=production
# devices.css: the MIT device frames the Design Surface draws (frames.mjs).
RUN npm install --no-audit --no-fund puppeteer@25.12.0 devices.css@0.2.0 && npm cache clean --force

COPY design-render.mjs frames.mjs frame-data.json server.mjs ./

USER node
ENV HOME=/tmp
EXPOSE 3000
CMD ["node", "server.mjs"]
