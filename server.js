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
});

process.on('uncaughtException', err => {
  console.error('Uncaught exception:', err.message);
  process.exit(1);
});
