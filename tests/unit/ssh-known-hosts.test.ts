import { createHmac } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendKnownHostKey,
  expectedKnownHostNames,
  formatOpenSshFingerprint,
  hashKnownHostKey,
  inspectKnownHostKey,
  knownHostMarker,
  parseKnownHosts,
  parseSshHostPublicKey,
} from '../../src/main/ssh-known-hosts';

const temporaryDirectories: string[] = [];

function createKnownHostsPath(): string {
  const homeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-known-hosts-'));
  temporaryDirectories.push(homeDirectory);
  const sshDirectory = path.join(homeDirectory, '.ssh');
  fs.mkdirSync(sshDirectory);
  return path.join(sshDirectory, 'known_hosts');
}

function wirePublicKey(algorithm: string, payload = 'host-key'): Buffer {
  const name = Buffer.from(algorithm, 'ascii');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(name.length);
  return Buffer.concat([header, name, Buffer.from(payload)]);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('known_hosts helpers', () => {
  it('parses a raw ssh2 host public key and formats an OpenSSH fingerprint', () => {
    const key = wirePublicKey('ssh-ed25519');
    const parsed = parseSshHostPublicKey(key);

    expect(parsed.algorithm).toBe('ssh-ed25519');
    expect(parsed.encodedKey).toBe(key.toString('base64'));
    expect(formatOpenSshFingerprint(parsed.encodedKey)).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(hashKnownHostKey(parsed.encodedKey)).toHaveLength(64);
  });

  it('matches plaintext and hashed known_hosts names', () => {
    const key = wirePublicKey('ssh-ed25519', 'same-key');
    const encodedKey = key.toString('base64');
    const salt = Buffer.from('0123456789abcdefghij');
    const hashedName = `|1|${salt.toString('base64')}|${createHmac('sha1', salt).update('10.0.1.182').digest('base64')}`;
    const knownHostsPath = createKnownHostsPath();
    fs.writeFileSync(knownHostsPath, [
      '10.0.1.154 ssh-ed25519 ' + encodedKey,
      `${hashedName} ssh-ed25519 ${encodedKey}`,
    ].join('\n'));

    expect(expectedKnownHostNames('10.0.1.182', 22)).toEqual(['10.0.1.182', '[10.0.1.182]:22']);
    expect(knownHostMarker('10.0.1.182', 22)).toBe('10.0.1.182');
    expect(inspectKnownHostKey('10.0.1.182', 22, encodedKey, knownHostsPath)).toMatchObject({
      status: 'trusted',
      knownAs: ['10.0.1.154'],
    });
    expect(parseKnownHosts(fs.readFileSync(knownHostsPath, 'utf8'))).toHaveLength(2);
  });

  it('treats an unknown host as confirmable and appends it after acceptance', () => {
    const key = wirePublicKey('ssh-ed25519', 'new-host');
    const encodedKey = key.toString('base64');
    const knownHostsPath = createKnownHostsPath();

    expect(inspectKnownHostKey('10.0.1.182', 22, encodedKey, knownHostsPath).status).toBe('unknown');
    appendKnownHostKey('10.0.1.182', 22, 'ssh-ed25519', encodedKey, knownHostsPath);
    expect(inspectKnownHostKey('10.0.1.182', 22, encodedKey, knownHostsPath).status).toBe('trusted');
    expect(fs.readFileSync(knownHostsPath, 'utf8')).toContain('10.0.1.182 ssh-ed25519 ');
    appendKnownHostKey('10.0.1.182', 22, 'ssh-ed25519', encodedKey, knownHostsPath);
    expect(fs.readFileSync(knownHostsPath, 'utf8').trim().split(/\n/u)).toHaveLength(1);
  });

  it('detects a changed host key and a revoked key', () => {
    const current = wirePublicKey('ssh-ed25519', 'current');
    const previous = wirePublicKey('ssh-ed25519', 'previous');
    const knownHostsPath = createKnownHostsPath();
    fs.writeFileSync(knownHostsPath, [
      `10.0.1.182 ssh-ed25519 ${previous.toString('base64')}`,
      `@revoked 10.0.1.188 ssh-ed25519 ${current.toString('base64')}`,
    ].join('\n'));

    expect(inspectKnownHostKey('10.0.1.182', 22, current.toString('base64'), knownHostsPath).status)
      .toBe('changed');
    expect(inspectKnownHostKey('10.0.1.188', 22, current.toString('base64'), knownHostsPath).status)
      .toBe('revoked');
  });
});
