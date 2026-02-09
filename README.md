# RRT Cloud Function

Firebase Cloud Functions backend for the Rapid Response mobile app (SOS alert system).

**Deployed Account**: `askrapidresponse@gmail.com`

## Features

- 🚨 **SOS Alert System**: Send emergency alerts to users in specific districts
- ✅ **Alert Resolution**: Stop/resolve active emergency alerts
- 🚫 **User Blocking**: Block/unblock users from sending SOS alerts (always enabled)
- 📊 **Alert Snapshot**: Real-time snapshot of current SOS alerts for admin dashboard (optional, can be disabled)
- 🧪 **Test Notifications**: Test push notification delivery
- 💰 **Cost Control**: Feature flags to disable optional database operations

## Cost Management

The codebase includes feature flags to control optional Firestore operations and manage costs:

```javascript
const FEATURES = {
  ENABLE_SOS_ALERT_SNAPSHOT: true,  // Set to false to disable SOS alert snapshot storage
  BLOCKED_USERS: true               // Always keep true - critical security feature
};
```

### When to Disable Features

**SOS Alert Snapshot (`ENABLE_SOS_ALERT_SNAPSHOT`)**
- **Can disable**: This stores the current state of alerts for admin dashboard
- **Saves**: Firestore write operations (2 writes per SOS alert cycle)
- **Impact**: Admin dashboard won't have visibility into current/past alerts
- **Recommendation**: Disable if you hit Firestore quotas or costs become too high

**Blocked Users (`BLOCKED_USERS`)**
- **Cannot disable**: This is a critical security feature
- **Impact**: Without this, you cannot prevent spam/abuse
- **Recommendation**: Always keep enabled

To disable a feature, edit `functions/index.js` and set the flag to `false`, then redeploy.

## API Endpoints

### Public Endpoints

#### `GET /health`
Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2026-02-09T10:30:00.000Z",
  "firebase": "connected"
}
```

#### `POST /sos`
Send or stop an SOS alert.

**Request Body:**
```json
{
  "sender_id": "firebase-installation-id",
  "sos_type": "sos_alert" | "stop",
  "location": {
    "latitude": 13.3409,
    "longitude": 74.7421,
    "accuracy": 10
  },
  "userInfo": {
    "name": "John Doe",
    "district": "udupi",
    "location": "Manipal",
    "phone": "+91-9876543210"
  },
  "timestamp": "1644395400000"
}
```

**Response:**
```json
{
  "success": true,
  "message": "SOS alert sent successfully",
  "messageId": "projects/...",
  "topic": "district-udupi",
  "senderId": "firebase-installation-id",
  "district": "udupi",
  "timestamp": "2026-02-09T10:30:00.000Z"
}
```

#### `POST /test-push`
Send a test push notification.

**Request Body:**
```json
{
  "district": "udupi",
  "title": "Test User",
  "body": "Test Location"
}
```

### Admin Endpoints

#### `POST /admin/block-user`
Block a user from sending SOS alerts.

**Request Body:**
```json
{
  "sender_id": "firebase-installation-id",
  "reason": "Spam/abuse",
  "blocked_by": "admin@example.com"
}
```

#### `POST /admin/unblock-user`
Unblock a previously blocked user.

**Request Body:**
```json
{
  "sender_id": "firebase-installation-id"
}
```

#### `GET /admin/blocked-users`
List all blocked users.

**Response:**
```json
{
  "success": true,
  "count": 2,
  "blockedUsers": [
    {
      "sender_id": "blocked-fid-123",
      "blocked": true,
      "blockedAt": "2026-02-09T10:30:00.000Z",
      "reason": "Spam",
      "blockedBy": "admin"
    }
  ],
  "timestamp": "2026-02-09T10:30:00.000Z"
}
```

#### `GET /admin/sos-alerts?active=true`
Get all SOS alert snapshots for admin dashboard (tabular view).

**Query Parameters:**
- `active` (optional): Set to `"true"` to filter only active alerts

**Response:**
```json
{
  "success": true,
  "count": 3,
  "activeOnly": false,
  "alerts": [
    {
      "sender_id": "fid-xyz-123",
      "active": true,
      "district": "udupi",
      "location": {
        "latitude": 13.3409,
        "longitude": 74.7421,
        "accuracy": 10
      },
      "userInfo": {
        "name": "John Doe",
        "mobile_number": "+91-9876543210",
        "message": "Need immediate help"
      },
      "timestamp": "2026-02-09T10:30:00.000Z"
    }
  ],
  "timestamp": "2026-02-09T10:30:00.000Z"
}
```

## Firestore Collections

### `blocked_users`
Stores blocked user information.

**Document Structure:**
```
blocked_users/{sender_id}
  blocked: boolean
  blockedAt: timestamp
  reason: string
  blockedBy: string
