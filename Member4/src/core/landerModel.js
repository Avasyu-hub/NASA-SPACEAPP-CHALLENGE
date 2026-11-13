/**
 * Lander State-of-Charge & Communications Link Model.
 * Simulates discrete hourly battery charge/discharge and communications line-of-sight.
 * 
 * Note: Clearly framed as a mission scenario model with user-configurable parameters,
 * not official NASA spacecraft specifications.
 */

export class LanderModel {
  constructor(params = {}) {
    this.capacityWh = params.capacityWh || 1500;  // Battery capacity (Wh)
    this.solarW = params.solarW || 250;          // Solar array peak generation (W)
    this.loadW = params.loadW || 80;             // Base avionics & thermal load (W)
    this.initialSoC = params.initialSoC || 1500; // Starting charge (Wh)
  }

  /**
   * Evaluates the full time series of lander states across an hourly mission window.
   * 
   * @param {Uint8Array|Array} sunLit - Array of 0/1 binary flags
   * @param {Uint8Array|Array} earthVis - Array of 0/1 binary flags
   * @returns {object} Full evaluation trace with depletion timestamps and margins
   */
  simulateMission(sunLit, earthVis) {
    const totalHours = sunLit.length;
    const socArray = new Float32Array(totalHours);
    const socPctArray = new Float32Array(totalHours);
    const commStateArray = new Uint8Array(totalHours);

    let currentSoC = this.initialSoC;
    let longestNight = 0;
    let currentNight = 0;
    let longestCommGap = 0;
    let currentCommGap = 0;
    let firstDepletionHour = -1;

    for (let h = 0; h < totalHours; h++) {
      const isLit = sunLit[h] === 1;
      const isComm = earthVis[h] === 1;

      // Power balance
      const powerIn = isLit ? this.solarW : 0;
      const powerOut = this.loadW;
      const deltaWh = powerIn - powerOut;

      currentSoC = Math.max(0, Math.min(this.capacityWh, currentSoC + deltaWh));
      socArray[h] = currentSoC;
      socPctArray[h] = (currentSoC / this.capacityWh) * 100.0;

      if (currentSoC <= 0 && firstDepletionHour === -1) {
        firstDepletionHour = h;
      }

      // Night duration tracker
      if (!isLit) {
        currentNight++;
        if (currentNight > longestNight) longestNight = currentNight;
      } else {
        currentNight = 0;
      }

      // Comms gap tracker
      if (!isComm) {
        currentCommGap++;
        if (currentCommGap > longestCommGap) longestCommGap = currentCommGap;
        commStateArray[h] = 0; // DOWN
      } else {
        currentCommGap = 0;
        commStateArray[h] = 1; // UP
      }
    }

    return {
      socArray,
      socPctArray,
      commStateArray,
      longestNightHours: longestNight,
      longestCommGapHours: longestCommGap,
      firstDepletionHour,
      hasDepleted: firstDepletionHour !== -1,
    };
  }

  /**
   * Fast instantaneous state query at a specific hour
   */
  getStateAtHour(hourIndex, sunLit, earthVis) {
    // If not simulating entire trace, evaluate up to hourIndex
    let soc = this.initialSoC;
    for (let h = 0; h <= hourIndex && h < sunLit.length; h++) {
      const powerIn = sunLit[h] === 1 ? this.solarW : 0;
      soc = Math.max(0, Math.min(this.capacityWh, soc + (powerIn - this.loadW)));
    }

    const isComm = earthVis[hourIndex] === 1;

    return {
      hour: hourIndex,
      socWh: Math.round(soc),
      socPct: Math.round((soc / this.capacityWh) * 100),
      isCharging: sunLit[hourIndex] === 1,
      commStatus: isComm ? 'ONLINE' : 'DISRUPTED',
      isDepleted: soc <= 0,
    };
  }
}
