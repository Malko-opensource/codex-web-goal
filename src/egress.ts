import * as http from 'node:http';
import * as net from 'node:net';
import { lookup } from 'node:dns/promises';
import { pipeline } from 'node:stream';
import { requireThat } from './shared.js';

const blocked = new net.BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]] as const) blocked.addSubnet(address, prefix, 'ipv4');
const globalV6 = new net.BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [['2001::', 32], ['2001:db8::', 32], ['2002::', 16]] as const) blocked.addSubnet(address, prefix, 'ipv6');
export function isPublicAddress(address: string) {
  const family = net.isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4') : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}
export async function publicDestination(hostname: string, deniedHosts: string[], resolve = lookup) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  requireThat(!deniedHosts.some(h => host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase()}`)), 'NETWORK_DENIED', 'This host belongs to the control plane.');
  const addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await resolve(host, { all: true, verbatim: true });
  requireThat(addresses.length && addresses.every(item => isPublicAddress(item.address)), 'NETWORK_DENIED', 'Private, local and reserved destinations are denied.');
  return addresses[0]!;
}

/** Sandbox permits only this proxy; DNS is resolved and pinned OUTSIDE the job. */
export async function publicInternetProxy(deniedHosts: string[]) {
  const sockets = new Set<net.Socket>();
  const track = (socket: net.Socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.setTimeout(60_000, () => socket.destroy()); return socket; };
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '');
      requireThat(url.protocol === 'http:' && !url.username && !url.password, 'PROXY_REQUEST', 'Use HTTP proxy or CONNECT for HTTPS.');
      const destination = await publicDestination(url.hostname, deniedHosts);
      const headers: http.OutgoingHttpHeaders = { ...request.headers, host: url.host }; delete headers['proxy-authorization']; delete headers['proxy-connection'];
      const upstream = http.request({ hostname: destination.address, family: destination.family, port: url.port || 80, path: `${url.pathname}${url.search}`, method: request.method, headers }, result => {
        response.writeHead(result.statusCode ?? 502, result.headers); pipeline(result, response, () => {});
      });
      upstream.on('socket', track); upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
      pipeline(request, upstream, () => {});
    } catch { response.writeHead(403); response.end('Destination denied'); }
  });
  server.on('connect', (request, socket, head) => {
    void (async () => {
      try {
        const url = new URL(`https://${request.url}`);
        requireThat(!url.username && !url.password && url.pathname === '/', 'PROXY_REQUEST', 'Invalid CONNECT target.');
        const destination = await publicDestination(url.hostname, deniedHosts);
        const upstream = track(net.connect({ host: destination.address, family: destination.family, port: Number(url.port || 443) }));
        upstream.once('error', () => socket.destroy());
        upstream.once('connect', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket); });
        socket.once('close', () => upstream.destroy());
      } catch { socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); }
    })();
  });
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.on('connection', socket => { if (sockets.size >= 64) socket.destroy(); else track(socket); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as net.AddressInfo).port;
  return { port, close() { for (const socket of sockets) socket.destroy(); server.closeAllConnections(); server.close(); } };
}
