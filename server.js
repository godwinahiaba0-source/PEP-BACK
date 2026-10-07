require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const multer = require('multer');

const { initDeviceWorker, buyDevice } = require('./deviceController');
const { getTeamReport } = require('./teamController');
const { register, login, adminLogin } = require('./authController'); 
const adminRoutes = require('./adminRoutes');
const userRoutes = require('./userRoutes');

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

global.io = io;

const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

app.use(express.json());
app.use('/uploads', express.static('uploads'));

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

initDeviceWorker(pool);

function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ success: false, message: 'No token provided' });

  const token = authHeader.split(' ')[1];
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ success: false, message: 'Invalid or expired token' });
    req.user = decoded;
    next();
  });
}

async function verifyAdmin(req, res, next) {
  try {
    if (!req.user) {
      const authHeader = req.headers['authorization'];
      if (authHeader) {
        const token = authHeader.split(' ')[1];
        try {
          req.user = jwt.verify(token, JWT_SECRET);
        } catch (e) {
          console.log("Manual token verification failed in verifyAdmin:", e.message);
        }
      }
    }

    if (!req.user) {
      return res.status(403).json({ success: false, message: 'Access denied: No token or user context' });
    }

    const adminIdentifier = req.user.username || req.user.id || req.user.user_id || req.user.adminId;
    
    const [rows] = await pool.query(
      'SELECT * FROM admins WHERE username = ? OR id = ?', 
      [adminIdentifier, adminIdentifier]
    );
    
    if (rows.length === 0) {
      return res.status(403).json({ success: false, message: 'Access denied: Admin privileges required' });
    }
    
    req.admin = rows[0];
    next();
  } catch (err) {
    console.error('Admin verification error:', err);
    res.status(500).json({ success: false, message: 'Server error verifying admin status' });
  }
}

app.post('/api/auth/register', (req, res) => register(req, res, pool));
app.post('/api/auth/login', (req, res) => login(req, res, pool, JWT_SECRET));
app.post('/api/auth/admin-login', (req, res) => adminLogin(req, res, pool, JWT_SECRET));
app.get('/api/devices', verifyToken, async (req, res) => {
  try {
    const [devices] = await pool.query('SELECT id, name, price, hourly_yield FROM vip_devices ORDER BY price ASC');
    res.json({ success: true, devices });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error fetching devices' });
  }
});

app.get('/api/devices/list', verifyToken, async (req, res) => {
  try {
    const [devices] = await pool.query('SELECT id, name, price, hourly_yield FROM vip_devices');
    res.json({ success: true, data: devices });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error fetching device list' });
  }
});

app.get('/api/devices/my-devices', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT user_device_id, device_id, hourly_yield, status FROM user_devices WHERE user_id = ?', [req.user.id]);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error fetching user devices' });
  }
});

app.post('/api/devices/buy', verifyToken, (req, res) => { req.body.userId = req.user.id; buyDevice(req, res, pool); });

app.get('/api/team/report', verifyToken, (req, res) => getTeamReport(req, res, pool));

app.use('/api', userRoutes(pool, verifyToken, upload));

app.use('/api', adminRoutes(pool, verifyToken, verifyAdmin, bcrypt));

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception caught gracefully:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

server.listen(PORT, () => {
  console.log(`🚀 Server running locally on port ${PORT}`);
});