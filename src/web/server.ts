import { app } from "./app.ts";

const PORT = parseInt(process.env.WEB_PORT || "3000", 10);
const HOST = process.env.WEB_HOST || "127.0.0.1";

// Start server
const server = Bun.serve({
  fetch: app.fetch,
  port: PORT,
  hostname: HOST,
});

console.log(`eliza-sol-agent web API listening on ${HOST}:${PORT}`);
