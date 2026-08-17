require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const session = require('express-session');
const path    = require('path');

require('./config/firebase');
require('./utils/mqtt');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

app.use(express.static(path.join(__dirname, '..', 'frontend')));

app.use('/api/otp',     require('./routes/otp'));
app.use('/api/ussd',    require('./routes/ussd'));
app.use('/api/pin',     require('./routes/pin'));
app.use('/api/lockers', require('./routes/lockers'));
app.use('/api/logs',    require('./routes/logs'));
app.use('/api/users',   require('./routes/users'));
app.use('/api/admin',   require('./routes/admin'));
app.use('/api/access',  require('./routes/access'));

app.get('/api/health', (_req, res) =>
  res.json({ status: 'ok', system: 'Smart Locker Backend', timestamp: Date.now() })
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nSmart Locker backend running on http://localhost:${PORT}`);
  console.log(`Admin dashboard:  http://localhost:${PORT}/index.html\n`);
});
