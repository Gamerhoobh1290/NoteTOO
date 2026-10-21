// Network guards shared by the AI proxy and the agent's model client: AI requests may go to any
// http(s) server the user set up, but never to link-local addresses (cloud metadata services).

import { lookup as dnsLookup } from 'node:dns';
import type { LookupFunction } from 'node:net';
import * as tls from 'node:tls';

/** Link-local address, in any notation (IPv6 in brackets, IPv4-mapped IPv6 in dotted or hex form). */
export function isLinkLocal(raw: string): boolean {
  let a = raw.replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (mapped) {
    const [hi, lo] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)];
    a = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return /^(::ffff:)?169\.254\./.test(a) || /^fe[89ab][0-9a-f]:/.test(a);
}

/** DNS lookup for AI requests that refuses link-local addresses (cloud metadata services and the like). */
export const noLinkLocal: LookupFunction = (host, opts, cb) => {
  dnsLookup(host, opts, (err, address, family) => {
    const all = Array.isArray(address) ? address.map((a) => a.address) : [address as string];
    if (!err && all.some(isLinkLocal)) {
      return cb(Object.assign(new Error(`${host} is not an AI server address.`), { code: 'EADDRNOTAVAIL' }), address as string, family);
    }
    cb(err, address as string, family);
  });
};

let caList: string[] | undefined | null = null;

/**
 * Certificates trusted for HTTPS to AI servers: Node.js's own, plus the ones Windows (or macOS)
 * trusts. Antivirus or company software that inspects HTTPS installs its certificate in the system
 * store only, so without these the browser reaches a provider and NoteTOO cannot. Needs Node.js
 * 22.15+ (getCACertificates); older versions use Node.js's own list.
 */
export function aiCertificates(): string[] | undefined {
  if (caList === null) {
    try {
      const get = (tls as { getCACertificates?: (type: string) => string[] }).getCACertificates;
      caList = get ? [...new Set([...get('default'), ...get('system')])] : undefined;
    } catch {
      caList = undefined;
    }
  }
  return caList;
}

/** What went wrong reaching an AI server, in plain words, with a hint (for the panel and the server window). */
export function describeNetError(e: NodeJS.ErrnoException): string {
  const code = e.code ?? '';
  const detail = code && e.message?.includes(code) ? e.message : [code, e.message].filter(Boolean).join(': ');
  let hint = '';
  if (/^(ENOTFOUND|EAI_AGAIN)$/.test(code)) hint = 'The PC could not look up the server name (DNS): check its internet connection.';
  else if (/^(ECONNREFUSED)$/.test(code)) hint = 'Nothing answers at that address and port.';
  else if (/^(ETIMEDOUT|ECONNRESET|EPIPE|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT)$/.test(code))
    hint = 'The connection was cut or timed out: a firewall, VPN or antivirus on the PC may be blocking Node.js.';
  else if (/CERT|SSL|TLS|SELF_SIGNED|ISSUER/i.test(code + e.message))
    hint = 'The secure connection was not trusted: antivirus or company software that inspects HTTPS is likely. Update Node.js to 22.15 or later (NoteTOO then also trusts the certificates Windows trusts), or turn off HTTPS scanning for Node.js.';
  return `${(detail || 'connection failed').replace(/\.$/, '')}.${hint ? ` ${hint}` : ''}`;
}
