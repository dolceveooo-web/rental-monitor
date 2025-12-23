/**
 * Cairo Taj IT - Internet Rental Monitor
 * Runs in the cloud (Render.com) and sends Telegram notifications
 * when internet rentals expire.
 */

const admin = require('firebase-admin');
const fetch = require('node-fetch');

// =====================================================
// CONFIGURATION - Set these in Render.com Environment Variables
// =====================================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CHECK_INTERVAL_MS = 60000; // Check every 60 seconds

// Firebase configuration from environment variable (JSON string)
const firebaseConfig = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : null;

// Track notified rentals to avoid duplicate notifications
const notifiedRentals = new Set();
const notifiedWarnings = new Set();

// =====================================================
// INITIALIZE FIREBASE
// =====================================================
function initFirebase() {
    if (!firebaseConfig) {
        console.error('❌ FIREBASE_SERVICE_ACCOUNT environment variable not set!');
        console.log('Please set it in Render.com dashboard with your Firebase service account JSON');
        return false;
    }

    try {
        admin.initializeApp({
            credential: admin.credential.cert(firebaseConfig)
        });
        console.log('✅ Firebase initialized successfully');
        return true;
    } catch (error) {
        console.error('❌ Firebase initialization error:', error.message);
        return false;
    }
}

// =====================================================
// SEND TELEGRAM MESSAGE
// =====================================================
async function sendTelegram(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.log('⚠️ Telegram not configured');
        return false;
    }

    try {
        const response = await fetch(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: TELEGRAM_CHAT_ID,
                    text: message,
                    parse_mode: 'HTML'
                })
            }
        );

        const result = await response.json();
        if (result.ok) {
            console.log('📱 Telegram sent successfully');
            return true;
        } else {
            console.error('❌ Telegram error:', result.description);
            return false;
        }
    } catch (error) {
        console.error('❌ Telegram send error:', error.message);
        return false;
    }
}

// =====================================================
// CHECK RENTALS AND SEND NOTIFICATIONS
// =====================================================
async function checkRentals() {
    const db = admin.firestore();
    const now = new Date();

    try {
        // Get all active rentals
        const snapshot = await db.collection('internet-rentals')
            .where('status', '==', 'active')
            .get();

        if (snapshot.empty) {
            return;
        }

        console.log(`🔍 Checking ${snapshot.size} active rental(s)...`);

        for (const doc of snapshot.docs) {
            const rental = doc.data();
            const rentalId = doc.id;
            const endTime = rental.endTime?.toDate ? rental.endTime.toDate() : new Date(rental.endTime);
            const remaining = endTime - now;

            // Check if EXPIRED
            if (remaining <= 0 && !notifiedRentals.has(rentalId)) {
                notifiedRentals.add(rentalId);

                console.log(`🔴 Rental EXPIRED: Room ${rental.roomNumber}`);

                // Send Telegram notification
                await sendTelegram(
                    `🔴 <b>RENTAL EXPIRED!</b>\n\n` +
                    `🏨 Room: <b>${rental.roomNumber}</b>\n` +
                    `👤 Client: ${rental.clientName || 'Guest'}\n` +
                    `⏱️ Duration: ${rental.durationDisplay || rental.days + ' day(s)'}\n` +
                    `💰 Cost: ${rental.isException ? 'FREE' : (rental.totalCost || 0) + ' L.E'}\n\n` +
                    `⚠️ Please disconnect internet access!`
                );

                // Update status in Firestore
                await doc.ref.update({ status: 'expired' });
            }

            // Check for 5-minute WARNING
            if (remaining > 0 && remaining <= 300000 && !notifiedWarnings.has(rentalId)) {
                notifiedWarnings.add(rentalId);

                console.log(`🟡 5-min warning: Room ${rental.roomNumber}`);

                await sendTelegram(
                    `🟡 <b>5 MINUTE WARNING!</b>\n\n` +
                    `🏨 Room: <b>${rental.roomNumber}</b>\n` +
                    `👤 Client: ${rental.clientName || 'Guest'}\n\n` +
                    `⏰ Rental ending in 5 minutes!`
                );
            }
        }

        // Auto-archive old expired rentals (older than 30 days)
        const oneMonthAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));
        const expiredSnapshot = await db.collection('internet-rentals')
            .where('status', '==', 'expired')
            .get();

        for (const doc of expiredSnapshot.docs) {
            const rental = doc.data();
            const endTime = rental.endTime?.toDate ? rental.endTime.toDate() : new Date(rental.endTime);

            if (endTime < oneMonthAgo) {
                // Archive to rental-history
                await db.collection('rental-history').add({
                    ...rental,
                    archivedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                await doc.ref.delete();
                console.log(`📦 Archived old rental: Room ${rental.roomNumber}`);
            }
        }

    } catch (error) {
        console.error('❌ Check rentals error:', error.message);
    }
}

// =====================================================
// KEEP-ALIVE HTTP SERVER (for Render.com)
// =====================================================
const http = require('http');
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        status: 'running',
        service: 'Cairo Taj IT - Rental Monitor',
        lastCheck: new Date().toISOString(),
        activeNotifications: notifiedRentals.size
    }));
});

// =====================================================
// START THE MONITOR
// =====================================================
async function start() {
    console.log('🚀 Cairo Taj IT - Rental Monitor Starting...');
    console.log('================================================');

    // Check configuration
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.warn('⚠️ Telegram credentials not set. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in environment variables.');
    } else {
        console.log('✅ Telegram configured');
    }

    // Initialize Firebase
    if (!initFirebase()) {
        console.error('❌ Cannot start without Firebase. Exiting...');
        process.exit(1);
    }

    // Start HTTP server (keeps Render.com happy)
    server.listen(PORT, () => {
        console.log(`✅ Health check server running on port ${PORT}`);
    });

    // Send startup notification
    await sendTelegram(
        `🟢 <b>Rental Monitor Started!</b>\n\n` +
        `✅ Cloud monitoring is now active.\n` +
        `📱 You will receive notifications when rentals expire.`
    );

    // Run first check immediately
    await checkRentals();

    // Then check every minute
    setInterval(checkRentals, CHECK_INTERVAL_MS);
    console.log(`⏰ Checking rentals every ${CHECK_INTERVAL_MS / 1000} seconds`);
    console.log('================================================');
}

// Handle process termination
process.on('SIGTERM', async () => {
    console.log('🛑 Received SIGTERM. Shutting down...');
    await sendTelegram('🔴 <b>Rental Monitor Stopped</b>\n\nMonitoring has been paused.');
    process.exit(0);
});

// Start the application
start().catch(console.error);
