const path = require('path');
const admin = require('firebase-admin');
const rawPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './config/serviceAccountKey.json';
let resolvedPath;
if (path.isAbsolute(rawPath)) {
  resolvedPath = rawPath;
} else if (rawPath.startsWith('./')) {
  // treat as relative to project root (one level above this config folder)
  resolvedPath = path.resolve(__dirname, '..', rawPath.slice(2));
} else {
  resolvedPath = path.resolve(__dirname, '..', rawPath);
}
const serviceAccount = require(resolvedPath);
if (!admin.apps.length) {
  admin.initializeApp({
    credential:  admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
  console.log('Firebase Admin initialized.');
}
const db = admin.database();
module.exports = { admin, db };
