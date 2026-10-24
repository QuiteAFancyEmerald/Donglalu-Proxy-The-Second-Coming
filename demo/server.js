import { Chemical } from "chemicaljs";
import { createRelay } from "dlpcc";

// DLPCC_LOCAL=1 skips nginx: browsers get turn:<host>:3478 straight to the
// relay instead of turns:<host>:443. Good for checking a site accepts
// relay-only connections; it doesn't get past a UDP block on its own.
const local = process.env.DLPCC_LOCAL === "1";

const relay = createRelay({
  enabled: process.env.DLPCC_ENABLED !== "false",
  secret: process.env.DLPCC_SECRET,
  relayIp: process.env.DLPCC_RELAY_IP,
  hosts: process.env.DLPCC_HOSTS?.split(","),
  ...(local && { tls: false, publicPort: 3478 }),
});
await relay.start();

const chemical = new Chemical({ port: Number(process.env.PORT ?? 8080), staticDir: "dist" });
// Registered before start() so it runs ahead of Chemical's own routes.
chemical.app.use((req, res, next) => {
  if (!relay.routeRequest(req, res)) next();
});
await chemical.start();

const shutdown = async () => {
  chemical.stop();
  await relay.stop();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
