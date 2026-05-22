import jwt from 'jsonwebtoken';
import { verifyCampayJwtSignature } from './campay-signature';

describe('verifyCampayJwtSignature', () => {
  const SECRET = 'test-webhook-secret-12345';

  function sign(claims: object, secret = SECRET, opts?: jwt.SignOptions): string {
    return jwt.sign(claims, secret, { algorithm: 'HS256', ...opts });
  }

  it('returns true for a JWT signed with the same secret + HS256', () => {
    const sig = sign({ status: 'SUCCESSFUL', reference: 'TC-ABCDE' });
    expect(verifyCampayJwtSignature(sig, SECRET)).toBe(true);
  });

  it('returns false when the JWT was signed with a different secret', () => {
    const sig = sign({ status: 'SUCCESSFUL' }, 'wrong-secret-xxxxxxxxx');
    expect(verifyCampayJwtSignature(sig, SECRET)).toBe(false);
  });

  it('returns false when the JWT is malformed', () => {
    expect(verifyCampayJwtSignature('not-a-jwt', SECRET)).toBe(false);
  });

  it('returns false when the signature is undefined / empty string', () => {
    expect(verifyCampayJwtSignature(undefined, SECRET)).toBe(false);
    expect(verifyCampayJwtSignature(null, SECRET)).toBe(false);
    expect(verifyCampayJwtSignature('', SECRET)).toBe(false);
  });

  it('returns false when the secret is undefined / empty (defensive)', () => {
    const sig = sign({ status: 'SUCCESSFUL' });
    expect(verifyCampayJwtSignature(sig, undefined)).toBe(false);
    expect(verifyCampayJwtSignature(sig, '')).toBe(false);
  });

  it('rejects a JWT whose algorithm header is "none" (alg-confusion attack)', () => {
    // jsonwebtoken does NOT allow alg=none by default; this asserts behaviour
    // even if someone tampered with the lib config.
    // nosemgrep: javascript.jsonwebtoken.security.jwt-hardcode.hardcoded-jwt-secret
    const sig = jwt.sign({ status: 'SUCCESSFUL' }, '', { algorithm: 'none' });
    expect(verifyCampayJwtSignature(sig, SECRET)).toBe(false);
  });

  it('rejects a JWT whose claims were tampered after signing', () => {
    const sig = sign({ status: 'SUCCESSFUL', reference: 'TC-ABCDE' });
    // Splice a different claims segment in the middle while keeping the
    // original signature. JWT verify must reject this.
    const [header, , signature] = sig.split('.');
    const tamperedClaims = Buffer.from(
      JSON.stringify({ status: 'SUCCESSFUL', reference: 'TC-EVIL!' }),
    ).toString('base64url');
    const tampered = `${header}.${tamperedClaims}.${signature}`;
    expect(verifyCampayJwtSignature(tampered, SECRET)).toBe(false);
  });
});
