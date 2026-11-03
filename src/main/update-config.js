'use strict';

// Where Drift looks for updates: the Universal App Monitor's public client gateway.
// The gateway adds the monitor's API key on the server, so nothing secret lives in this file.
// Change the default below if the monitor is reachable under a different public address, or set
// DRIFT_UPDATE_GATEWAY in the environment (handy for testing against a local monitor).
module.exports = {
  appId: 'drift',
  gatewayUrl: process.env.DRIFT_UPDATE_GATEWAY
    || 'https://paternal-carefully-glucose.ngrok-free.dev/pdfstudio-monitor/api/client-gateway.php',
  firstCheckDelayMs: 60 * 1000,            // first check shortly after startup, so launch is never slowed
  checkIntervalMs: 6 * 60 * 60 * 1000,     // then every six hours while Drift stays open
  stallTimeoutMs: 60 * 1000,               // abort a download that receives no data for this long
  requestTimeoutMs: 25 * 1000,
  maxInstallAttempts: 3,                   // after this many failed installs of one version, wait for a newer one
  minInstallerBytes: 5 * 1024 * 1024,
  maxInstallerBytes: 1024 * 1024 * 1024,   // the monitor's own upload limit

  // Usage reporting (src/main/telemetry.js): the same gateway, resource=telemetry. The monitor treats a device as
  // online for 90 seconds after its last report, so a once-a-minute heartbeat keeps it "open".
  reportFirstDelayMs: 4 * 1000,            // "open" shortly after launch
  reportIntervalMs: 60 * 1000,             // "heartbeat" while Drift stays open
  reportRetryMs: 15 * 1000,                // try again sooner after a failed report
  reportTimeoutMs: 10 * 1000,
  reportCloseTimeoutMs: 2500               // longest Drift waits for the "close" report when quitting
};
