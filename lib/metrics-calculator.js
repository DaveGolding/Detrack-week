const Database = require('better-sqlite3');
const path = require('path');

class MetricsCalculator {
  constructor(dbPath) {
    this.dbPath = dbPath;
  }

  // Calculate daily metrics for a vehicle on a specific date
  calculateDailyMetrics(vehicleId, date) {
    try {
      const db = new Database(this.dbPath);

      // Get all stops for this vehicle on this date
      const stops = db.prepare(`
        SELECT id, arrival_time, departure_time, duration_minutes, status
        FROM vehicle_stops
        WHERE vehicle_id = ? AND date(arrival_time) = ?
        ORDER BY arrival_time
      `).all(vehicleId, date);

      // Get positions for this vehicle on this date
      const positions = db.prepare(`
        SELECT latitude, longitude, timestamp
        FROM vehicle_positions
        WHERE vehicle_id = ? AND date(timestamp) = ?
        ORDER BY timestamp
      `).all(vehicleId, date);

      if (stops.length === 0 && positions.length === 0) {
        db.close();
        return null; // No activity this day
      }

      // Calculate metrics
      const metrics = {
        vehicle_id: vehicleId,
        date: date,
        jobs_completed: stops.filter(s => s.status === 'completed').length,
        total_stop_time_minutes: stops.reduce((sum, s) => sum + (s.duration_minutes || 0), 0),
        total_travel_time_minutes: this._calculateTravelTime(stops),
        total_distance_km: this._calculateDistance(positions),
        average_stop_duration_minutes: stops.length > 0
          ? Math.round(stops.reduce((sum, s) => sum + (s.duration_minutes || 0), 0) / stops.length)
          : 0,
        on_time_jobs: this._countOnTimeJobs(db, stops),
        late_jobs: this._countLateJobs(db, stops),
        idle_time_minutes: this._calculateIdleTime(stops),
        return_to_depot_time: this._getReturnToDepotTime(positions),
        utilization_percent: this._calculateUtilization(stops)
      };

      // Store or update metrics
      db.prepare(`
        INSERT INTO vehicle_daily_metrics(
          vehicle_id, date, jobs_completed, total_stop_time_minutes, total_travel_time_minutes,
          total_distance_km, average_stop_duration_minutes, on_time_jobs, late_jobs,
          utilization_percent, idle_time_minutes, return_to_depot_time
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(vehicle_id, date) DO UPDATE SET
          jobs_completed=excluded.jobs_completed,
          total_stop_time_minutes=excluded.total_stop_time_minutes,
          total_travel_time_minutes=excluded.total_travel_time_minutes,
          total_distance_km=excluded.total_distance_km,
          average_stop_duration_minutes=excluded.average_stop_duration_minutes,
          on_time_jobs=excluded.on_time_jobs,
          late_jobs=excluded.late_jobs,
          utilization_percent=excluded.utilization_percent,
          idle_time_minutes=excluded.idle_time_minutes,
          return_to_depot_time=excluded.return_to_depot_time
      `).run(
        metrics.vehicle_id, metrics.date, metrics.jobs_completed, metrics.total_stop_time_minutes,
        metrics.total_travel_time_minutes, metrics.total_distance_km, metrics.average_stop_duration_minutes,
        metrics.on_time_jobs, metrics.late_jobs, metrics.utilization_percent, metrics.idle_time_minutes,
        metrics.return_to_depot_time
      );

      db.close();
      return metrics;
    } catch (err) {
      console.error('[metrics-calculator] Error:', err.message);
      return null;
    }
  }

  _calculateTravelTime(stops) {
    let totalTravel = 0;
    for (let i = 0; i < stops.length - 1; i++) {
      const departTime = new Date(stops[i].departure_time || stops[i].arrival_time);
      const arriveTime = new Date(stops[i + 1].arrival_time);
      totalTravel += (arriveTime - departTime) / 60000; // Convert to minutes
    }
    return Math.round(totalTravel);
  }

  _calculateDistance(positions) {
    if (positions.length < 2) return 0;

    let totalDistance = 0;
    for (let i = 0; i < positions.length - 1; i++) {
      const dist = this._gpsDistance(
        positions[i].latitude, positions[i].longitude,
        positions[i + 1].latitude, positions[i + 1].longitude
      );
      totalDistance += dist;
    }

    return Math.round(totalDistance * 1000) / 1000; // Convert m to km, round to 3 decimals
  }

  _gpsDistance(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * 111000;
    const dLon = (lon2 - lon1) * 111000 * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
    return Math.sqrt(dLat * dLat + dLon * dLon) / 1000; // Return in km
  }

  _countOnTimeJobs(db, stops) {
    // Count stops where departure was before scheduled end time
    let onTime = 0;
    for (const stop of stops) {
      if (!stop.departure_time) continue;

      const job = db.prepare(`
        SELECT scheduled_end FROM job_locations jl
        JOIN vehicle_stops vs ON vs.job_location_id = jl.id
        WHERE vs.id = ?
      `).get(stop.id);

      if (job && job.scheduled_end) {
        const departTime = new Date(stop.departure_time);
        const scheduledEnd = new Date(job.scheduled_end);
        if (departTime <= scheduledEnd) onTime++;
      }
    }
    return onTime;
  }

  _countLateJobs(db, stops) {
    return stops.filter(s => {
      if (!s.departure_time) return false;
      const job = db.prepare(`
        SELECT scheduled_end FROM job_locations jl
        JOIN vehicle_stops vs ON vs.job_location_id = jl.id
        WHERE vs.id = ?
      `).get(s.id);
      if (job && job.scheduled_end) {
        return new Date(s.departure_time) > new Date(job.scheduled_end);
      }
      return false;
    }).length;
  }

  _calculateIdleTime(stops) {
    // Time parked but not on a job (gaps between stops)
    let idleTime = 0;
    for (let i = 0; i < stops.length - 1; i++) {
      const departTime = new Date(stops[i].departure_time || stops[i].arrival_time);
      const nextArrive = new Date(stops[i + 1].arrival_time);
      const gap = (nextArrive - departTime) / 60000;
      // Assume 30 min per stop + 5 min min travel
      const expectedTravel = 5;
      if (gap > expectedTravel) {
        idleTime += gap - expectedTravel;
      }
    }
    return Math.round(idleTime);
  }

  _calculateUtilization(stops) {
    if (stops.length === 0) return 0;

    const firstArrival = new Date(stops[0].arrival_time);
    const lastStop = stops[stops.length - 1];
    const lastDepart = new Date(lastStop.departure_time || lastStop.arrival_time);

    const dayLength = (lastDepart - firstArrival) / 60000; // minutes
    if (dayLength === 0) return 0;

    const totalStop = stops.reduce((sum, s) => sum + (s.duration_minutes || 0), 0);
    const utilization = (totalStop / dayLength) * 100;

    return Math.round(utilization);
  }

  _getReturnToDepotTime(positions) {
    // Simplified: assume last position is return to depot
    if (positions.length === 0) return null;
    return positions[positions.length - 1].timestamp;
  }

  // Batch calculate metrics for all vehicles on a date
  calculateAllDailyMetrics(date) {
    try {
      const db = new Database(this.dbPath);
      const vehicles = db.prepare('SELECT id FROM vehicles WHERE active = 1').all();

      let calculated = 0;
      for (const vehicle of vehicles) {
        const result = this.calculateDailyMetrics(vehicle.id, date);
        if (result) calculated++;
      }

      db.close();
      return { calculated, date };
    } catch (err) {
      console.error('[metrics-calculator] Batch error:', err.message);
      return null;
    }
  }
}

module.exports = MetricsCalculator;
