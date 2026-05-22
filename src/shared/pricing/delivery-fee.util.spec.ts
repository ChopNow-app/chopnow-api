import { computeDeliveryFeeXAF } from './delivery-fee.util';

describe('computeDeliveryFeeXAF', () => {
  it.each([
    [0.0, 500], // floor (raised from 350 — rider-sustainability)
    [0.5, 500], // base+50 < floor → floor
    [1.0, 500], // 250+100 = 350 < floor → 500
    [1.5, 500], // 250+150 = 400 < floor → 500
    [2.0, 500], // 250+200 = 450 < floor → 500
    [2.5, 500], // 250+250 = 500 → exactly at floor
    [3.0, 550], // 250+300 = 550 (above floor)
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
