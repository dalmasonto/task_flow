## V2 Improvement gaps

1. [x] Frontend UI: chat supports image/file/url attachments, and each attachment exposes an access path or URL that an agent can read. Backend still needs upload storage and download authorization.
2. [x] Frontend UI: agents can show sent files from code, including markdown plans, specs, JSON payloads, images, and generic files. Backend still needs file persistence and MCP upload/download endpoints.
3. [x] Frontend UI: agent identification shows display name, stable identifier, short key, project key, project root, linked user, role, and `taskflow.json` handshake shape. Backend still needs identity selection when MCP wakes up and writes/reads the project marker file.
4. [x] Frontend UI: chat area now treats group chats and DMs as the same conversation surface, with shared composer, attachments, terminal context, and member visibility. Backend still needs channel membership and message delivery persistence.
