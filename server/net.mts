// Network guards shared by the AI proxy and the agent's model client: AI requests may go to any
// http(s) server the user set up, but never to link-local addresses (cloud metadata services).

import { lookup as dnsLookup } from 'node:dns';
import type { LookupFunction } from 'node:net';

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
