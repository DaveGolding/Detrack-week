const https = require('https');

class DeetrackClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'app.detrack.com';
  }

  request(method, path) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.baseUrl,
        path: path,
        method: method,
        headers: {
          'X-API-KEY': this.apiKey,
          'Content-Type': 'application/json'
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
            } else {
              reject(new Error(`Deetrack API error ${res.statusCode}: ${data}`));
            }
          } catch (e) {
            reject(new Error(`Failed to parse response: ${e.message}`));
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  // Get all vehicles
  async getVehicles() {
    return this.request('GET', '/api/v2/vehicles');
  }

  // Get jobs for a specific date
  async getJobs(date) {
    return this.request('GET', `/api/v2/dn/jobs?date=${date}&page_size=200`);
  }

  // Get a specific job by delivery order number
  async getJob(doNum) {
    return this.request('GET', `/api/v2/dn/jobs/${encodeURIComponent(doNum)}`);
  }
}

module.exports = DeetrackClient;
