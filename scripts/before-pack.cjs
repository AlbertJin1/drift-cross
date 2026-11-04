'use strict';

const fs = require('node:fs');
const path = require('node:path');

module.exports = async function beforePack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const root = path.resolve(__dirname, '..');
  if (process.env.DRIFT_SKIP_VPN === '1') {
    console.warn('[Drift] DRIFT_SKIP_VPN=1: packaging WITHOUT the bundled VPN engine.');
    return;
  }
  const required = [
    'resources/vpn/openvpn2socks.exe',
    'resources/vpn/GO-OPENVPN-CORRESPONDING-SOURCE.zip',
    'resources/vpn/GO-OPENVPN-LICENSE.txt',
    'resources/vpn/GO-OPENVPN-LICENSE-EXCEPTION.txt',
    'resources/vpn/ENGINE-VERSION.txt',
  ];
  const missing = required.filter((relative) => !fs.existsSync(path.join(root, relative)));
  if (missing.length) {
    throw new Error(
      `Refusing to package a Windows VPN-enabled Drift build without its bundled userspace engine. Missing: ${missing.join(', ')}. Run build_publish.bat (it builds the helper, or builds without it when Go is not installed).`,
    );
  }
  const binary = fs.statSync(path.join(root, required[0]));
  if (binary.size < 1024 * 1024) {
    throw new Error('The bundled openvpn2socks.exe is unexpectedly small; rebuild the VPN helper before packaging.');
  }
};
