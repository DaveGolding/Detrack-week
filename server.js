const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const os = require('os');
const { Bonjour } = require('bonjour-service');
require('dotenv').config();

const API_KEY = process.env.DETRACK_API_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const PORT = 80;
const MDNS_HOST = 'detrack-schedule.local';

// Get LAN IP
let lanIP = '127.0.0.1';
Object.values(os.networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal).forEach(i => lanIP = i.address);

// Initialize mDNS with error handling
let mdns;
try {
  mdns = require('multicast-dns')({ interface: lanIP });
} catch (err) {
  console.error('mDNS initialization failed:', err.message);
  mdns = require('multicast-dns')();
}

// Respond directly to mDNS A record queries for detrack-schedule.local
mdns.on('query', query => {
  const match = query.questions.some(q => q.name === MDNS_HOST && (q.type === 'A' || q.type === 'ANY'));
  if (match) {
    mdns.respond({
      answers: [{ name: MDNS_HOST, type: 'A', ttl: 300, data: lanIP }]
    });
  }
});

// Geocode cache
const GEOCODE_CACHE_FILE = path.join(__dirname, 'geocode-cache.json');
let geocodeCache = {};
try {
  if (fs.existsSync(GEOCODE_CACHE_FILE)) {
    geocodeCache = JSON.parse(fs.readFileSync(GEOCODE_CACHE_FILE, 'utf8'));
  }
} catch (err) {
  console.error('Failed to load geocode cache:', err.message);
}

