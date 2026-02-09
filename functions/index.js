const functions = require('firebase-functions');
const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const helmet = require('helmet');

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin SDK (no credentials needed in Cloud Functions)
admin.initializeApp();
console.log('✅ Firebase Admin SDK initialized successfully');

// ============================================================================
// FEATURE FLAGS - Toggle features to control costs
// ============================================================================
const FEATURES = {
  ENABLE_SOS_ALERT_SNAPSHOT: true,  // Set to false to disable SOS alert snapshot storage for admin dashboard
  BLOCKED_USERS: true               // Always keep true - critical security feature
};

// ============================================================================
// SCHEDULED FUNCTION CONFIGURATION
// ============================================================================
const SCHEDULE_CONFIG = {
  ALERT_EXPIRATION_CHECK_INTERVAL: 'every 1 hours',  // How often to check for expired alerts (cron syntax or 'every X hours/minutes')
  ALERT_EXPIRATION_THRESHOLD_MS: 60 * 60 * 1000      // How old an alert must be to expire (default: 1 hour in milliseconds)
};

// ============================================================================
// DATABASE OPERATIONS - Centralized Firestore operations
// ============================================================================

/**
 * Check if a sender is blocked (CRITICAL - always enabled)
 */
async function isSenderBlocked(sender_id) {
  if (!FEATURES.BLOCKED_USERS) return false;
  
  try {
    const blockedDoc = await admin.firestore()
      .collection('blocked_users')
      .doc(sender_id)
      .get();
    
    return blockedDoc.exists && blockedDoc.data()?.blocked === true;
  } catch (error) {
    console.error('Error checking blocked status:', error);
    // Fail open or closed depending on your preference
    return false; // Fail open - allow request if check fails
  }
}

/**
 * Store/Update SOS alert snapshot in Firestore for admin dashboard (OPTIONAL - can be disabled)
 * Uses sender_id as document ID for easy lookup and tabular display
 * 
 * @param {string} sender_id - Firebase Installation ID (used as document ID)
 * @param {boolean} active - true for SOS alert, false for stop
 * @param {object} location - GPS coordinates {latitude, longitude, accuracy}
 * @param {object} userInfo - User details {name, mobile_number, message}
 * @param {string} district - District name (e.g., "udupi", "mangalore")
 */
async function storeSOSAlert(sender_id, active, location = null, userInfo = null, district = null) {
  if (!FEATURES.ENABLE_SOS_ALERT_SNAPSHOT) {
    console.log('⏭️  SOS alert snapshot disabled');
    return false;
  }
  
  try {
    const alertData = {
      sender_id: sender_id,
      active: active,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    };
    
    // Only update location, userInfo, and district when creating/updating an active alert
    if (active && location) {
      alertData.location = location;
    }
    
    if (active && userInfo) {
      alertData.userInfo = {
        name: userInfo.name || 'Unknown',
        mobile_number: userInfo.phone || userInfo.mobile_number || 'N/A',
        message: userInfo.message || ''
      };
    }
    
    if (active && district) {
      alertData.district = district;
    }
    
    // Use sender_id as document ID for easy updates
    await admin.firestore()
      .collection('sos_alerts')
      .doc(sender_id)
      .set(alertData, { merge: true });
    
    console.log(`📝 SOS alert ${active ? 'activated' : 'deactivated'} in Firestore for ${sender_id}`);
    return true;
  } catch (error) {
    console.error('⚠️  Failed to store SOS alert:', error);
    return false; // Don't fail the request if snapshot fails
  }
}

/**
 * Block a user in Firestore (CRITICAL - always enabled)
 */
async function blockUser(sender_id, reason, blocked_by) {
  const blockData = {
    blocked: true,
    blockedAt: admin.firestore.FieldValue.serverTimestamp(),
    reason: reason || 'No reason provided',
    blockedBy: blocked_by || 'admin'
  };
  
  await admin.firestore()
    .collection('blocked_users')
    .doc(sender_id)
    .set(blockData);
  
  return blockData;
}

/**
 * Unblock a user in Firestore (CRITICAL - always enabled)
 */
async function unblockUser(sender_id) {
  await admin.firestore()
    .collection('blocked_users')
    .doc(sender_id)
    .delete();
}

/**
 * Get blocked user document (CRITICAL - always enabled)
 */
