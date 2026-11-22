import { createApp } from "./app.js";

const { app, cfg } = createApp();
app.listen(cfg.port, () => console.log(`[claude-connector] listening on :${cfg.port} as ${cfg.baseUrl}`));