function saveGeocodeCache() {
  try {
    fs.writeFileSync(GEOCODE_CACHE_FILE, JSON.stringify(geocodeCache, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save geocode cache:', err.message);
  }
}

function geocodeAddress(address) {
  return new Promise((resolve) => {
    if (geocodeCache[address]) {
      return resolve(geocodeCache[address]);
    }

    const query = encodeURIComponent(address + ', Perth, Western Australia');
    const options = {
      hostname: 'maps.googleapis.com',
      path: `/maps/api/geocode/json?address=${query}&key=${GOOGLE_API_KEY}`,
      method: 'GET'
    };

    https.get(options, (apiRes) => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.status === 'OK' && result.results && result.results[0]) {
            const loc = result.results[0].geometry.location;
            const coords = { lat: loc.lat, lng: loc.lng };
            geocodeCache[address] = coords;
            saveGeocodeCache();
            console.log(`[Geocode OK] ${address}`);
            resolve(coords);
          } else {
            console.warn(`[Geocode ${result.status}] ${address}`);
            resolve(null);
          }
        } catch (e) {
          console.error('[Geocode parse error]', e.message);
          resolve(null);
        }
      });
    }).on('error', (err) => {
      console.error('[Geocode request error]', err.message);
      resolve(null);
    });
  });
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  if (parsed.pathname === '/api/job') {
    const doNum = parsed.query.do;
    if (!doNum) { res.writeHead(400); res.end('do required'); return; }

    if (req.method === 'PATCH') {
      // Update job (e.g. reschedule to a new date)
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        const options = {
          hostname: 'app.detrack.com',
          path: `/api/v2/dn/jobs/${encodeURIComponent(doNum)}`,
          method: 'PUT',
          headers: { 'X-API-KEY': API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        };
        const apiReq = https.request(options, apiRes => {
          let data = '';
          apiRes.on('data', chunk => data += chunk);
          apiRes.on('end', () => {
            res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
            res.end(data);
          });
        });
        apiReq.on('error', err => { res.writeHead(502); res.end(JSON.stringify({ error: err.message })); });
        apiReq.write(body);
        apiReq.end();
      });
      return;
    }

    // GET single job
    const options = {
      hostname: 'app.detrack.com',
      path: `/api/v2/dn/jobs/${encodeURIComponent(doNum)}`,
      headers: { 'X-API-KEY': API_KEY, 'Content-Type': 'application/json' }
    };
    https.get(options, apiRes => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => {
        res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
        res.end(data);
      });
    }).on('error', err => {
      res.writeHead(502); res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  if (parsed.pathname === '/api/jobs') {
    const date = parsed.query.date;
    if (!date) { res.writeHead(400); res.end('date required'); return; }
    const options = {
      hostname: 'app.detrack.com',
      path: `/api/v2/dn/jobs?date=${date}&page_size=200`,
      headers: { 'X-API-KEY': API_KEY, 'Content-Type': 'application/json' }
    };
    https.get(options, apiRes => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', async () => {
        try {
          const jobData = JSON.parse(data);
          if (jobData.data && Array.isArray(jobData.data)) {
            const geocodingPromises = jobData.data.map(async (job) => {
              if (job.address && (!job.address_lat || !job.address_lng)) {
                const coords = await geocodeAddress(job.address);
                if (coords) {
                  job.address_lat = coords.lat;
                  job.address_lng = coords.lng;
                }
              }
            });
            await Promise.all(geocodingPromises);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(jobData));
        } catch (err) {
          res.writeHead(502); res.end(JSON.stringify({ error: err.message }));
        }
      });
    }).on('error', err => {
      res.writeHead(502); res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  if (parsed.pathname === '/api/vehicles') {
    const options = {
      hostname: 'app.detrack.com',
      path: '/api/v2/vehicles',
      headers: { 'X-API-KEY': API_KEY, 'Content-Type': 'application/json' }
    };
    https.get(options, apiRes => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => {
        res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
        res.end(data);
      });
    }).on('error', err => {
      res.writeHead(502); res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  // Vehicle tracking API endpoints
  if (parsed.pathname === '/api/tracking/vehicles') {
    try {
      const db = new (require('better-sqlite3'))(path.join(__dirname, 'data', 'database.db'));
      const vehicles = db.prepare(`
        SELECT
          v.id, v.vehicle_id, v.registration, v.vehicle_type, v.driver_name, v.active,
          (SELECT latitude FROM vehicle_positions WHERE vehicle_id = v.id ORDER BY timestamp DESC LIMIT 1) as latest_latitude,
          (SELECT longitude FROM vehicle_positions WHERE vehicle_id = v.id ORDER BY timestamp DESC LIMIT 1) as latest_longitude,
          (SELECT timestamp FROM vehicle_positions WHERE vehicle_id = v.id ORDER BY timestamp DESC LIMIT 1) as latest_timestamp,
          (SELECT speed_kmh FROM vehicle_positions WHERE vehicle_id = v.id ORDER BY timestamp DESC LIMIT 1) as latest_speed
        FROM vehicles ORDER BY v.registration
      `).all();
      db.close();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(vehicles));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (parsed.pathname.startsWith('/api/tracking/vehicles/') && parsed.pathname.endsWith('/positions')) {
    try {
      const vehicleId = parseInt(parsed.pathname.split('/')[4]);
      const hours = parseInt(parsed.query.hours) || 24;
      const db = new (require('better-sqlite3'))(path.join(__dirname, 'data', 'database.db'));
      const positions = db.prepare(`
        SELECT id, vehicle_id, latitude, longitude, accuracy_meters, timestamp, speed_kmh, heading, deetrack_job_id
        FROM vehicle_positions
        WHERE vehicle_id = ? AND timestamp > datetime('now', '-' || ? || ' hours')
        ORDER BY timestamp DESC LIMIT 500
      `).all(vehicleId, hours);
      db.close();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(positions));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (parsed.pathname.startsWith('/api/tracking/vehicles/') && parsed.pathname.endsWith('/stops')) {
    try {
      const vehicleId = parseInt(parsed.pathname.split('/')[4]);
      const date = parsed.query.date || new Date().toISOString().split('T')[0];
      const db = new (require('better-sqlite3'))(path.join(__dirname, 'data', 'database.db'));
      const stops = db.prepare(`
        SELECT vs.id, vs.vehicle_id, vs.job_location_id, vs.arrival_time, vs.departure_time, vs.duration_minutes, vs.status, vs.deetrack_job_id,
               jl.address, jl.latitude, jl.longitude, jl.job_type
        FROM vehicle_stops vs
        LEFT JOIN job_locations jl ON vs.job_location_id = jl.id
        WHERE vs.vehicle_id = ? AND date(vs.arrival_time) = ?
        ORDER BY vs.arrival_time
      `).all(vehicleId, date);
      db.close();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stops));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (parsed.pathname.startsWith('/api/tracking/vehicles/') && parsed.pathname.endsWith('/metrics')) {
    try {
      const vehicleId = parseInt(parsed.pathname.split('/')[4]);
      const dateFrom = parsed.query.from || new Date(Date.now() - 30*24*60*60*1000).toISOString().split('T')[0];
      const dateTo = parsed.query.to || new Date().toISOString().split('T')[0];
      const db = new (require('better-sqlite3'))(path.join(__dirname, 'data', 'database.db'));
      const metrics = db.prepare(`
        SELECT id, vehicle_id, date, jobs_completed, total_stop_time_minutes, total_travel_time_minutes, total_distance_km,
               average_stop_duration_minutes, on_time_jobs, late_jobs, utilization_percent, idle_time_minutes, return_to_depot_time
        FROM vehicle_daily_metrics
        WHERE vehicle_id = ? AND date BETWEEN ? AND ?
        ORDER BY date DESC
      `).all(vehicleId, dateFrom, dateTo);
      db.close();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(metrics));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Manual trigger: detect stops
  if (parsed.pathname === '/api/analytics/detect-stops') {
    try {
      const Scheduler = require('./lib/scheduler');
      const dbPath = path.join(__dirname, 'data', 'database.db');
      const scheduler = new Scheduler(dbPath);
      scheduler.detectStops().then(count => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, stops_detected: count }));
      });
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Manual trigger: calculate daily metrics
  if (parsed.pathname === '/api/analytics/calculate-metrics') {
    try {
      const Scheduler = require('./lib/scheduler');
      const dbPath = path.join(__dirname, 'data', 'database.db');
      const scheduler = new Scheduler(dbPath);
      scheduler.calculateDailyMetrics().then(count => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, vehicles_calculated: count }));
      });
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Report API endpoints
  if (parsed.pathname === '/api/reports/generate') {
    try {
      const vehicleId = parseInt(parsed.query.vehicle_id);
      const dateFrom = parsed.query.from;
      const dateTo = parsed.query.to;
      const format = parsed.query.format || 'csv'; // csv or html

      if (!vehicleId || !dateFrom || !dateTo) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing parameters: vehicle_id, from, to' }));
        return;
      }

      const ReportGenerator = require('./lib/report-generator');
      const dbPath = path.join(__dirname, 'data', 'database.db');
      const generator = new ReportGenerator(dbPath);

      let report;
      if (format === 'html') {
        report = generator.generateHTML(vehicleId, dateFrom, dateTo);
      } else {
        report = generator.generateCSV(vehicleId, dateFrom, dateTo);
      }

      if (!report) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No data found for this vehicle and date range' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(report));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (parsed.pathname === '/api/reports/list') {
    try {
      const ReportGenerator = require('./lib/report-generator');
      const dbPath = path.join(__dirname, 'data', 'database.db');
      const generator = new ReportGenerator(dbPath);
      const reports = generator.listReports();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reports));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Serve generated reports
  if (parsed.pathname.startsWith('/reports/')) {
    const filename = path.basename(parsed.pathname);
    const filepath = path.join(__dirname, 'data', 'reports', filename);

    // Safety check
    if (!filepath.startsWith(path.join(__dirname, 'data', 'reports'))) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.readFile(filepath, 'utf8', (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      const contentType = filename.endsWith('.csv') ? 'text/csv' : 'text/html; charset=utf-8';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}"`
      });
      res.end(data);
    });
    return;
  }

  const filePath = path.join(__dirname, 'detrack-weekly-board.html');
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const html = data.replace('API_KEY_PLACEHOLDER', GOOGLE_API_KEY);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
});

