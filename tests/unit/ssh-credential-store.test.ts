import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { SshCredentialStore } from '../../src/main/ssh-credential-store';

const temporaryDirectories: string[] = [];
const scope = { host: 'server.example.com', port: 22, username: 'deploy' };

function createStore(available = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-credentials-'));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, 'credentials.json');
  const encryption = {
    isEncryptionAvailable: () => available,
    encryptString: (value: string) => Buffer.from(`protected:${[...value].reverse().join('')}`),
    decryptString: (value: Buffer) => [...value.toString().replace(/^protected:/, '')].reverse().join(''),
  };
  return { store: new SshCredentialStore(encryption, filePath), filePath };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('SshCredentialStore', () => {
  it('round-trips an encrypted password without writing plaintext', () => {
    const { store, filePath } = createStore();
    store.save('profile-a', 'correct horse battery staple', scope);

    expect(store.get('profile-a', scope)).toBe('correct horse battery staple');
    expect(fs.readFileSync(filePath, 'utf8')).not.toContain('correct horse battery staple');
  });

  it('deletes a rejected credential', () => {
    const { store } = createStore();
    store.save('profile-a', 'old-password', scope);
    store.delete('profile-a');

    expect(store.get('profile-a', scope)).toBeUndefined();
  });

  it('never falls back to plaintext when encryption is unavailable', () => {
    const { store, filePath } = createStore(false);

    expect(() => store.save('profile-a', 'secret', scope)).toThrow('Windows 安全存储不可用');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('rejects untrusted credential identifiers', () => {
    const { store } = createStore();

    expect(() => store.save('__proto__', 'secret', scope)).toThrow('凭据标识无效');
    expect(store.get('../profile', scope)).toBeUndefined();
  });

  it('never returns a credential for a different SSH endpoint', () => {
    const { store } = createStore();
    store.save('profile-a', 'secret', scope);

    expect(store.get('profile-a', { ...scope, host: 'attacker.example.com' })).toBeUndefined();
  });
});
