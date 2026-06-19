const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

class ReportGenerator {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.reportsDir = path.join(path.dirname(dbPath), 'reports');

    // Ensure reports directory exists
    if (!fs.existsSync(this.reportsDir)) {
      fs.mkdirSync(this.reportsDir, { recursive: true });
    }
  }

  // Generate CSV report
  generateCSV(vehicleId, dateFrom, dateTo) {
    try {
      const db = new Database(this.dbPath);

      // Get vehicle info
      const vehicle = db.prepare('SELECT vehicle_id, registration FROM vehicles WHERE id = ?').get(vehicleId);
      if (!vehicle) {
        db.close();
        return null;
      }

      // Get metrics for date range
      const metrics = db.prepare(`
        SELECT date, jobs_completed, total_stop_time_minutes, total_travel_time_minutes,
               total_distance_km, average_stop_duration_minutes, utilization_percent,
               on_time_jobs, late_jobs, idle_time_minutes, return_to_depot_time
        FROM vehicle_daily_metrics
        WHERE vehicle_id = ? AND date BETWEEN ? AND ?
        ORDER BY date
      `).all(vehicleId, dateFrom, dateTo);

      if (metrics.length === 0) {
        db.close();
        return null;
      }

      // Build CSV
      let csv = 'Vehicle Analytics Report\n';
      csv += `Vehicle: ${vehicle.registration} (${vehicle.vehicle_id})\n`;
      csv += `Period: ${dateFrom} to ${dateTo}\n\n`;

      csv += 'Date,Jobs,Stop Time (min),Travel Time (min),Distance (km),Avg Stop (min),Utilization %,On-Time,Late,Idle (min)\n';

      for (const m of metrics) {
        csv += `${m.date},${m.jobs_completed},${m.total_stop_time_minutes},${m.total_travel_time_minutes},${m.total_distance_km},${m.average_stop_duration_minutes},${m.utilization_percent},${m.on_time_jobs},${m.late_jobs},${m.idle_time_minutes}\n`;
      }

      // Add summary
      const totalJobs = metrics.reduce((sum, m) => sum + m.jobs_completed, 0);
      const avgUtilization = Math.round(metrics.reduce((sum, m) => sum + m.utilization_percent, 0) / metrics.length);
      const totalDistance = Math.round(metrics.reduce((sum, m) => sum + m.total_distance_km, 0) * 100) / 100;

      csv += '\nSummary\n';
      csv += `Total Jobs: ${totalJobs}\n`;
      csv += `Average Utilization: ${avgUtilization}%\n`;
      csv += `Total Distance: ${totalDistance} km\n`;

      // Save file
      const filename = `report-${vehicle.vehicle_id}-${dateFrom}-to-${dateTo}.csv`;
      const filepath = path.join(this.reportsDir, filename);
      fs.writeFileSync(filepath, csv, 'utf8');

      db.close();
      return { filename, filepath, format: 'csv' };
    } catch (err) {
      console.error('[report-generator] CSV error:', err.message);
      return null;
    }
  }

  // Generate HTML report (for PDF conversion via Puppeteer if available)
  generateHTML(vehicleId, dateFrom, dateTo) {
    try {
      const db = new Database(this.dbPath);

      // Get vehicle info
      const vehicle = db.prepare('SELECT vehicle_id, registration, driver_name FROM vehicles WHERE id = ?').get(vehicleId);
      if (!vehicle) {
        db.close();
        return null;
      }

      // Get metrics
      const metrics = db.prepare(`
        SELECT date, jobs_completed, total_stop_time_minutes, total_travel_time_minutes,
               total_distance_km, average_stop_duration_minutes, utilization_percent,
               on_time_jobs, late_jobs, idle_time_minutes
        FROM vehicle_daily_metrics
        WHERE vehicle_id = ? AND date BETWEEN ? AND ?
        ORDER BY date
      `).all(vehicleId, dateFrom, dateTo);

      if (metrics.length === 0) {
        db.close();
        return null;
      }

      // Calculate summary stats
      const totalJobs = metrics.reduce((sum, m) => sum + m.jobs_completed, 0);
      const avgUtilization = Math.round(metrics.reduce((sum, m) => sum + m.utilization_percent, 0) / metrics.length);
      const totalDistance = Math.round(metrics.reduce((sum, m) => sum + m.total_distance_km, 0) * 100) / 100;
      const avgStopTime = Math.round(metrics.reduce((sum, m) => sum + m.average_stop_duration_minutes, 0) / metrics.length);

      // Build HTML
      let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Vehicle Analytics Report</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Arial, sans-serif; color: #333; background: #f5f5f5; padding: 20px; }
    .container { max-width: 1000px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    h1 { color: #E8650A; margin-bottom: 10px; }
    .report-header { border-bottom: 2px solid #E8650A; padding-bottom: 20px; margin-bottom: 30px; }
    .vehicle-info { display: flex; justify-content: space-between; flex-wrap: wrap; }
    .info-block { flex: 1; min-width: 200px; margin: 10px; }
    .info-label { color: #999; font-size: 12px; font-weight: bold; }
    .info-value { font-size: 16px; font-weight: bold; color: #333; }
    .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; margin: 30px 0; }
    .summary-card { background: #f9f9f9; padding: 20px; border-radius: 4px; border-left: 4px solid #E8650A; }
    .summary-card .label { color: #666; font-size: 12px; }
    .summary-card .value { font-size: 24px; font-weight: bold; color: #E8650A; margin-top: 10px; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th { background: #f0f0f0; padding: 12px; text-align: left; font-weight: bold; border-bottom: 2px solid #ddd; }
    td { padding: 10px 12px; border-bottom: 1px solid #eee; }
    tr:hover { background: #f9f9f9; }
    .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #eee; color: #999; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="report-header">
      <h1>Vehicle Analytics Report</h1>
      <div class="vehicle-info">
        <div class="info-block">
          <div class="info-label">Vehicle</div>
          <div class="info-value">${vehicle.registration}</div>
        </div>
        <div class="info-block">
          <div class="info-label">Vehicle ID</div>
          <div class="info-value">${vehicle.vehicle_id}</div>
        </div>
        ${vehicle.driver_name ? `
        <div class="info-block">
          <div class="info-label">Driver</div>
          <div class="info-value">${vehicle.driver_name}</div>
        </div>
        ` : ''}
        <div class="info-block">
          <div class="info-label">Period</div>
          <div class="info-value">${dateFrom} to ${dateTo}</div>
        </div>
      </div>
    </div>

    <div class="summary">
      <div class="summary-card">
        <div class="label">Total Jobs</div>
        <div class="value">${totalJobs}</div>
      </div>
      <div class="summary-card">
        <div class="label">Avg Utilization</div>
        <div class="value">${avgUtilization}%</div>
      </div>
      <div class="summary-card">
        <div class="label">Total Distance</div>
        <div class="value">${totalDistance}km</div>
      </div>
      <div class="summary-card">
        <div class="label">Avg Stop Time</div>
        <div class="value">${avgStopTime}m</div>
      </div>
    </div>

    <h2>Daily Breakdown</h2>
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Jobs</th>
          <th>Utilization</th>
          <th>Stop Time</th>
          <th>Travel Time</th>
          <th>Distance</th>
          <th>On-Time</th>
          <th>Late</th>
        </tr>
      </thead>
      <tbody>
        ${metrics.map(m => `
        <tr>
          <td>${m.date}</td>
          <td>${m.jobs_completed}</td>
          <td>${m.utilization_percent}%</td>
          <td>${m.total_stop_time_minutes}m</td>
          <td>${m.total_travel_time_minutes}m</td>
          <td>${m.total_distance_km}km</td>
          <td>${m.on_time_jobs}</td>
          <td>${m.late_jobs}</td>
        </tr>
        `).join('')}
      </tbody>
    </table>

    <div class="footer">
      <p>Generated on ${new Date().toLocaleString()}</p>
    </div>
  </div>
</body>
</html>`;

      // Save file
      const filename = `report-${vehicle.vehicle_id}-${dateFrom}-to-${dateTo}.html`;
      const filepath = path.join(this.reportsDir, filename);
      fs.writeFileSync(filepath, html, 'utf8');

      db.close();
      return { filename, filepath, format: 'html', url: `/reports/${filename}` };
    } catch (err) {
      console.error('[report-generator] HTML error:', err.message);
      return null;
    }
  }

  // Get list of generated reports
  listReports() {
    try {
      const files = fs.readdirSync(this.reportsDir);
      return files
        .filter(f => f.startsWith('report-'))
        .map(f => ({
          filename: f,
          path: `/reports/${f}`,
          created: fs.statSync(path.join(this.reportsDir, f)).mtime,
          format: f.endsWith('.csv') ? 'csv' : 'html'
        }))
        .sort((a, b) => b.created - a.created);
    } catch (err) {
      console.error('[report-generator] List error:', err.message);
      return [];
    }
  }

  // Delete a report
  deleteReport(filename) {
    try {
      const filepath = path.join(this.reportsDir, filename);

      // Safety check: ensure file is in reports directory
      if (!filepath.startsWith(this.reportsDir)) {
        return false;
      }

      if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath);
        return true;
      }
      return false;
    } catch (err) {
      console.error('[report-generator] Delete error:', err.message);
      return false;
    }
  }
}

module.exports = ReportGenerator;
