export function csvLine(fields: string[]): string {
  return fields.map(value => {
    const numeric = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value);
    const safe = !numeric && /^\s*[=+@-]|^[\t\r\n]/u.test(value) ? "'" + value : value;
    return '"' + safe.replaceAll('"', '""') + '"';
  }).join(',') + '\r\n';
}

export function csvHeader(includeValues: boolean): string {
  return csvLine(['Client ID', 'Platform', 'Environment', 'Config path', 'Value type',
    ...(includeValues ? ['Config value'] : []), 'Hyperpay-config URL', 'Configuration owner', 'Version', 'Stale']);
}
