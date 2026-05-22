import { decryptSecret, encryptSecret } from './secret-envelope';

describe('secret-envelope', () => {
  const PASSPHRASE = 'test-envelope-passphrase-do-not-reuse';

  it('round-trips a plaintext through encrypt → decrypt', () => {
    const sealed = encryptSecret('JBSWY3DPEHPK3PXP', PASSPHRASE);
    expect(decryptSecret(sealed, PASSPHRASE)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('produces a different ciphertext per call (IV is fresh each time)', () => {
    const a = encryptSecret('same-plaintext', PASSPHRASE);
    const b = encryptSecret('same-plaintext', PASSPHRASE);
    expect(a).not.toBe(b);
  });

  it('decryption fails with the wrong passphrase', () => {
    const sealed = encryptSecret('JBSWY3DPEHPK3PXP', PASSPHRASE);
    expect(() => decryptSecret(sealed, 'different-passphrase')).toThrow();
  });

  it('decryption fails when the auth tag is tampered (GCM integrity)', () => {
    const sealed = encryptSecret('JBSWY3DPEHPK3PXP', PASSPHRASE);
    const [iv, , ct] = sealed.split('.');
    const fakeTag = 'a'.repeat(32);
    expect(() => decryptSecret(`${iv}.${fakeTag}.${ct}`, PASSPHRASE)).toThrow();
  });

  it('decryption fails when the ciphertext is tampered', () => {
    const sealed = encryptSecret('JBSWY3DPEHPK3PXP', PASSPHRASE);
    const [iv, tag, ct] = sealed.split('.');
    // Flip a byte
    const tampered = ct.slice(0, -2) + (ct.slice(-2) === '00' ? 'ff' : '00');
    expect(() => decryptSecret(`${iv}.${tag}.${tampered}`, PASSPHRASE)).toThrow();
  });

  it('rejects malformed envelope strings', () => {
    expect(() => decryptSecret('not-an-envelope', PASSPHRASE)).toThrow('invalid envelope');
    expect(() => decryptSecret('a.b', PASSPHRASE)).toThrow('invalid envelope');
  });

  it('rejects an empty passphrase', () => {
    expect(() => encryptSecret('anything', '')).toThrow('APP_SECRET_ENVELOPE_KEY');
  });
});