async function getBlockedUser(sender_id) {
  const doc = await admin.firestore()
    .collection('blocked_users')
    .doc(sender_id)
    .get();
  
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

/**
 * List all blocked users (CRITICAL - always enabled)
 */
async function listBlockedUsers() {
  const snapshot = await admin.firestore()
    .collection('blocked_users')
    .where('blocked', '==', true)
    .orderBy('blockedAt', 'desc')
    .get();
  
  const blockedUsers = [];
  snapshot.forEach(doc => {
    blockedUsers.push({
      sender_id: doc.id,
      ...doc.data(),
      blockedAt: doc.data().blockedAt?.toDate().toISOString()
    });
  });
  
  return blockedUsers;
}

/**
 * Get all SOS alert snapshots for admin dashboard (OPTIONAL - can be disabled)
 * @param {boolean} activeOnly - If true, only return active alerts
 */
async function getSOSAlerts(activeOnly = false) {
  if (!FEATURES.ENABLE_SOS_ALERT_SNAPSHOT) {
    return [];
  }
  
  let query = admin.firestore().collection('sos_alerts');
  
  if (activeOnly) {
    query = query.where('active', '==', true);
  }
  
  const snapshot = await query.orderBy('timestamp', 'desc').get();
  
  const alerts = [];
  snapshot.forEach(doc => {
    const data = doc.data();
    alerts.push({
      sender_id: doc.id,
      active: data.active,
      district: data.district,
      location: data.location,
      userInfo: data.userInfo,
      timestamp: data.timestamp?.toDate().toISOString()
    });
  });
  
  return alerts;
}

/**
 * Expire old active SOS alerts (OPTIONAL - can be disabled)
 * Checks all active alerts and marks them as inactive if they exceed the threshold
 * @returns {object} Summary of expired alerts
 */
async function expireOldAlerts() {
  if (!FEATURES.ENABLE_SOS_ALERT_SNAPSHOT) {
    console.log('⏭️  Alert expiration disabled (SOS alert snapshot disabled)');
    return { expired: 0, checked: 0, enabled: false };
  }
  
  try {
    const now = Date.now();
    const thresholdTime = now - SCHEDULE_CONFIG.ALERT_EXPIRATION_THRESHOLD_MS;
    
    console.log(`🔍 Checking for alerts older than ${SCHEDULE_CONFIG.ALERT_EXPIRATION_THRESHOLD_MS / 1000 / 60} minutes`);
    
    // Query all active alerts
    const snapshot = await admin.firestore()
      .collection('sos_alerts')
      .where('active', '==', true)
      .get();
    
    const expiredAlerts = [];
    const batch = admin.firestore().batch();
    
    snapshot.forEach(doc => {
      const data = doc.data();
      const timestamp = data.timestamp?.toDate();
      
      if (timestamp && timestamp.getTime() < thresholdTime) {
        // Alert is older than threshold, mark for expiration
        const alertRef = admin.firestore().collection('sos_alerts').doc(doc.id);
        batch.update(alertRef, {
          active: false,
          expiredAt: admin.firestore.FieldValue.serverTimestamp(),
          expiredBy: 'scheduled_job'
        });
        
        expiredAlerts.push({
          sender_id: doc.id,
          district: data.district,
          age_minutes: Math.floor((now - timestamp.getTime()) / 1000 / 60)
        });
      }
    });
    
    // Commit all updates in a single batch
    if (expiredAlerts.length > 0) {
      await batch.commit();
      console.log(`✅ Expired ${expiredAlerts.length} old alerts:`, expiredAlerts);
    } else {
      console.log(`✅ No alerts to expire (checked ${snapshot.size} active alerts)`);
    }
    
    return {
      expired: expiredAlerts.length,
      checked: snapshot.size,
      enabled: true,
      expiredAlerts: expiredAlerts
    };
  } catch (error) {
    console.error('⚠️  Failed to expire old alerts:', error);
    throw error;
  }
}

// ============================================================================
// API ENDPOINTS
// ============================================================================

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    firebase: 'connected', // Always connected in CF
    features: {
      sosAlertSnapshot: FEATURES.ENABLE_SOS_ALERT_SNAPSHOT,
      blockedUsers: FEATURES.BLOCKED_USERS
    },
    scheduledJobs: {
      alertExpiration: {
        enabled: FEATURES.ENABLE_SOS_ALERT_SNAPSHOT,
        interval: SCHEDULE_CONFIG.ALERT_EXPIRATION_CHECK_INTERVAL,
        thresholdMinutes: SCHEDULE_CONFIG.ALERT_EXPIRATION_THRESHOLD_MS / 1000 / 60
      }
    }
  });
});

