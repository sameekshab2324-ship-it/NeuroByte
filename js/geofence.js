import { haversineMeters } from './geo.js';

export const STATE = Object.freeze({ SAFE: 'SAFE', BREACH: 'BREACH', SOS: 'SOS' });
export const RADIUS_MIN_M = 50;
export const RADIUS_MAX_M = 300;

/**
 * Determines the patient's state relative to the active safe zone.
 * SOS takes priority over a boundary breach.
 */
export function evaluate({ position, center, radiusM, sos = false }) {
  const distanceM = haversineMeters(position, center);
  const outside = distanceM > radiusM;
  let state = STATE.SAFE;
  if (sos) state = STATE.SOS;
  else if (outside) state = STATE.BREACH;
  return { state, distanceM, outside, marginM: radiusM - distanceM };
}
