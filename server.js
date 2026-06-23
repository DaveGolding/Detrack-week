const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const os = require('os');
const { Bonjour } = require('bonjour-service');
try { require('dotenv').config(); } catch (e) { console.log('[dotenv] skipped'); }

// Load .env file directly
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [key, value] = line.trim().split('=');
    if (key && value && !process.env[key]) process.env[key] = value;
  });
}

const API_KEY = process.env.DETRACK_API_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

// Get Bearer token from .env (will be read dynamically)
function getDetrackToken() {
  return process.env.DETRACK_BEARER_TOKEN || '';
}
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
  // Get tracking route for a vehicle and date
  // Download and parse export file
  function downloadAndParse(downloadUrl, vehicle, res) {
    const https = require('https');
    const { execSync } = require('child_process');

    https.get(downloadUrl, (downloadRes) => {
      const chunks = [];
      downloadRes.on('data', chunk => chunks.push(chunk));
      downloadRes.on('end', () => {
        try {
          const tempDir = path.join(__dirname, 'data', 'export-temp-' + Date.now());
          fs.mkdirSync(tempDir, { recursive: true });
          const excelPath = path.join(tempDir, 'export.xlsx');
          fs.writeFileSync(excelPath, Buffer.concat(chunks));

          execSync(`unzip -q "${excelPath}" -d "${tempDir}/extracted"`, { stdio: 'ignore' });
          const xml = fs.readFileSync(path.join(tempDir, 'extracted', 'xl', 'worksheets', 'sheet1.xml'), 'utf8');

          const rows = [];
          const rowMatches = xml.match(/<row[^>]*>.*?<\/row>/gs) || [];
          rowMatches.forEach(rowXml => {
            const cells = [];
            const cellMatches = rowXml.match(/<c[^>]*>.*?<\/c>/g) || [];
            cellMatches.forEach(cellXml => {
              const valueMatch = cellXml.match(/<v>(.*?)<\/v>/);
              const textMatch = cellXml.match(/<t>(.*?)<\/t>/);
              const value = textMatch ? textMatch[1] : (valueMatch ? valueMatch[1] : '');
              cells.push(value);
            });
            if (cells.length > 0) rows.push(cells);
          });

          const routeData = rows.slice(1).map(row => ({
            location: row[0],
            time: row[1],
            lat: parseFloat(row[2]),
            lng: parseFloat(row[3]),
            speed: parseFloat(row[4]),
            mileage: parseFloat(row[5])
          })).filter(r => r.lat && r.lng);

          fs.writeFileSync(path.join(__dirname, 'data', 'detrack-route.json'), JSON.stringify(routeData, null, 2));
          fs.rmSync(tempDir, { recursive: true });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, points: routeData.length, vehicle: vehicle.driver_name }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to parse export: ' + e.message }));
        }
      });
    }).on('error', (e) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Download failed: ' + e.message }));
    });
  }

  // Poll export status until ready
  function pollExportStatus(exportId, maxAttempts = 30) {
    return new Promise((resolve, reject) => {
      let attempts = 0;

      function check() {
        const https = require('https');
        https.get({
          hostname: 'app.detrack.com',
          path: `/api/v2/exports/${exportId}`,
          headers: { 'Authorization': `Bearer ${getDetrackToken()}` }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const result = JSON.parse(data);
              if (result.data?.download_url) {
                resolve(result.data.download_url);
              } else if (attempts < maxAttempts) {
                attempts++;
                setTimeout(check, 1000);
              } else {
                reject(new Error('Export timeout'));
              }
            } catch (e) {
              reject(e);
            }
          });
        }).on('error', reject);
      }

      check();
    });
  }

  // Live tracking disabled
  if (parsed.pathname.startsWith('/api/tracking/')) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Live tracking feature has been disabled' }));
    return;
  }

  // Fetch fresh export from Detrack (with polling)
  if (parsed.pathname.startsWith('/api/tracking/fetch-detrack-export')) {
    console.log('[fetch-detrack-export] Handler executing for vehicle_id:', parsed.query.vehicle_id);
    try {
      const vehicleId = parseInt(parsed.query.vehicle_id);
      const date = parsed.query.date || new Date().toISOString().split('T')[0];

      if (!vehicleId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'vehicle_id required' }));
        return;
      }

      const db = new (require('better-sqlite3'))(path.join(__dirname, 'data', 'database.db'));
      const vehicle = db.prepare('SELECT vehicle_id, driver_name FROM vehicles WHERE id = ?').get(vehicleId);
      db.close();

      if (!vehicle) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Vehicle not found' }));
        return;
      }

      // Create export via Detrack API
      const https = require('https');
      const payload = JSON.stringify({
        data: {
          date: date,
          format: 'xlsx',
          document: 'vehicle-route',
          query: {
            id: vehicle.vehicle_id,
            name: vehicle.driver_name
          }
        }
      });

      const createExportOptions = {
        hostname: 'app.detrack.com',
        path: '/api/v2/exports/vehicles',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${getDetrackToken()}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      };

      const createReq = https.request(createExportOptions, (createRes) => {
        let data = '';
        createRes.on('data', chunk => data += chunk);
        createRes.on('end', () => {
          // Handle token expiry
          if (createRes.statusCode === 401) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: 'Token expired',
              message: 'Your Detrack bearer token has expired. Please get a fresh one:\n1. Go to Detrack dashboard\n2. Open F12 → Network tab\n3. Click "Download Route"\n4. Find POST /api/v2/exports/vehicles\n5. Copy the "Bearer ..." token from Authorization header\n6. Update .env DETRACK_BEARER_TOKEN with the new token\n7. Restart the server'
            }));
            return;
          }

          try {
            const exportData = JSON.parse(data);
            const exportId = exportData.data?.id;
            const downloadUrl = exportData.data?.download_url;

            console.log('[fetch-detrack-export] Export response:', { exportId, hasDownloadUrl: !!downloadUrl, status: exportData.data?.status });

            if (!exportId) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'UNIQUE_ERROR_NO_EXPORT_ID_RETURNED_FROM_DETRACK' }));
              return;
            }

            // If download_url is already available, use it directly
            if (downloadUrl) {
              console.log('[fetch-detrack-export] Download URL ready immediately');
              downloadAndParse(downloadUrl, vehicle, res);
              return;
            }

            // Otherwise poll until export is ready
            pollExportStatus(exportId).then((downloadUrl) => {
              console.log('[fetch-detrack-export] Download URL ready after polling');
              downloadAndParse(downloadUrl, vehicle, res);
            }).catch((e) => {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Export failed to complete: ' + e.message }));
            });
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to create export: ' + e.message }));
          }
        });
      });

      createReq.on('error', (e) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Export request failed: ' + e.message }));
      });

      createReq.write(payload);
      createReq.end();
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Download and parse Detrack export URL
  if (parsed.pathname.startsWith('/api/tracking/import-export')) {
    try {
      const exportUrl = parsed.query.url;
      if (!exportUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'url parameter required' }));
        return;
      }

      const https = require('https');
      const AdmZip = require('adm-zip');

      https.get(exportUrl, (response) => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          try {
            const zip = new AdmZip(Buffer.concat(chunks));
            const xml = zip.readAsText('xl/worksheets/sheet1.xml');

            // Parse XML
            const rows = [];
            const rowMatches = xml.match(/<row[^>]*>.*?<\/row>/gs) || [];
            rowMatches.forEach(rowXml => {
              const cells = [];
              const cellMatches = rowXml.match(/<c[^>]*>.*?<\/c>/g) || [];
              cellMatches.forEach(cellXml => {
                const valueMatch = cellXml.match(/<v>(.*?)<\/v>/);
                const textMatch = cellXml.match(/<t>(.*?)<\/t>/);
                const value = textMatch ? textMatch[1] : (valueMatch ? valueMatch[1] : '');
                cells.push(value);
              });
              if (cells.length > 0) rows.push(cells);
            });

            const data = rows.slice(1).map(row => ({
              location: row[0],
              time: row[1],
              lat: parseFloat(row[2]),
              lng: parseFloat(row[3]),
              speed: parseFloat(row[4]),
              mileage: parseFloat(row[5])
            })).filter(r => r.lat && r.lng);

            // Save and return
            fs.writeFileSync(path.join(__dirname, 'data', 'detrack-route.json'), JSON.stringify(data, null, 2));

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, points: data.length }));
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to parse Excel: ' + e.message }));
          }
        });
      }).on('error', (e) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to download: ' + e.message }));
      });
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (parsed.pathname.startsWith('/api/tracking/route')) {
    try {
      const vehicleId = parseInt(parsed.query.vehicle_id);
      const date = parsed.query.date || new Date().toISOString().split('T')[0];

      if (!vehicleId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'vehicle_id required' }));
        return;
      }

      const db = new (require('better-sqlite3'))(path.join(__dirname, 'data', 'database.db'));

      // Get vehicle info
      const vehicle = db.prepare('SELECT driver_name FROM vehicles WHERE id = ?').get(vehicleId);

      if (!vehicle) {
        db.close();
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Vehicle not found' }));
        return;
      }

      let positions = [];
      let dataSource = 'local';

      // Try to load from cached Detrack export (most recent)
      const detrackRoutePath = path.join(__dirname, 'data', 'detrack-route.json');
      if (fs.existsSync(detrackRoutePath)) {
        try {
          const detrackData = JSON.parse(fs.readFileSync(detrackRoutePath, 'utf8'));
          positions = detrackData.map(p => ({
            latitude: p.lat,
            longitude: p.lng,
            speed_kmh: p.speed,
            timestamp: p.time,
            address: p.location,
            mileage: p.mileage
          }));
          dataSource = 'detrack_export';
          console.log(`[tracking-route] Loaded ${positions.length} points from Detrack export`);
        } catch (e) {
          console.log('[tracking-route] Failed to parse Detrack export:', e.message);
        }
      }

      // Fallback to local database if no Detrack export
      if (positions.length === 0) {
        const localPositions = db.prepare(`
          SELECT latitude, longitude, speed_kmh, timestamp
          FROM vehicle_positions
          WHERE vehicle_id = ? AND date(timestamp) = ?
          ORDER BY timestamp ASC
        `).all(vehicleId, date);

        positions = localPositions || [];
        dataSource = 'local';
      }

      db.close();

      // Identify stops - cluster consecutive low-speed points
      const stops = [];
      let currentStop = null;

      for (let i = 0; i < positions.length; i++) {
        const pos = positions[i];
        const speed = pos.speed_kmh || 0;
        const isStopped = speed < 5; // Less than 5 km/h = stopped

        if (isStopped) {
          if (!currentStop) {
            // Start new stop
            currentStop = {
              latitude: pos.latitude,
              longitude: pos.longitude,
              address: pos.address,
              startTime: pos.timestamp,
              endTime: pos.timestamp,
              positions: [pos]
            };
          } else {
            // Continue current stop
            currentStop.endTime = pos.timestamp;
            currentStop.positions.push(pos);
          }
        } else {
          // Not stopped - save current stop if exists
          if (currentStop && currentStop.positions.length > 0) {
            // Calculate duration from timestamps
            const startTime = new Date(currentStop.startTime.includes('AM') || currentStop.startTime.includes('PM')
              ? currentStop.startTime
              : currentStop.startTime);
            const endTime = new Date(currentStop.endTime.includes('AM') || currentStop.endTime.includes('PM')
              ? currentStop.endTime
              : currentStop.endTime);

            const duration = Math.round((endTime - startTime) / 1000 / 60) || currentStop.positions.length;

            if (duration >= 1) { // Only save stops longer than 1 minute
              stops.push({
                latitude: currentStop.latitude,
                longitude: currentStop.longitude,
                address: currentStop.address,
                startTime: currentStop.startTime,
                endTime: currentStop.endTime,
                duration: Math.max(duration, 1),
                positions: currentStop.positions.length
              });
            }
          }
          currentStop = null;
        }
      }

      // Save final stop if exists
      if (currentStop && currentStop.positions.length > 0) {
        const duration = currentStop.positions.length;
        if (duration >= 1) {
          stops.push({
            latitude: currentStop.latitude,
            longitude: currentStop.longitude,
            address: currentStop.address,
            startTime: currentStop.startTime,
            endTime: currentStop.endTime,
            duration: Math.max(duration, 1),
            positions: currentStop.positions.length
          });
        }
      }

      // Format stops - convert timestamps properly
      const formattedStops = stops.map(stop => {
        const startTimeStr = typeof stop.startTime === 'string' ? stop.startTime : stop.startTime;
        const endTimeStr = typeof stop.endTime === 'string' ? stop.endTime : stop.endTime;
        const duration = typeof stop.duration === 'number' ? stop.duration : stop.positions || 1;

        return {
          latitude: stop.latitude,
          longitude: stop.longitude,
          address: stop.address || '',
          startTime: startTimeStr,
          endTime: endTimeStr,
          duration: duration,
          jobs: []
        };
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        vehicle: vehicle ? vehicle.driver_name : '',
        date: date,
        positions: positions,
        stops: formattedStops,
        totalPoints: positions.length,
        jobs: 0,
        dataSource: dataSource
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (parsed.pathname === '/api/tracking/vehicles') {
    try {
      const db = new (require('better-sqlite3'))(path.join(__dirname, 'data', 'database.db'));
      const vehicles = db.prepare(`
        SELECT
          id, vehicle_id, registration, vehicle_type, driver_name, active,
          (SELECT latitude FROM vehicle_positions WHERE vehicle_id = vehicles.id ORDER BY timestamp DESC LIMIT 1) as latest_latitude,
          (SELECT longitude FROM vehicle_positions WHERE vehicle_id = vehicles.id ORDER BY timestamp DESC LIMIT 1) as latest_longitude,
          (SELECT timestamp FROM vehicle_positions WHERE vehicle_id = vehicles.id ORDER BY timestamp DESC LIMIT 1) as latest_timestamp,
          (SELECT speed_kmh FROM vehicle_positions WHERE vehicle_id = vehicles.id ORDER BY timestamp DESC LIMIT 1) as latest_speed
        FROM vehicles ORDER BY registration
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

      // Get vehicle name from database
      const db = new (require('better-sqlite3'))(path.join(__dirname, 'data', 'database.db'));
      const vehicle = db.prepare('SELECT driver_name FROM vehicles WHERE id = ?').get(vehicleId);
      const vehicleName = vehicle ? vehicle.driver_name : '';
      db.close();

      // Fetch jobs from Detrack for the date range
      const DeetrackClient = require('./lib/deetrack-client');
      const client = new DeetrackClient(API_KEY);

      // Use GPS tracking data for reports (Download Route)
      const ReportGenerator = require('./lib/report-generator');
      const dbPath = path.join(__dirname, 'data', 'database.db');
      const generator = new ReportGenerator(dbPath);

      try {
        const report = generator.generateTrackingReport(vehicleId, dateFrom, dateTo, format);

        if (!report) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No tracking data found for this vehicle and date range' }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(report));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Error generating tracking report: ' + err.message }));
      }

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

  // Serve favicon
  if (parsed.pathname === '/favicon.ico') {
    try {
      const faviconPath = path.join(__dirname, 'favicon.ico');
      const favicon = fs.readFileSync(faviconPath);
      res.writeHead(200, { 'Content-Type': 'image/x-icon', 'Cache-Control': 'public, max-age=86400' });
      res.end(favicon);
      return;
    } catch (e) {
      res.writeHead(404);
      res.end();
      return;
    }
  }

  // Serve vehicle analytics dashboard
  if (parsed.pathname === '/analytics' || parsed.pathname === '/tracking') {
    const filePath = path.join(__dirname, 'vehicle-analytics.html');
    fs.readFile(filePath, 'utf8', (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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

  // Vehicle position poller disabled
  console.log('[vehicle-poller] Disabled — live tracking removed');

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
