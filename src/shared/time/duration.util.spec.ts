import { parseDurationMs } from './duration.util';

describe('parseDurationMs', () => {
  it.each([
    ['60s', 60_000],
    ['15m', 900_000],
    ['24h', 86_400_000],
    ['30d', 2_592_000_000],
    ['1s', 1_000],
  ])('parses %s', (input, expected) => {
    expect(parseDurationMs(input)).toBe(expected);
  });

  it.each(['', '30', 'd', '30days', '-1d', '1.5h', '30 d'])('rejects %s', (bad) => {
    expect(() => parseDurationMs(bad)).toThrow(/Invalid duration/);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseDurationMs(' 30d ')).toBe(2_592_000_000);
  });
});