server.on('error', err => {
  console.error('Server error:', err.message);
  if (err.code === 'EACCES') console.error('Port 80 requires administrator privileges');
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`DeTrack Weekly Board: http://localhost:${PORT}`);
  Object.values(os.networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal)
    .forEach(i => console.log(`Network:            http://${i.address}:${PORT}`));
  try {
    const bonjour = new Bonjour();
    bonjour.publish({ name: 'DeTrack Schedule', type: 'http', port: PORT, host: MDNS_HOST });
    console.log(`Bonjour: advertising as ${MDNS_HOST} → ${lanIP}`);
  } catch (err) {
    console.error('Bonjour error:', err.message);
  }

  // Start vehicle position poller (every 5 minutes)
  if (API_KEY) {
    const { pollOnce } = require('./vehicle-poller');
    console.log('[vehicle-poller] Starting — polling every 5 minutes');
    pollOnce().catch(err => console.error('[vehicle-poller] Initial poll failed:', err.message));
    setInterval(() => {
      pollOnce().catch(err => console.error('[vehicle-poller] Poll failed:', err.message));
    }, 5 * 60 * 1000);
  } else {
    console.log('[vehicle-poller] Skipped — DETRACK_API_KEY not set');
  }

  // Start analytics schedulers (stop detection + metrics calculation)
  try {
    const Scheduler = require('./lib/scheduler');
    const dbPath = path.join(__dirname, 'data', 'database.db');
    const scheduler = new Scheduler(dbPath);
    scheduler.start();
  } catch (err) {
    console.error('[scheduler] Failed to start:', err.message);
  }
});

process.on('uncaughtException', err => {
  console.error('Uncaught exception:', err.message);
  process.exit(1);
});
