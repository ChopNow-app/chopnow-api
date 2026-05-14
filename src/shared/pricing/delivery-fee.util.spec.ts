import { computeDeliveryFeeXAF } from './delivery-fee.util';

describe('computeDeliveryFeeXAF', () => {
  it.each([
    [0.0, 350], // floor
    [0.5, 350], // base=300 → floor
    [1.0, 350], // 250+100 = 350 (already at floor, rounds to 350)
    [1.5, 400], // 250+150 = 400 (exact 50)
    [2.0, 450], // 250+200 = 450
    [3.7, 650], // 250+370 = 620 → round up to 650
    [7.0, 950], // 250+700 = 950 (exact 50)
    [12.5, 1500], // 250+1250 = 1500 (at cap)
    [50.0, 1500], // far over cap
  ])('km=%s → %i FCFA (always multiple of 50)', (km, expected) => {
    const fee = computeDeliveryFeeXAF(km);
    expect(fee).toBe(expected);
    expect(fee % 50).toBe(0);
  });
});
