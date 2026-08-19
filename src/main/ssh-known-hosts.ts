import { createHash, createHmac, timingSafeEqual } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

export type KnownHostStatus = 'trusted' | 'unknown' | 'changed' | 'revoked';

export interface SshHostPublicKey {
  algorithm: string;
  encodedKey: string;
}

export interface KnownHostInspection {
  status: KnownHostStatus;
  fingerprint: string;
  knownAs: string[];
}

export interface KnownHostEntry {
  hosts: string[];
  hashed?: { salt: Buffer; digest: Buffer };
  algorithm: string;
  encodedKey: string;
  hexFingerprint: string;
  revoked: boolean;
}

export function defaultKnownHostsPath(homeDirectory = os.homedir()): string {
  return path.join(homeDirectory, '.ssh', 'known_hosts');
}

/** Hex SHA-256 of the decoded host key; matches ssh2's hostHash=sha256 output. */
export function hashKnownHostKey(encodedKey: string): string {
  return createHash('sha256').update(Buffer.from(encodedKey, 'base64')).digest('hex');
}

/** OpenSSH `SHA256:` fingerprint shown by `ssh` on first connect. */
export function formatOpenSshFingerprint(encodedKey: string): string {
  return `SHA256:${createHash('sha256')
    .update(Buffer.from(encodedKey, 'base64'))
    .digest('base64')
    .replace(/=+$/u, '')}`;
}

export function expectedKnownHostNames(host: string, port: number): string[] {
  return [...new Set([host, `[${host}]:${port}`])];
}

export function knownHostMarker(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

export function parseSshHostPublicKey(key: Buffer): SshHostPublicKey {
  if (!Buffer.isBuffer(key) || key.length < 8) {
    throw new Error('主机公钥无效');
  }
  const algorithmLength = key.readUInt32BE(0);
  if (algorithmLength < 1 || algorithmLength > 64 || 4 + algorithmLength > key.length) {
    throw new Error('主机公钥无效');
  }
  const algorithm = key.subarray(4, 4 + algorithmLength).toString('ascii');
  if (!/^[A-Za-z0-9@._-]+$/u.test(algorithm)) {
    throw new Error('主机公钥无效');
  }
  return { algorithm, encodedKey: key.toString('base64') };
}

function parseHashedHost(marker: string): { salt: Buffer; digest: Buffer } | undefined {
  const parts = marker.split('|');
  if (parts.length !== 4 || parts[1] !== '1' || !parts[2] || !parts[3]) return undefined;
  const salt = Buffer.from(parts[2], 'base64');
  const digest = Buffer.from(parts[3], 'base64');
  if (salt.length === 0 || digest.length === 0) return undefined;
  return { salt, digest };
}

function hashedHostMatches(hashed: { salt: Buffer; digest: Buffer }, hostNames: string[]): boolean {
  return hostNames.some((name) => {
    const digest = createHmac('sha1', hashed.salt).update(name).digest();
    return digest.length === hashed.digest.length && timingSafeEqual(digest, hashed.digest);
  });
}

export function parseKnownHosts(content: string): KnownHostEntry[] {
  const entries: KnownHostEntry[] = [];
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const tokens = line.split(/\s+/u);
    let revoked = false;
    if (tokens[0]?.startsWith('@')) {
      const marker = tokens.shift();
      if (marker !== '@revoked') continue;
      revoked = true;
    }
    if (tokens.length < 3) continue;
    const [hostsToken, algorithm, encodedKey] = tokens;
    if (!hostsToken || !algorithm || !encodedKey) continue;
    const hashed = hostsToken.startsWith('|') ? parseHashedHost(hostsToken) : undefined;
    if (hostsToken.startsWith('|') && !hashed) continue;
    entries.push({
      hosts: hashed ? [] : hostsToken.split(',').filter(Boolean),
      hashed,
      algorithm,
      encodedKey,
      hexFingerprint: hashKnownHostKey(encodedKey),
      revoked,
    });
  }
  return entries;
}

function readKnownHostsContent(knownHostsPath: string): string {
  try {
    return fs.readFileSync(knownHostsPath, 'utf8');
  } catch {
    return '';
  }
}

function entryMatchesHost(entry: KnownHostEntry, hostNames: string[]): boolean {
  if (entry.hashed) return hashedHostMatches(entry.hashed, hostNames);
  return entry.hosts.some((item) => hostNames.includes(item));
}

export function inspectKnownHostKey(
  host: string,
  port: number,
  encodedKey: string,
  knownHostsPath = defaultKnownHostsPath(),
): KnownHostInspection {
  const fingerprint = formatOpenSshFingerprint(encodedKey);
  const hexFingerprint = hashKnownHostKey(encodedKey);
  const hostNames = expectedKnownHostNames(host, port);
  const knownAs: string[] = [];
  let hostMatched = false;
  let trusted = false;
  let revoked = false;
  for (const entry of parseKnownHosts(readKnownHostsContent(knownHostsPath))) {
    const fingerprintMatches = entry.hexFingerprint === hexFingerprint;
    if (fingerprintMatches) knownAs.push(...entry.hosts);
    if (!entryMatchesHost(entry, hostNames)) continue;
    hostMatched = true;
    if (!fingerprintMatches) continue;
    if (entry.revoked) revoked = true;
    else trusted = true;
  }
  const uniqueKnownAs = [...new Set(knownAs.filter((item) => !hostNames.includes(item)))];
  if (revoked) return { status: 'revoked', fingerprint, knownAs: uniqueKnownAs };
  if (trusted) return { status: 'trusted', fingerprint, knownAs: uniqueKnownAs };
  if (hostMatched) return { status: 'changed', fingerprint, knownAs: uniqueKnownAs };
  return { status: 'unknown', fingerprint, knownAs: uniqueKnownAs };
}

export function appendKnownHostKey(
  host: string,
  port: number,
  algorithm: string,
  encodedKey: string,
  knownHostsPath = defaultKnownHostsPath(),
): void {
  if (inspectKnownHostKey(host, port, encodedKey, knownHostsPath).status === 'trusted') return;
  const line = `${knownHostMarker(host, port)} ${algorithm} ${encodedKey}\n`;
  fs.mkdirSync(path.dirname(knownHostsPath), { recursive: true });
  let prefix = '';
  try {
    const existing = fs.readFileSync(knownHostsPath, 'utf8');
    if (existing.length > 0 && !existing.endsWith('\n')) prefix = '\n';
  } catch {
    // A missing known_hosts is created by the append below.
  }
  fs.appendFileSync(knownHostsPath, `${prefix}${line}`, { encoding: 'utf8' });
}
