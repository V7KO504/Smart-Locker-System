const express = require('express');
const AT = require('africastalking')({
  apiKey: process.env.AT_API_KEY, username: process.env.AT_USERNAME
});
const { db }                               = require('../config/firebase');
const { createOTP, validateOTP, logEvent } = require('../utils/otp');
const { publishCommand }                   = require('../utils/mqtt');
const router = express.Router();

const { logAndNotify } = require('../utils/notifications');

router.post('/request', async (req, res) => {
  const { userId, lockerId } = req.body;
  if (!userId || !lockerId)
    return res.status(400).json({ error: 'userId and lockerId required.' });
  const safeKey = userId.replace(/[/.#$[\]]/g, '_').toUpperCase();
  try {
    const snap = await db.ref(`users/${safeKey}`).once('value');
    if (!snap.exists()) return res.status(404).json({ error: 'User not found.' });
    const user = snap.val();
    if (user.lockerId !== lockerId)
      return res.status(403).json({ error: 'Locker not assigned to you.' });
    
    const { otp, expiry } = await createOTP(lockerId, userId, 0);

    let smsStatusText = 'Success';
    try {
      const response = await AT.SMS.send({
        to: user.phone,
        message: `Your Smart Locker OTP: ${otp}\nLocker: ${lockerId}\nValid 5 minutes.`
      });
      const recipients = response && response.SMSMessageData && response.SMSMessageData.Recipients;
      if (recipients && recipients.length > 0) {
        smsStatusText = recipients[0].status;
      }
    } catch (smsErr) {
      smsStatusText = `Failed: ${smsErr.message || smsErr}`;
    }

    // Log the OTP request in the Audit Log and notify
    await logAndNotify({
      lockerId,
      userId: safeKey,
      eventType: 'OTP_REQUEST',
      status: smsStatusText === 'Success' ? 'SUCCESS' : 'FAILED',
      message: `OTP requested for Locker ${lockerId}. SMS status: ${smsStatusText}`,
      details: `SMS delivery status: ${smsStatusText}`
    });

    res.json({ success: true, message: 'OTP sent to your phone.', expiry, smsStatus: smsStatusText });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to send OTP.' });
  }
});

router.post('/resend', async (req, res) => {
  const { userId, lockerId } = req.body;
  if (!userId || !lockerId)
    return res.status(400).json({ error: 'userId and lockerId are required.' });
  const safeKey = userId.replace(/[/.#$[\]]/g, '_').toUpperCase();
  try {
    const snap = await db.ref(`users/${safeKey}`).once('value');
    if (!snap.exists()) return res.status(404).json({ error: 'Student not found.' });
    const user = snap.val();
    if (user.lockerId !== lockerId)
      return res.status(403).json({ error: 'Locker not assigned to you.' });

    // Cooldown and Max Resend Attempts checks
    const existing = await db.ref(`otpTokens/${lockerId}`).once('value');
    let resendCount = 0;
    if (existing.exists()) {
      const data = existing.val();
      resendCount = data.resendCount || 0;
      
      const creationTime = data.expiry - 5 * 60 * 1000;
      const elapsed = Date.now() - creationTime;
      if (elapsed < 60000) {
        const remainingCooldown = Math.ceil((60000 - elapsed) / 1000);
        return res.status(429).json({ error: `Please wait ${remainingCooldown} seconds before requesting a new OTP.` });
      }
    }

    if (resendCount >= 3) {
      return res.status(429).json({ error: 'Maximum resend attempts (3) reached. Please wait for the current OTP to expire.' });
    }

    const { otp, expiry } = await createOTP(lockerId, userId, resendCount + 1);

    let smsStatusText = 'Success';
    try {
      const response = await AT.SMS.send({
        to: user.phone,
        message: `Your Smart Locker OTP: ${otp}\nLocker: ${lockerId}\nValid 5 minutes.`
      });
      const recipients = response && response.SMSMessageData && response.SMSMessageData.Recipients;
      if (recipients && recipients.length > 0) {
        smsStatusText = recipients[0].status;
      }
    } catch (smsErr) {
      smsStatusText = `Failed: ${smsErr.message || smsErr}`;
    }

    // Log the OTP resend in the Audit Log and notify
    await logAndNotify({
      lockerId,
      userId: safeKey,
      eventType: 'OTP_REQUEST',
      status: smsStatusText === 'Success' ? 'SUCCESS' : 'FAILED',
      message: `OTP resent for Locker ${lockerId} (Attempt ${resendCount + 1}). SMS status: ${smsStatusText}`,
      details: `SMS delivery status: ${smsStatusText}. Attempt: ${resendCount + 1}`
    });

    res.json({ success: true, message: 'OTP resent to your phone.', expiry, smsStatus: smsStatusText });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to resend OTP.' });
  }
});

router.post('/validate', async (req, res) => {
  const { lockerId, otp } = req.body;
  if (!lockerId || !otp)
    return res.status(400).json({ error: 'lockerId and otp required.' });
  try {
    const result = await validateOTP(lockerId, otp);
    if (!result.valid) {
      await logAndNotify({
        lockerId,
        userId: null,
        eventType: 'OTP_FAILED',
        status: 'FAILED',
        message: `Failed OTP validation on Locker ${lockerId}: ${result.reason}`
      });
      return res.status(400).json({ error: result.reason });
    }
    
    publishCommand(lockerId, 'unlock', otp);
    
    await logAndNotify({
      lockerId,
      userId: result.userId,
      eventType: 'OTP_UNLOCK',
      status: 'SUCCESS',
      message: `Locker ${lockerId} successfully unlocked via OTP by ${result.userId}`
    });

    res.json({ success: true, message: 'Access granted.' });
  } catch (err) {
    res.status(500).json({ error: 'Validation failed.' });
  }
});

module.exports = router;
