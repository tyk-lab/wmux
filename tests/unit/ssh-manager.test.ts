import { describe, expect, it } from 'vitest';
import { hashKnownHostKey, parseOpenSshConfig } from '../../src/main/ssh-manager';

describe('parseOpenSshConfig', () => {
  it('imports selectable Host entries as editable SFTP-ready drafts', () => {
    const drafts = parseOpenSshConfig(`
      Host production
        HostName prod.example.com
        User deploy
        Port 2222
        IdentityFile ~/.ssh/id_ed25519
    `);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      hostAlias: 'production',
      name: 'production',
      host: 'prod.example.com',
      username: 'deploy',
      port: 2222,
      authMethod: 'privateKey',
    });
    expect(drafts[0].privateKeyPath).toMatch(/[\\/]\.ssh[\\/]id_ed25519$/);
  });

  it('ignores wildcard rules because they are not destinations users can connect to', () => {
    const drafts = parseOpenSshConfig(`
      Host *
        ServerAliveInterval 30
      Host staging
        HostName staging.example.com
    `);

    expect(drafts).toEqual([{ hostAlias: 'staging', name: 'staging', host: 'staging.example.com', port: 22, authMethod: 'agent' }]);
  });
});

describe('hashKnownHostKey', () => {
  it('uses the hexadecimal format ssh2 supplies to hostVerifier', () => {
    expect(hashKnownHostKey(Buffer.from('host-key').toString('base64')))
      .toBe('09f10e4bdc37a471382a5aa37101705b258c9b246fbcfa1e8727723214f1a738');
  });
});
