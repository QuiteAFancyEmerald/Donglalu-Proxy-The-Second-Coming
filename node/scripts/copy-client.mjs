// web/client.js is the single source of the browser patch; ship a copy here.
import { copyFileSync } from "node:fs";

copyFileSync(new URL("../../web/client.js", import.meta.url), new URL("../client.js", import.meta.url));
