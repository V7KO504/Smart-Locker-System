const express  = require('express');
const bcrypt   = require('bcryptjs');
const { db }   = require('../config/firebase');
const { publishCommand } = require('../utils/mqtt');
const { logAndNotify }   = require('../utils/notifications');
const router   = express.Router();

router.get('/status', async (req, res) => {
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
    const failedAttempts = user.failedPinAttempts || 0;
    const remainingAttempts = Math.max(0, 5 - failedAttempts);
    const lockoutUntil = user.lockoutUntil || null;
    const isLockedOut = lockoutUntil ? (lockoutUntil > Date.now()) : false;

    res.json({
      remainingAttempts,
      isLockedOut,
      lockoutUntil
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to retrieve PIN status.' });
  }
});

router.post('/validate', async (req, res) => {
  const { lockerId, pin } = req.body;
  if (!lockerId || !pin)
    return res.status(400).json({ error: 'lockerId and pin required.' });

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
    if (user.lockerId !== lockerId) {
      return res.status(403).json({ error: 'Access denied. This locker is not assigned to you.' });
    }

    const lockerSnap = await db.ref(`lockers/${lockerId}`).once('value');
    if (!lockerSnap.exists())
      return res.status(404).json({ error: 'Locker not found.' });

    // Check lockout status
    if (user.lockoutUntil && user.lockoutUntil > Date.now()) {
      await logAndNotify({
        lockerId,
        userId: token,
        eventType: 'PIN_FAILED',
        status: 'LOCKED_OUT',
        message: `PIN entry rejected on Locker ${lockerId}: Keypad locked out.`
      });
      return res.status(423).json({ 
        error: 'Too many failed attempts. Keypad locked for 5 minutes.',
        remainingAttempts: 0,
        lockoutUntil: user.lockoutUntil
      });
    }

    const match = await bcrypt.compare(pin, user.pinHash);
    if (!match) {
      const failedAttempts = (user.failedPinAttempts || 0) + 1;
      const updates = { failedPinAttempts: failedAttempts };
      const remaining = Math.max(0, 5 - failedAttempts);
      
      if (failedAttempts >= 5) {
        updates.lockoutUntil = Date.now() + 5 * 60 * 1000;
        
        // Lock locker node and trigger tamper alert
        await db.ref(`lockers/${lockerId}`).update({ status: 'alert' });
        
        await logAndNotify({
          lockerId,
          userId: token,
          eventType: 'PIN_LOCKOUT',
          status: 'LOCKED',
          message: `Locker ${lockerId} PIN lockout triggered (5 failed attempts).`
        });

        await logAndNotify({
          lockerId,
          userId: token,
          eventType: 'TAMPER_ALERT',
          status: 'ALERT',
          message: `TAMPER ALERT: Keypad lockout triggered on Locker ${lockerId} due to consecutive failed attempts.`
        });
      } else {
        await logAndNotify({
          lockerId,
          userId: token,
          eventType: 'PIN_FAILED',
          status: 'FAILED',
          message: `Incorrect PIN entered for Locker ${lockerId} (${remaining} attempts left).`
        });
      }
      await db.ref(`users/${token}`).update(updates);
      
      return res.status(401).json({ 
        error: failedAttempts >= 5 ? 'Too many failed attempts. Keypad locked.' : 'Incorrect PIN.',
        remainingAttempts: remaining,
        lockoutUntil: updates.lockoutUntil || null
      });
    }

    // Success: reset failures and unlock
    await db.ref(`users/${token}`).update({
      failedPinAttempts: 0,
      lockoutUntil: null
    });

    publishCommand(lockerId, 'unlock', 'pin');
    
    await logAndNotify({
      lockerId,
      userId: token,
      eventType: 'PIN_UNLOCK',
      status: 'SUCCESS',
      message: `Locker ${lockerId} successfully unlocked via PIN.`
    });

    res.json({ success: true, message: 'PIN accepted.' });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Validation failed.' });
  }
});

module.exports = router;
