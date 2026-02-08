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

// Health check endpoint (unchanged)
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    firebase: 'connected' // Always connected in CF
  });
});

// Blocked sender IDs (Firebase Installation IDs) - for production, use Firestore
const BLOCKED_SENDERS = new Set([
  // Add blocked Firebase Installation IDs here
  // Example: 'blocked-fid-xyz123',
]);

// Helper function to check if sender is blocked
// In production, replace this with Firestore lookup:
// const blockedDoc = await admin.firestore().collection('blocked_users').doc(sender_id).get();
// return blockedDoc.exists;
function isSenderBlocked(sender_id) {
  return BLOCKED_SENDERS.has(sender_id);
}

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
    if (isSenderBlocked(sender_id)) {
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
      
      return res.json({ 
        success: true, 
        message: 'SOS alert stopped successfully',
        messageId: stopResponse,
        senderId: sender_id,
        district: district,
        timestamp: new Date().toISOString()
      });
    }

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
    
    res.json({ 
      success: true, 
      message: 'SOS alert sent successfully',
      messageId: response,
      topic: `district-${district}`,
      senderId: sender_id,
      district: district,
      timestamp: new Date().toISOString()
    });
    
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

// 404 handler (unchanged)
app.use((req, res) => {  // No path specified here—it's implied as catch-all
  res.status(404).json({ 
    error: 'Endpoint not found',
    availableEndpoints: [
      'GET /health',
      'POST /sos',
      'POST /test-push',
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