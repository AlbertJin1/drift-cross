'use strict';
// Clean exit for tests that talk to a local HTTP server.
// Calling process.exit() while fetch/undici keep-alive sockets are still closing trips a libuv
// assertion on Windows + Node 24 (UV_HANDLE_CLOSING, exit code 3221226505). So: drop every
// connection, wait for the servers to close, then let the event loop drain naturally.
async function finish(failed, servers = []) {
  for (const server of servers) {
    try { server.closeAllConnections?.(); } catch { /* already closed */ }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1500);
      try { server.close(() => { clearTimeout(timer); resolve(); }); } catch { clearTimeout(timer); resolve(); }
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  process.exitCode = failed ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 3000).unref(); // safety net only
}
module.exports = { finish };
