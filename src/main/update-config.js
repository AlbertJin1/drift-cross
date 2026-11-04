'use strict';

// Updates and usage reporting both go through the Universal App Monitor's public client gateway
// (src/main/monitor-gateway.js): resource=update for the latest Drift-Setup.exe published in the monitor's
// Drift tab > Releases, resource=telemetry for open / heartbeat / close reports. The monitor's API key lives only on
// the monitor server; nothing secret is stored in this app.
//
// Change the gateway below if the monitor is reachable under a different public address, or set
// DRIFT_UPDATE_GATEWAY in the environment (handy for testing against a local monitor).
module.exports = {
  appId: 'drift',

  // Primary address: the same monitor host PDF Studio uses. The other known tunnel address is a fallback, and
  // src/main/monitor-gateway.js also tries the /public/api layout of each (hosts that do not rewrite /api).
  gatewayUrl: process.env.DRIFT_UPDATE_GATEWAY
    || 'https://pdfstudio.shares.zrok.io/pdfstudio-monitor/api/client-gateway.php',
  fallbackGatewayUrls: process.env.DRIFT_UPDATE_GATEWAY
    ? []
    : ['https://paternal-carefully-glucose.ngrok-free.dev/pdfstudio-monitor/api/client-gateway.php'],

  firstCheckDelayMs: 20 * 1000,            // first check shortly after startup, so launch is never slowed
  retryBaseMs: 2 * 60 * 1000,              // after a failed check: 2, 4, 8 ... minutes, never longer than the interval
  checkIntervalMs: 6 * 60 * 60 * 1000,     // then every six hours while Drift stays open
  stallTimeoutMs: 60 * 1000,               // abort a download that receives no data for this long
  requestTimeoutMs: 25 * 1000,
  maxInstallAttempts: 3,                   // after this many failed installs of one version, wait for a newer one
  minInstallerBytes: 5 * 1024 * 1024,
  maxInstallerBytes: 1024 * 1024 * 1024,   // sanity limit on the announced installer size
  maxPackageBytes: 1024 * 1024 * 1024,     // compressed single-entry installer package limit
  maxManifestBytes: 16 * 1024 * 1024,      // bounded differential manifest before JSON parsing
  maxDeltaBytes: 1024 * 1024 * 1024,       // bounded compressed changed-chunk response

  // Usage reporting (src/main/telemetry.js): the same gateway, resource=telemetry. The monitor treats a device as
  // online for 90 seconds after its last report, so a once-a-minute heartbeat keeps it "open".
  reportFirstDelayMs: 4 * 1000,            // "open" shortly after launch
  reportIntervalMs: 60 * 1000,             // "heartbeat" while Drift stays open
  reportRetryMs: 15 * 1000,                // try again sooner after a failed report
  reportTimeoutMs: 10 * 1000,
  reportCloseTimeoutMs: 2500               // longest Drift waits for the "close" report when quitting
};
