// Entry used ONLY by the Setup build (electron-builder.setup.json sets "main" to this file).
// - Setup.exe (portable launch) or --uninstall  -> custom installer UI
// - Installed Drift.exe (normal launch)         -> the real browser
const setupMode = process.env.PORTABLE_EXECUTABLE_FILE || process.argv.includes('--uninstall') || process.argv.includes('--setup');
require(setupMode ? './installer.js' : '../main/main.js');
