import { bearingDeg, destination, haversineMeters } from './geo.js';

const WALK_SPEED_MPS = 1.2;
const GPS_NOISE_M = 1.5;
const BATTERY_DRAIN_PER_S = 0.01;
const WANDER_RANGE_FACTOR = 0.8;
const PAUSE_MIN_S = 3;
const PAUSE_RANGE_S = 4;

/**
 * Simulated patient. Produces a coordinate feed by steering a position
 * vector toward a target (bearing + distance) at a given speed.
 */
export class PatientSimulator {
  constructor(start) {
    this.base = { ...start };
    this.position = { ...start };
    this.target = null;
    this.speed = WALK_SPEED_MPS;
    this.battery = 100;
    this.sos = false;
    this.pauseS = 0;
  }

  setPosition(point) {
    this.base = { lat: point.lat, lng: point.lng };
    this.position = { ...this.base };
    this.target = null;
  }

  moveTo(point, speedMps = WALK_SPEED_MPS) {
    this.target = { lat: point.lat, lng: point.lng };
    this.speed = speedMps;
  }

  step(dt, center, radiusM, wander) {
    if (wander && !this.target) {
      this.pauseS -= dt;
      if (this.pauseS <= 0) {
        this._pickWanderTarget(center, radiusM);
        this.speed = WALK_SPEED_MPS;
      }
    }

    if (this.target) {
      const remainingM = haversineMeters(this.base, this.target);
      const stepM = this.speed * dt;
      if (remainingM <= stepM) {
        this.base = { ...this.target };
        this.target = null;
        this.pauseS = PAUSE_MIN_S + Math.random() * PAUSE_RANGE_S;
      } else {
        this.base = destination(this.base, bearingDeg(this.base, this.target), stepM);
      }
    }

    this.battery = Math.max(0, this.battery - BATTERY_DRAIN_PER_S * dt);
    this.position = this._withNoise(this.base);
  }

  _pickWanderTarget(center, radiusM) {
    const distance = Math.sqrt(Math.random()) * radiusM * WANDER_RANGE_FACTOR;
    this.target = destination(center, Math.random() * 360, distance);
  }

  _withNoise(point) {
    return destination(point, Math.random() * 360, Math.random() * GPS_NOISE_M);
  }
}
