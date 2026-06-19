const path = require('path');
const fs = require('fs');
const DB_PATH = path.join(__dirname, 'data', 'database.db');

['data'].forEach(d => {
  if (!fs.existsSync(path.join(__dirname, d)))
    fs.mkdirSync(path.join(__dirname, d), { recursive: true });
});

const Database = require('better-sqlite3');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

console.log('Setting up deetrack database...');

db.exec(`
CREATE TABLE IF NOT EXISTS vehicles(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id TEXT NOT NULL UNIQUE,
  registration TEXT,
  vehicle_type TEXT,
  driver_name TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT(datetime('now')),
  updated_at TEXT DEFAULT(datetime('now'))
);

CREATE TABLE IF NOT EXISTS vehicle_positions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  accuracy_meters INTEGER,
  timestamp TEXT NOT NULL,
  speed_kmh REAL,
  heading REAL,
  deetrack_job_id TEXT,
  created_at TEXT DEFAULT(datetime('now'))
);

CREATE TABLE IF NOT EXISTS job_locations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deetrack_job_id TEXT NOT NULL UNIQUE,
  address TEXT,
  latitude REAL,
  longitude REAL,
  job_type TEXT,
  scheduled_start TEXT,
  scheduled_end TEXT,
  created_at TEXT DEFAULT(datetime('now'))
);

CREATE TABLE IF NOT EXISTS vehicle_stops(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  job_location_id INTEGER REFERENCES job_locations(id),
  arrival_time TEXT NOT NULL,
  departure_time TEXT,
  duration_minutes INTEGER,
  distance_to_location_m REAL,
  status TEXT DEFAULT 'active',
  deetrack_job_id TEXT,
  created_at TEXT DEFAULT(datetime('now'))
);

CREATE TABLE IF NOT EXISTS route_segments(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  from_stop_id INTEGER REFERENCES vehicle_stops(id),
  to_stop_id INTEGER REFERENCES vehicle_stops(id),
  depart_time TEXT NOT NULL,
  arrive_time TEXT NOT NULL,
  duration_minutes INTEGER,
  distance_km REAL,
  travel_time_minutes INTEGER,
  actual_time_minutes INTEGER,
  efficiency_ratio REAL,
  route_polyline TEXT,
  created_at TEXT DEFAULT(datetime('now'))
);

CREATE TABLE IF NOT EXISTS vehicle_daily_metrics(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  jobs_completed INTEGER,
  total_stop_time_minutes INTEGER,
  total_travel_time_minutes INTEGER,
  total_distance_km REAL,
  average_stop_duration_minutes REAL,
  on_time_jobs INTEGER,
  late_jobs INTEGER,
  utilization_percent REAL,
  idle_time_minutes INTEGER,
  return_to_depot_time TEXT,
  created_at TEXT DEFAULT(datetime('now')),
  UNIQUE(vehicle_id, date)
);

CREATE TABLE IF NOT EXISTS vehicle_reports(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER REFERENCES vehicles(id),
  report_type TEXT,
  date_from TEXT,
  date_to TEXT,
  format TEXT,
  file_path TEXT,
  generated_at TEXT DEFAULT(datetime('now')),
  email_sent_to TEXT,
  created_at TEXT DEFAULT(datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_vehicle_positions_vehicle_timestamp
  ON vehicle_positions(vehicle_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_vehicle_stops_vehicle_date
  ON vehicle_stops(vehicle_id, date(arrival_time) DESC);
CREATE INDEX IF NOT EXISTS idx_vehicle_daily_metrics_vehicle_date
  ON vehicle_daily_metrics(vehicle_id, date DESC);
`);

console.log('✓ Database setup complete');
db.close();
