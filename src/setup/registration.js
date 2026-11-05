'use strict';
// Per-user Windows registration that lets Drift appear in Settings > Apps > Default apps
// and in "Open with". Everything lives under HKCU, so no administrator rights are needed,
// and Windows still asks the person before Drift becomes their default browser.

const CLIENT_KEY = 'HKCU\\Software\\Clients\\StartMenuInternet\\Drift';
const CAPABILITIES = `${CLIENT_KEY}\\Capabilities`;
const REGISTERED_APPS = 'HKCU\\Software\\RegisteredApplications';
const HTML_PROGID = 'HKCU\\Software\\Classes\\DriftHTML';
const URL_PROGID = 'HKCU\\Software\\Classes\\DriftURL';
const FILE_TYPES = ['.htm', '.html', '.xhtml', '.shtml', '.svg', '.webp'];
const URL_SCHEMES = ['http', 'https'];

const add = (key, name, value, type = 'REG_SZ') => (name === null
  ? ['add', key, '/ve', '/t', type, '/d', String(value), '/f']
  : ['add', key, '/v', name, '/t', type, '/d', String(value), '/f']);

/** `reg.exe` argument lists that register Drift as a browser for the current user. */
function browserRegistrationCommands(exe) {
  if (typeof exe !== 'string' || !/\.exe$/i.test(exe) || /["\r\n]/.test(exe)) throw new Error('A valid Drift.exe path is required.');
  const icon = `${exe},0`;
  const open = `"${exe}" "%1"`;
  const commands = [
    add(CLIENT_KEY, null, 'Drift'),
    add(`${CLIENT_KEY}\\DefaultIcon`, null, icon),
    add(`${CLIENT_KEY}\\shell\\open\\command`, null, `"${exe}"`),
    add(CAPABILITIES, 'ApplicationName', 'Drift'),
    add(CAPABILITIES, 'ApplicationDescription', 'A quiet, fast browser that keeps memory use low.'),
    add(CAPABILITIES, 'ApplicationIcon', icon),
    add(`${CAPABILITIES}\\StartMenu`, 'StartMenuInternet', 'Drift'),
    ...FILE_TYPES.map((ext) => add(`${CAPABILITIES}\\FileAssociations`, ext, 'DriftHTML')),
    ...URL_SCHEMES.map((scheme) => add(`${CAPABILITIES}\\URLAssociations`, scheme, 'DriftURL')),
    add(REGISTERED_APPS, 'Drift', 'Software\\Clients\\StartMenuInternet\\Drift\\Capabilities'),
    add(HTML_PROGID, null, 'Drift HTML Document'),
    add(`${HTML_PROGID}\\DefaultIcon`, null, icon),
    add(`${HTML_PROGID}\\Application`, 'ApplicationName', 'Drift'),
    add(`${HTML_PROGID}\\Application`, 'ApplicationIcon', icon),
    add(`${HTML_PROGID}\\shell\\open\\command`, null, open),
    add(URL_PROGID, null, 'Drift URL'),
    add(URL_PROGID, 'URL Protocol', ''),
    add(`${URL_PROGID}\\DefaultIcon`, null, icon),
    add(`${URL_PROGID}\\shell\\open\\command`, null, open)
  ];
  return commands;
}

/** `reg.exe` argument lists that remove every key and value written above. */
function browserUnregistrationCommands() {
  return [
    ['delete', REGISTERED_APPS, '/v', 'Drift', '/f'],
    ['delete', CLIENT_KEY, '/f'],
    ['delete', HTML_PROGID, '/f'],
    ['delete', URL_PROGID, '/f']
  ];
}

module.exports = { browserRegistrationCommands, browserUnregistrationCommands, FILE_TYPES, URL_SCHEMES };
