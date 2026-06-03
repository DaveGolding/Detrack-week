const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const os = require('os');
const { Bonjour } = require('bonjour-service');
const mdns = require('multicast-dns')({ interface: '192.168.21.131' });

const API_KEY = '071570deaf4479d2a1684336660e75876767a4b03cdfac1f';
const PORT = 80;
const MDNS_HOST = 'detrack-schedule.local';

// Get LAN IP
let lanIP = '127.0.0.1';
Object.values(os.networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal).forEach(i => lanIP = i.address);

// Respond directly to mDNS A record queries for detrack-schedule.local
mdns.on('query', query => {
  const match = query.questions.some(q => q.name === MDNS_HOST && (q.type === 'A' || q.type === 'ANY'));
  if (match) {
    mdns.respond({
      answers: [{ name: MDNS_HOST, type: 'A', ttl: 300, data: lanIP }]
    });
  }
});

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
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`DeTrack Weekly Board: http://localhost:${PORT}`);
  Object.values(os.networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal)
    .forEach(i => console.log(`Network:            http://${i.address}:${PORT}`));
  const bonjour = new Bonjour();
  bonjour.publish({ name: 'DeTrack Schedule', type: 'http', port: PORT, host: MDNS_HOST });
  console.log(`Bonjour: advertising as ${MDNS_HOST} → ${lanIP}`);
});
