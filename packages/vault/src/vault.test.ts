import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, generateVaultKeyPair, rewrap } from './index';

describe('vault', () => {
  it('encrypts with the public key; only the private key decrypts', async () => {
    const { publicJwk, privateJwk } = await generateVaultKeyPair();
    const enc = await encryptSecret('  sk-proj-test-1234567890abcd  ', publicJwk, 1);
    expect(enc.last4).toBe('abcd');
    expect(JSON.stringify(enc)).not.toContain('sk-proj-test');
    expect(await decryptSecret(enc, privateJwk)).toBe('sk-proj-test-1234567890abcd');
    const other = await generateVaultKeyPair();
    await expect(decryptSecret(enc, other.privateJwk)).rejects.toThrow();
  });

  it('re-wraps for key rotation', async () => {
    const a = await generateVaultKeyPair();
    const b = await generateVaultKeyPair();
    const enc = await encryptSecret('nvapi-abcdefgh1234', a.publicJwk, 1);
    const wrapped = await rewrap(enc, a.privateJwk, b.publicJwk);
    expect(await decryptSecret({ ...enc, wrapped_dek: wrapped }, b.privateJwk)).toBe('nvapi-abcdefgh1234');
  });
});
