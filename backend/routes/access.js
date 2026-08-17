const express = require('express');
const { db } = require('../config/firebase');
const router = express.Router();

router.get('/history', async (req, res) => {
  const auth = req.headers.authorization;
  const token = auth && auth.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized. Token required.' });
  }

  try {
    const userSnap = await db.ref(`users/${token}`).once('value');
    if (!userSnap.exists()) {
      return res.status(401).json({ error: 'Unauthorized. Invalid student token.' });
    }

    const user = userSnap.val();
    if (!user.lockerId) {
      return res.json([]);
    }

    // Fetch access logs for this student's locker
    const logsSnap = await db.ref('accessLogs')
      .orderByChild('timestamp')
      .limitToLast(100)
      .once('value');

    if (!logsSnap.exists()) {
      return res.json([]);
    }

    const logs = [];
    logsSnap.forEach(child => {
      const data = child.val();
      if (data.lockerId === user.lockerId) {
        logs.push({
          id: child.key,
          lockerId: data.lockerId,
          userId: data.userId,
          eventType: data.eventType,
          // Map uppercase 'SUCCESS' to lowercase 'success' for student.html compatibility
          status: (data.status || '').toLowerCase(),
          timestamp: data.timestamp,
          details: data.details || '',
          description: data.description || ''
        });
      }
    });

    // Return in reverse chronological order (newest first)
    logs.reverse();
    res.json(logs);
  } catch (err) {
    console.error('[access/history] ERROR:', err.message);
    res.status(500).json({ error: 'Failed to retrieve access history.' });
  }
});

module.exports = router;
