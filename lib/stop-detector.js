const Database = require('better-sqlite3');
const path = require('path');

class StopDetector {
  constructor(dbPath) {
    this.dbPath = dbPath;
  }

  detect(vehicleId, positions) {
    if (!positions || positions.length < 2) return [];

    const stops = [];
    let currentStop = null;

    // Sort positions by timestamp
    const sorted = [...positions].sort((a, b) =>
      new Date(a.timestamp) - new Date(b.timestamp)
    );

    for (let i = 0; i < sorted.length; i++) {
      const pos = sorted[i];
      const speed = pos.speed_kmh || 0;

      // Start a new stop if speed is low and we're not in a stop
      if (speed < 5 && !currentStop) {
        currentStop = {
          arrival_time: pos.timestamp,
          positions: [pos]
        };
      } else if (speed < 5 && currentStop) {
        // Continue current stop
        currentStop.positions.push(pos);
      } else if (speed >= 5 && currentStop) {
        // End current stop
        if (currentStop.positions.length >= 2) {
          // Minimum 2 positions = at least one measurement period
          const cluster = this._clusterPositions(currentStop.positions);
          if (cluster) {
            stops.push({
              vehicle_id: vehicleId,
              arrival_time: currentStop.arrival_time,
              departure_time: pos.timestamp,
              latitude: cluster.lat,
              longitude: cluster.lng,
              duration_minutes: this._calculateDuration(currentStop.arrival_time, pos.timestamp),
              accuracy_meters: Math.max(...currentStop.positions.map(p => p.accuracy_meters || 50)),
              deetrack_job_id: currentStop.positions[0].deetrack_job_id
            });
          }
        }
        currentStop = null;
      }
    }

    // Handle last stop if vehicle is still stopped
    if (currentStop && currentStop.positions.length >= 2) {
      const cluster = this._clusterPositions(currentStop.positions);
      if (cluster) {
        stops.push({
          vehicle_id: vehicleId,
          arrival_time: currentStop.arrival_time,
          departure_time: null, // Still stopped
          latitude: cluster.lat,
          longitude: cluster.lng,
          duration_minutes: this._calculateDuration(
            currentStop.arrival_time,
            currentStop.positions[currentStop.positions.length - 1].timestamp
          ),
          accuracy_meters: Math.max(...currentStop.positions.map(p => p.accuracy_meters || 50)),
          deetrack_job_id: currentStop.positions[0].deetrack_job_id,
          status: 'active'
        });
      }
    }

    return stops;
  }

  _clusterPositions(positions) {
    if (!positions || positions.length === 0) return null;

    // Calculate average latitude/longitude
    const avgLat = positions.reduce((sum, p) => sum + p.latitude, 0) / positions.length;
    const avgLng = positions.reduce((sum, p) => sum + p.longitude, 0) / positions.length;

    // Check if all positions are within 50m of center
    const maxDist = Math.max(...positions.map(p => this._gpsDistance(
      avgLat, avgLng, p.latitude, p.longitude
    )));

    if (maxDist <= 50) {
      return { lat: avgLat, lng: avgLng, spread_m: maxDist };
    }

    return null;
  }

  _gpsDistance(lat1, lon1, lat2, lon2) {
    // Simplified distance calculation (good enough for 50m accuracy)
    const dLat = (lat2 - lat1) * 111000; // 1 degree = ~111km
    const dLon = (lon2 - lon1) * 111000 * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
    return Math.sqrt(dLat * dLat + dLon * dLon);
  }

  _calculateDuration(startTime, endTime) {
    const start = new Date(startTime);
    const end = new Date(endTime);
    return Math.round((end - start) / 60000); // Convert to minutes
  }

  // Link stops to job locations
  linkToJobs(stops) {
    try {
      const db = new Database(this.dbPath);
      const getJobLocation = db.prepare(`
        SELECT id FROM job_locations
        WHERE latitude IS NOT NULL AND longitude IS NOT NULL
        ORDER BY id
      `);

      const linkedStops = stops.map(stop => {
        if (stop.deetrack_job_id) {
          const jobLoc = db.prepare('SELECT id FROM job_locations WHERE deetrack_job_id = ?').get(stop.deetrack_job_id);
          if (jobLoc) {
            stop.job_location_id = jobLoc.id;
            stop.status = 'completed';
          }
        }

        // If no job_id match, try geolocation match
        if (!stop.job_location_id && stop.latitude && stop.longitude) {
          const nearby = db.prepare(`
            SELECT id, latitude, longitude FROM job_locations
            WHERE latitude IS NOT NULL AND longitude IS NOT NULL
          `).all();

          for (const job of nearby) {
            const dist = this._gpsDistance(stop.latitude, stop.longitude, job.latitude, job.longitude);
            if (dist < 100) { // Within 100m
              stop.job_location_id = job.id;
              stop.status = 'completed';
              break;
            }
          }
        }

        return stop;
      });

      db.close();
      return linkedStops;
    } catch (err) {
      console.error('[stop-detector] Error linking to jobs:', err.message);
      return stops;
    }
  }
}

module.exports = StopDetector;
