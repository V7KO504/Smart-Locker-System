const express = require('express');
const bcrypt  = require('bcryptjs');
const { db }  = require('../config/firebase');
const { createOTP } = require('../utils/otp');
const { logAndNotify } = require('../utils/notifications');
const router  = express.Router();

router.post('/session', async (req, res) => {
  const { text } = req.body;
  const input = text ? text.split('*') : [];
  let response = '';
  
  try {
    // Log the incoming USSD request
    await logAndNotify({
      lockerId: input[1] || null,
      userId: input[0] ? input[0].replace(/[/.#$[\]]/g, '_').toUpperCase() : null,
      eventType: 'USSD_REQUEST',
      status: 'SUCCESS',
      message: `USSD session input step. Text: "${text || ''}"`
    });

    if (!text || text === '') {
      response = 'CON Welcome to Smart Locker Access\nEnter your Student ID:';
    } else if (input.length === 1) {
      response = 'CON Enter your Locker Number (e.g. locker_01):';
    } else if (input.length === 2) {
      response = 'CON Enter your 4-digit PIN:';
    } else if (input.length === 3) {
      const [userId, lockerId, pin] = input;
      const safeKey = userId.replace(/[/.#$[\]]/g, '_').toUpperCase();
      const snap = await db.ref(`users/${safeKey}`).once('value');
      
      if (!snap.exists()) {
        response = 'END Invalid Student ID, Locker Number, or PIN.';
      } else {
        const user = snap.val();
        if (user.lockerId !== lockerId) {
          response = 'END Invalid Student ID, Locker Number, or PIN.';
        } else {
          // Check lockout
          if (user.lockoutUntil && user.lockoutUntil > Date.now()) {
            response = 'END Too many failed attempts. Try again in 5 minutes.';
          } else {
            const match = await bcrypt.compare(pin, user.pinHash);
            if (!match) {
              const failedAttempts = (user.failedPinAttempts || 0) + 1;
              const updates = { failedPinAttempts: failedAttempts };
              
              if (failedAttempts >= 5) {
                updates.lockoutUntil = Date.now() + 5 * 60 * 1000;
                
                // Trigger tamper alert
                await db.ref(`lockers/${lockerId}`).update({ status: 'alert' });
                
                await logAndNotify({
                  lockerId,
                  userId: safeKey,
                  eventType: 'TAMPER_ALERT',
                  status: 'ALERT',
                  message: `TAMPER ALERT: USSD session blocked on Locker ${lockerId} due to 5 failed PIN attempts.`
                });
              }
              
              await db.ref(`users/${safeKey}`).update(updates);
              
              await logAndNotify({
                lockerId,
                userId: safeKey,
                eventType: 'PIN_FAILED',
                status: 'FAILED',
                message: `Incorrect USSD PIN entered for Locker ${lockerId} (${Math.max(0, 5 - failedAttempts)} attempts left).`
              });

              response = failedAttempts >= 5 
                ? 'END Too many failed attempts. Try again in 5 minutes.'
                : 'END Incorrect PIN. Access denied.';
            } else {
              // PIN is correct, reset failures
              await db.ref(`users/${safeKey}`).update({
                failedPinAttempts: 0,
                lockoutUntil: null
              });
              
              const { otp } = await createOTP(lockerId, userId);
              
              await logAndNotify({
                lockerId,
                userId: safeKey,
                eventType: 'USSD_OTP_GENERATED',
                status: 'SUCCESS',
                message: `OTP generated via USSD for Locker ${lockerId}`
              });

              response = `END Your locker OTP is:\n${otp}\nLocker: ${lockerId}\nValid 5 minutes.`;
            }
          }
        }
      }
    }
  } catch (err) {
    console.error(err.message);
    response = 'END Service error. Please try again.';
  }
  
  res.set('Content-Type', 'text/plain');
  res.send(response);
});

module.exports = router;