// Admin endpoint: Block a user
app.post('/admin/block-user', async (req, res) => {
  console.log('🔒 Block user request received:', req.body);
  
  try {
    const { sender_id, reason, blocked_by } = req.body;
    
    // Validate required fields
    if (!sender_id) {
      return res.status(400).json({ 
        error: 'Missing required field',
        required: ['sender_id']
      });
    }
    
    // Check if user is already blocked
    const existingUser = await getBlockedUser(sender_id);
    
    if (existingUser && existingUser.blocked === true) {
      return res.status(409).json({ 
        error: 'User already blocked',
        message: `User ${sender_id} is already in the blocked list`,
        blockedAt: existingUser.blockedAt,
        reason: existingUser.reason
      });
    }
    
    // Block the user
    await blockUser(sender_id, reason, blocked_by);
    
    console.log(`✅ User blocked successfully: ${sender_id}`);
    
    res.json({ 
      success: true, 
      message: 'User blocked successfully',
      sender_id: sender_id,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Block user error:', error);
    res.status(500).json({ 
      error: 'Failed to block user',
      message: error.message
    });
  }
});

// Admin endpoint: Unblock a user
app.post('/admin/unblock-user', async (req, res) => {
  console.log('🔓 Unblock user request received:', req.body);
  
  try {
    const { sender_id } = req.body;
    
    // Validate required fields
    if (!sender_id) {
      return res.status(400).json({ 
        error: 'Missing required field',
        required: ['sender_id']
      });
    }
    
    // Check if user exists in blocked list
    const existingUser = await getBlockedUser(sender_id);
    
    if (!existingUser) {
      return res.status(404).json({ 
        error: 'User not found',
        message: `User ${sender_id} is not in the blocked list`
      });
    }
    
    // Unblock the user
    await unblockUser(sender_id);
    
    console.log(`✅ User unblocked successfully: ${sender_id}`);
    
    res.json({ 
      success: true, 
      message: 'User unblocked successfully',
      sender_id: sender_id,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Unblock user error:', error);
    res.status(500).json({ 
      error: 'Failed to unblock user',
      message: error.message
    });
  }
});

// Admin endpoint: List all blocked users
app.get('/admin/blocked-users', async (req, res) => {
  console.log('📋 List blocked users request received');
  
  try {
    const blockedUsers = await listBlockedUsers();
    
    console.log(`✅ Found ${blockedUsers.length} blocked users`);
    
    res.json({ 
      success: true,
      count: blockedUsers.length,
      blockedUsers: blockedUsers,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ List blocked users error:', error);
    res.status(500).json({ 
      error: 'Failed to retrieve blocked users',
      message: error.message
    });
  }
});

// Admin endpoint: Get SOS alerts for dashboard
app.get('/admin/sos-alerts', async (req, res) => {
  console.log('📊 Get SOS alerts request received');
  
  try {
    const activeOnly = req.query.active === 'true';
    const alerts = await getSOSAlerts(activeOnly);
    
    console.log(`✅ Found ${alerts.length} SOS alerts${activeOnly ? ' (active only)' : ''}`);
    
    res.json({ 
      success: true,
      count: alerts.length,
      activeOnly: activeOnly,
      alerts: alerts,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Get SOS alerts error:', error);
    res.status(500).json({ 
      error: 'Failed to retrieve SOS alerts',
      message: error.message
    });
  }
});

// SOS Alert endpoint
app.post('/sos', async (req, res) => {
  console.log('📡 SOS request received:', req.body);
  
  try {
    const { sender_id, sos_type, location, userInfo, timestamp } = req.body;
    
    // Validate required fields
    if (!sender_id || !sos_type || !location) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['sender_id', 'sos_type', 'location']
      });
    }

    // Check if sender is blocked
    if (await isSenderBlocked(sender_id)) {
      console.log(`🚫 Blocked sender attempted SOS: ${sender_id}`);
      return res.status(403).json({ 
        error: 'Access denied',
        message: 'Your account has been restricted from using this service'
      });
    }

    // Validate sos_type
    if (!['sos_alert', 'stop'].includes(sos_type)) {
      return res.status(400).json({ 
        error: 'Invalid sos_type',
        message: 'sos_type must be either "sos_alert" or "stop"'
      });
    }

    if (sos_type === 'stop') {
      console.log(`🛑 Stopping SOS alert from sender: ${sender_id}`);
      
      // Extract district and user info for stop notification
      const district = userInfo?.district;
      if (!district) {
        return res.status(400).json({ 
          error: 'Missing district in userInfo',
          message: 'district is required for stop notification'
        });
      }
      
      const userName = userInfo?.name || 'Someone';
      const userLocation = userInfo?.location || district.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      
      // Send stop notification to all devices in the district
      const stopMessage = {
        topic: `district-${district}`,
        notification: {
          title: '✅ Emergency Resolved',
          body: `All good now. ${userName} • ${userLocation}`
        },
        data: {
          type: 'sos_resolved',
          sender_id: sender_id,
          district: district,
          timestamp: timestamp || Date.now().toString()
        },
      android: {
        priority: 'high',  // Critical: Forces immediate delivery bypassing Doze mode
        notification: {
          channelId: 'sos_alerts',  // Use high-importance channel
          icon: 'ic_notification',
          color: '#00FF00',
          sound: 'default',
          priority: 'high'
        }
      },
        apns: {
          headers: {
            'apns-priority': '10'  // High priority for iOS
          },
          payload: {
            aps: {
              contentAvailable: true,
              alert: {
                title: '✅ Emergency Resolved',
                body: `All good now. ${userName} • ${userLocation}`
              },
              sound: 'default',
              badge: 0
            }
          }
        }
      };

      // Send stop FCM message
      const stopResponse = await admin.messaging().send(stopMessage);
      
      console.log('✅ Stop notification sent successfully:', stopResponse);
      
      // Update SOS alert status to inactive in Firestore (optional)
      await storeSOSAlert(sender_id, false);
      
      return res.json({ 
        success: true, 
        message: 'SOS alert stopped successfully',
        messageId: stopResponse,
        senderId: sender_id,
        district: district,
        timestamp: new Date().toISOString()
      });
    }
    else if (sos_type === 'sos_alert') {
      // Extract district from userInfo
      const district = userInfo?.district;
      if (!district) {
        return res.status(400).json({ 
          error: 'Missing district in userInfo',
          message: 'district is required for SOS alert'
        });
      }
      
      console.log(`🚨 Sending SOS alert to district: ${district} (Sender: ${sender_id})`);
      
      // Extract user info for notification
      const userName = userInfo?.name || 'Someone';
      const userLocation = userInfo?.location || district.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      
      // Prepare FCM message
      const message = {
        topic: `district-${district}`,
        notification: {
          title: '🚨 Emergency Alert',
          body: `Help needed. ${userName} • ${userLocation}`
        },
        data: {
          type: 'sos_alert',
          sender_id: sender_id,
          district: district,
          location: JSON.stringify(location),
          timestamp: timestamp || Date.now().toString(),
          userInfo: userInfo ? JSON.stringify(userInfo) : '{}'
        },
        android: {
          priority: 'high',  // Critical: Forces immediate delivery bypassing Doze mode
          notification: {
            channelId: 'sos_alerts',  // Use high-importance channel
            icon: 'ic_notification',
            color: '#FF0000',
            sound: 'default',
            priority: 'high',
            defaultSound: true
          }
        },
        apns: {
          headers: {
            'apns-priority': '10'  // High priority for iOS
          },
          payload: {
            aps: {
              contentAvailable: true, 
              alert: {
                title: '🚨 Emergency Alert',
                body: `Help needed. ${userName} • ${userLocation}`
              },
              sound: 'default',
              badge: 1
            }
          }
        }
      };

      // Send FCM message
      const response = await admin.messaging().send(message);
      
      console.log('✅ SOS alert sent successfully:', response);
      
      // Store SOS alert snapshot in Firestore for admin dashboard (optional)
      await storeSOSAlert(sender_id, true, location, userInfo, district);
      
      res.json({ 
        success: true, 
        message: 'SOS alert sent successfully',
        messageId: response,
        topic: `district-${district}`,
        senderId: sender_id,
        district: district,
        timestamp: new Date().toISOString()
      });
    }
    else {
      return res.status(400).json({ 
        error: 'Invalid sos_type',
        message: 'sos_type must be either "sos_alert" or "stop"'
      });
    }
  } catch (error) {
    console.error('❌ SOS send error:', error);
    
    res.status(500).json({ 
      error: 'Failed to send SOS alert',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Test push notification endpoint
app.post('/test-push', async (req, res) => {
  console.log('📡 Test push notification request received:', req.body);
  
  try {
    const { district, title, body } = req.body;
    
    // Default to udupi if no district specified
    const targetDistrict = district || 'udupi';
    
    // Generate test sender ID
    const testSenderId = 'test-sender-fid';
    
    // Create test location data (sample coordinates for Udupi)
    const testLocation = {
      latitude: 13.3409,
      longitude: 74.7421,
      accuracy: 10
    };
    
    // Create test user info
    const testUserInfo = {
      name: 'Test User',
      district: targetDistrict,
      location: `${targetDistrict.charAt(0).toUpperCase() + targetDistrict.slice(1)} Test Location`,
      phone: '+91-XXXX-XXXX'
    };
    
    const userName = title || testUserInfo.name;
    const userLocation = body || testUserInfo.location;
    
    console.log(`🧪 Sending test SOS alert to district: ${targetDistrict}`);
    
    // Prepare test FCM message (matching SOS alert structure)
    const message = {
      topic: `district-${targetDistrict}`,
      notification: {
        title: '🧪 Test Emergency Alert',
        body: `Test alert. ${userName} • ${userLocation}`
      },
      data: {
        type: 'sos_alert',
        sender_id: testSenderId,
        district: targetDistrict,
        location: JSON.stringify(testLocation),
        timestamp: Date.now().toString(),
        userInfo: JSON.stringify(testUserInfo)
      },
      android: {
        priority: 'high',  // Critical: Forces immediate delivery bypassing Doze mode
        notification: {
          channelId: 'sos_alerts',  // Use high-importance channel
          icon: 'ic_notification',
          color: '#FF0000',
          sound: 'default',
          priority: 'high',
          defaultSound: true
        }
      },
      apns: {
        headers: {
          'apns-priority': '10'  // High priority for iOS
        },
        payload: {
          aps: {
            contentAvailable: true, 
            alert: {
              title: '🧪 Test Emergency Alert',
              body: `Test SOS alert in ${targetDistrict.toUpperCase()} area`
            },
            sound: 'default',
            badge: 1
          }
        }
      }
    };

    // Send FCM message
    const response = await admin.messaging().send(message);
    
    console.log('✅ Test notification sent successfully:', response);
    
    res.json({ 
      success: true, 
      message: 'Test SOS alert sent successfully',
      messageId: response,
      topic: `district-${targetDistrict}`,
      district: targetDistrict,
      senderId: testSenderId,
      testData: {
        location: testLocation,
        userInfo: testUserInfo
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Test notification error:', error);
    
    res.status(500).json({ 
      error: 'Failed to send test notification',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// 404 handler
app.use((req, res) => {  // No path specified here—it's implied as catch-all
  res.status(404).json({ 
    error: 'Endpoint not found',
    availableEndpoints: [
      'GET /health',
      'POST /sos',
      'POST /test-push',
      'POST /admin/block-user',
      'POST /admin/unblock-user',
      'GET /admin/blocked-users',
      'GET /admin/sos-alerts?active=true'
    ]
  });
});

// Error handler (unchanged)
app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('Server error:', error);
  res.status(500).json({ 
    error: 'Internal server error',
    message: error.message 
  });
});

// Export as Cloud Function (unchanged)
exports.api = functions.https.onRequest(app);

// ============================================================================
// SCHEDULED FUNCTIONS
// ============================================================================

/**
 * Scheduled function to automatically expire old active alerts
 * Runs every hour (configurable via SCHEDULE_CONFIG.ALERT_EXPIRATION_CHECK_INTERVAL)
 * Can be enabled/disabled via FEATURES.ENABLE_SOS_ALERT_SNAPSHOT
 * 
 * Configuration:
 * - ALERT_EXPIRATION_CHECK_INTERVAL: How often to run (default: every 1 hours)
 * - ALERT_EXPIRATION_THRESHOLD_MS: How old alerts must be to expire (default: 1 hour)
 */
exports.expireOldAlerts = functions.pubsub
  .schedule(SCHEDULE_CONFIG.ALERT_EXPIRATION_CHECK_INTERVAL)
  .timeZone('Asia/Kolkata')  // IST timezone
  .onRun(async (context) => {
    console.log('⏰ Running scheduled alert expiration check');
    
    try {
      const result = await expireOldAlerts();
      
      console.log('✅ Scheduled alert expiration completed:', result);
      
      return result;
    } catch (error) {
      console.error('❌ Scheduled alert expiration failed:', error);
      throw error;
    }
  });