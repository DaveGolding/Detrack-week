const Database = require('better-sqlite3');
const path = require('path');
const DeetrackClient = require('./lib/deetrack-client');

const DB_PATH = path.join(__dirname, 'data', 'database.db');
const API_KEY = process.env.DETRACK_API_KEY;

if (!API_KEY) {
  console.error('[vehicle-poller] ERROR: DETRACK_API_KEY not set in environment');
  process.exit(1);
}

const client = new DeetrackClient(API_KEY);
let db;

function initDb() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
}

async function pollOnce() {
  try {
    initDb();

    console.log(`[vehicle-poller] Polling Deetrack at ${new Date().toISOString()}`);

    // Fetch all vehicles
    const vehiclesResp = await client.getVehicles();
    if (!vehiclesResp.data || !Array.isArray(vehiclesResp.data)) {
      console.warn('[vehicle-poller] No vehicles returned from API');
      return;
    }

    const vehicleCount = vehiclesResp.data.length;
    console.log(`[vehicle-poller] Found ${vehicleCount} vehicles`);

    // Store/update vehicles in database
    const upsertVehicle = db.prepare(`
      INSERT INTO vehicles(vehicle_id, registration, vehicle_type, active, updated_at)
      VALUES(?, ?, ?, 1, datetime('now'))
      ON CONFLICT(vehicle_id) DO UPDATE SET
        registration=excluded.registration,
        vehicle_type=excluded.vehicle_type,
        active=1,
        updated_at=datetime('now')
    `);

    let newVehicles = 0;
    let positionsStored = 0;

    for (const veh of vehiclesResp.data) {
      try {
        const vehId = veh.vehicle_id || veh.id;
        if (!vehId) continue;

        // Upsert vehicle
        const result = upsertVehicle.run(vehId, veh.registration || null, veh.vehicle_type || null);
        if (result.changes > 0 && !db.prepare('SELECT id FROM vehicles WHERE vehicle_id = ? LIMIT 1').get(vehId)) {
          newVehicles++;
        }

        // Get vehicle's local database ID
        const vehRecord = db.prepare('SELECT id FROM vehicles WHERE vehicle_id = ?').get(vehId);
        if (!vehRecord) continue;

        const vehDbId = vehRecord.id;

        // Store position if available
        if (veh.latitude && veh.longitude) {
          const lastPos = db.prepare(`
            SELECT latitude, longitude FROM vehicle_positions
            WHERE vehicle_id = ?
            ORDER BY timestamp DESC LIMIT 1
          `).get(vehDbId);

          // Check if position has moved significantly (>10m threshold)
          const hasMoved = !lastPos ||
            (Math.abs(veh.latitude - lastPos.latitude) > 0.0001 ||
             Math.abs(veh.longitude - lastPos.longitude) > 0.0001);

          if (hasMoved) {
            db.prepare(`
              INSERT INTO vehicle_positions(vehicle_id, latitude, longitude, accuracy_meters, timestamp, speed_kmh, heading, deetrack_job_id)
              VALUES(?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              vehDbId,
              veh.latitude,
              veh.longitude,
              veh.accuracy_meters || null,
              veh.timestamp || new Date().toISOString(),
              veh.speed_kmh || null,
              veh.heading || null,
              veh.current_job_id || null
            );
            positionsStored++;
          }
        }
      } catch (e) {
        console.error(`[vehicle-poller] Error processing vehicle ${veh.vehicle_id}:`, e.message);
      }
    }

    console.log(`[vehicle-poller] ✓ Stored ${positionsStored} positions (${newVehicles} new vehicles)`);

    // Fetch today's jobs for job location mapping
    const today = new Date().toISOString().split('T')[0];
    const jobsResp = await client.getJobs(today);
    if (jobsResp.data && Array.isArray(jobsResp.data)) {
      const upsertJobLocation = db.prepare(`
        INSERT INTO job_locations(deetrack_job_id, address, latitude, longitude, job_type, scheduled_start, scheduled_end)
        VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(deetrack_job_id) DO UPDATE SET
          address=excluded.address,
          latitude=excluded.latitude,
          longitude=excluded.longitude
      `);

      let jobsStored = 0;
      for (const job of jobsResp.data) {
        try {
          const jobId = job.delivery_order_number || job.id;
          if (!jobId) continue;

          upsertJobLocation.run(
            jobId,
            job.address || null,
            job.address_lat || null,
            job.address_lng || null,
            job.job_type || 'Delivery',
            job.scheduled_start || null,
            job.scheduled_end || null
          );
          jobsStored++;
        } catch (e) {
          console.error(`[vehicle-poller] Error processing job:`, e.message);
        }
      }
      console.log(`[vehicle-poller] ✓ Stored ${jobsStored} job locations`);
    }

  } catch (error) {
    console.error('[vehicle-poller] Error:', error.message);
  } finally {
    if (db) db.close();
  }
}

// Export for use in server.js
module.exports = { pollOnce };

// Run if called directly
if (require.main === module) {
  pollOnce().then(() => {
    console.log('[vehicle-poller] Poll complete');
    process.exit(0);
  }).catch(err => {
    console.error('[vehicle-poller] Fatal error:', err);
    process.exit(1);
  });
}
