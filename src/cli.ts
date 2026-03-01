#!/usr/bin/env node

import { startServer } from "./index.js";

startServer()
  .then(() => undefined)
  .catch((err) => {
    console.error("Fatal: server failed to start", err);
    process.exit(1);
  });
