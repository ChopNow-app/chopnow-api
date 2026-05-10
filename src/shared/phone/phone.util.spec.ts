import { normalizePhone } from './phone.util';

describe('normalizePhone', () => {
  it('prepends +237 to a 9-digit Cameroon local number', () => {
    expect(normalizePhone('670000000')).toBe('+237670000000');
    expect(normalizePhone('699999999')).toBe('+237699999999');
  });

  it('passes E.164 numbers through unchanged', () => {
    expect(normalizePhone('+237670000000')).toBe('+237670000000');
    expect(normalizePhone('+33695412820')).toBe('+33695412820');
    expect(normalizePhone('+32470123456')).toBe('+32470123456');
  });

  it('prepends + to bare international digits', () => {
    expect(normalizePhone('33695412820')).toBe('+33695412820');
    expect(normalizePhone('32470123456')).toBe('+32470123456');
  });

  it('canonicalizes the same logical number to the same string regardless of input form', () => {
    // 670000000 (Cameroon local) and +237670000000 (E.164) must collapse —
    // otherwise a user who registers with one form and verifies with the other
    // ends up with two distinct accounts.
    expect(normalizePhone('670000000')).toBe(normalizePhone('+237670000000'));
  });
});