```

### `sos_alerts`
Stores current SOS alert status snapshot for each user (for admin dashboard tabular view).
Uses `sender_id` as document ID for easy lookup and updates.

**Document Structure:**
```
sos_alerts/{sender_id}  ← sender_id is the document ID
  sender_id: string
  active: boolean         ← true when SOS sent, false when stopped
  district: string        ← district name (e.g., "udupi", "mangalore")
  location: object        ← {latitude, longitude, accuracy}
  userInfo: object        ← {name, mobile_number, message}
  timestamp: timestamp    ← last updated time
```

**Key Points:**
- Each user has only ONE document (not a history log)
- Real-time snapshot of current alert status
- `active: true` = user currently in emergency
- `active: false` = emergency resolved
- Perfect for admin dashboard to show current alerts in a table

## Setup Instructions

### 1. Prerequisites
- Node.js 24+
- Firebase CLI: `npm install -g firebase-tools`
- Firebase project with Firestore enabled

### 2. Install Dependencies
```bash
cd functions
npm install
```

### 3. Initialize Firestore
1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select your project
3. Navigate to **Build** → **Firestore Database**
4. Click **Create database**
5. Choose **Production mode**
6. Select location (e.g., `asia-south1` for India)

### 4. Configure Firestore Security Rules
Copy the contents of `functions/firestore-security-rules` to your Firestore rules in the Firebase Console:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /blocked_users/{userId} {
      allow read, write: if false; // Only Cloud Functions
    }
    
    match /sos_alerts/{alertId} {
      allow read: if request.auth != null;
      allow write: if false; // Only Cloud Functions
    }
  }
}
```

### 5. Deploy
```bash
firebase deploy --only functions
```

### 6. Local Testing
```bash
cd functions
npm run serve
```

## Deploying to a Different Firebase Account

1. Create a new Firebase project
2. Enable Firestore (see Setup Instructions above)
3. Copy the `functions` directory to your new project
4. Run `firebase login` and select your account
5. Run `firebase use --add` and select your project
6. Deploy: `firebase deploy --only functions`

## Security Notes

- Admin endpoints have no authentication by default - implement proper authentication before production use
- Firestore security rules prevent client access to sensitive collections
- Cloud Functions have admin access to Firestore automatically
- Consider implementing rate limiting for public endpoints

## Code Architecture

The codebase is organized for easy maintenance and cost control:

### Database Operations (Lines ~20-180)
All Firestore operations are centralized in dedicated functions:

**Critical Functions (Always Enabled):**
- `isSenderBlocked()` - Check if user is blocked
- `blockUser()` - Add user to blocked list
- `unblockUser()` - Remove user from blocked list
- `getBlockedUser()` - Get blocked user details
- `listBlockedUsers()` - List all blocked users

**Optional Functions (Can Be Disabled):**
- `storeSOSAlert(sender_id, active, location, userInfo, district)` - Store/update SOS alert snapshot
- `getSOSAlerts(activeOnly)` - Retrieve all SOS alert snapshots for admin dashboard

**Benefits:**
- Single function handles both SOS activation and deactivation
- Real-time snapshot, not historical log
- Uses `sender_id` as document ID for efficient updates
- Easy to disable optional features via feature flags
- Centralized error handling
- Consistent logging
- Easy to modify database schema in one place

### API Endpoints (Lines ~180+)
Standard Express.js routes for all functionality

## Technologies

- **Runtime**: Node.js 24
- **Framework**: Express.js 5
- **Cloud Platform**: Firebase Cloud Functions
- **Database**: Cloud Firestore
- **Messaging**: Firebase Cloud Messaging (FCM)
- **Security**: Helmet.js, CORS
