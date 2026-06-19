const Database = require('better-sqlite3');
const path = require('path');
const StopDetector = require('./stop-detector');
const MetricsCalculator = require('./metrics-calculator');

class Scheduler {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.stopDetector = new StopDetector(dbPath);
    this.metricsCalc = new MetricsCalculator(dbPath);
  }

  // Run stop detection for all vehicles (hourly)
  async detectStops() {
    try {
      console.log('[scheduler] Running stop detection...');
      const db = new Database(this.dbPath);

      // Get all vehicles with positions
      const vehicles = db.prepare(`
        SELECT DISTINCT v.id, v.vehicle_id
        FROM vehicles v
        JOIN vehicle_positions vp ON v.id = vp.vehicle_id
        WHERE v.active = 1
      `).all();

      let stopsDetected = 0;

      for (const vehicle of vehicles) {
        try {
          // Get positions from last 24 hours that don't have a corresponding stop
          const positions = db.prepare(`
            SELECT id, latitude, longitude, accuracy_meters, timestamp, speed_kmh, deetrack_job_id
            FROM vehicle_positions
            WHERE vehicle_id = ? AND timestamp > datetime('now', '-24 hours')
            ORDER BY timestamp
          `).all(vehicle.id);

          if (positions.length < 2) continue;

          // Detect stops
          const stops = this.stopDetector.detect(vehicle.id, positions);
          if (stops.length === 0) continue;

          // Link to job locations
          const linkedStops = this.stopDetector.linkToJobs(stops);

          // Store stops that don't already exist
          const insertStop = db.prepare(`
            INSERT OR IGNORE INTO vehicle_stops(
              vehicle_id, job_location_id, arrival_time, departure_time,
              duration_minutes, distance_to_location_m, status, deetrack_job_id
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
          `);

          for (const stop of linkedStops) {
            try {
              insertStop.run(
                stop.vehicle_id,
                stop.job_location_id || null,
                stop.arrival_time,
                stop.departure_time,
                stop.duration_minutes,
                stop.accuracy_meters || null,
                stop.status || 'active',
                stop.deetrack_job_id || null
              );
              stopsDetected++;
            } catch (e) {
              // Duplicate or constraint error - ignore
            }
          }
        } catch (err) {
          console.error(`[scheduler] Error detecting stops for vehicle ${vehicle.vehicle_id}:`, err.message);
        }
      }

      db.close();
      console.log(`[scheduler] ✓ Stop detection complete - ${stopsDetected} stops found`);
      return stopsDetected;
    } catch (err) {
      console.error('[scheduler] Stop detection failed:', err.message);
      return 0;
    }
  }

  // Calculate daily metrics for all vehicles (daily at 2 AM)
  async calculateDailyMetrics() {
    try {
      console.log('[scheduler] Calculating daily metrics...');
      const db = new Database(this.dbPath);

      // Get yesterday's date
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const dateStr = yesterday.toISOString().split('T')[0];

      const vehicles = db.prepare('SELECT id FROM vehicles WHERE active = 1').all();

      let calculated = 0;
      for (const vehicle of vehicles) {
        const result = this.metricsCalc.calculateDailyMetrics(vehicle.id, dateStr);
        if (result) calculated++;
      }

      db.close();
      console.log(`[scheduler] ✓ Metrics calculated for ${calculated} vehicles on ${dateStr}`);
      return calculated;
    } catch (err) {
      console.error('[scheduler] Metrics calculation failed:', err.message);
      return 0;
    }
  }

  // Schedule stop detection to run hourly
  scheduleStopDetection() {
    console.log('[scheduler] Stop detection scheduled (hourly)');

    // Run immediately
    this.detectStops().catch(err => console.error('[scheduler] Initial stop detection failed:', err));

    // Then every hour
    setInterval(() => {
      this.detectStops().catch(err => console.error('[scheduler] Stop detection failed:', err));
    }, 60 * 60 * 1000); // 1 hour
  }

  // Schedule metrics calculation to run daily at 2 AM
  scheduleDailyMetrics() {
    console.log('[scheduler] Daily metrics scheduled (2:00 AM)');

    const scheduleNextRun = () => {
      const now = new Date();
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const nextRun = new Date(tomorrow);
      nextRun.setHours(2, 0, 0, 0);

      const msUntilRun = nextRun.getTime() - now.getTime();

      setTimeout(() => {
        this.calculateDailyMetrics().catch(err => console.error('[scheduler] Daily metrics failed:', err));
        scheduleNextRun(); // Schedule next day
      }, msUntilRun);
    };

    scheduleNextRun();
  }

  // Start all schedulers
  start() {
    this.scheduleStopDetection();
    this.scheduleDailyMetrics();
    console.log('[scheduler] All schedulers started');
  }
}

module.exports = Scheduler;
