#!/usr/bin/env node

import { startServer } from "./index.js";

function keepProcessAliveUntilStdinCloses(): Promise<void> {
  return new Promise((resolve) => {
    const keepAlive = setInterval(() => {}, 1 << 30);

    const release = () => {
      clearInterval(keepAlive);
      resolve();
    };

    if (process.stdin.destroyed) {
      release();
      return;
    }

    process.stdin.once("end", release);
    process.stdin.once("close", release);
  });
}

startServer()
  .then(() => keepProcessAliveUntilStdinCloses())
  .catch((err) => {
    console.error("Fatal: server failed to start", err);
    process.exit(1);
  });
