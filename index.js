/**
 * Cairo Taj IT - Internet Rental Monitor
 * Runs via GitHub Actions every 5 minutes
 */

const admin = require('firebase-admin');
const fetch = require('node-fetch');

// Configuration from environment/secrets
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const firebaseConfig = process.env.FIREBASE_SERVICE_ACCOUNT 
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : null;

// Initialize Firebase
function initFirebase() {
    if (!firebaseConfig) {
        console.error('❌ FIREBASE_SERVICE_ACCOUNT not set!');
        return false;
    }
    try {
        admin.initializeApp({
            credential: admin.credential.cert(firebaseConfig)
        });
        console.log('✅ Firebase initialized');
        return true;
    } catch (error) {
        console.error('❌ Firebase error:', error.message);
        return false;
    }
}

// Send Telegram message
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
            console.log('📱 Telegram sent!');
            return true;
        }
        console.error('❌ Telegram error:', result.description);
        return false;
    } catch (error) {
        console.error('❌ Telegram error:', error.message);
        return false;
    }
}

// Check rentals
async function checkRentals() {
    const db = admin.firestore();
    const now = new Date();
    
    try {
        const snapshot = await db.collection('internet-rentals')
            .where('status', '==', 'active')
            .get();

        if (snapshot.empty) {
            console.log('📭 No active rentals');
            return;
        }

        console.log(`🔍 Checking ${snapshot.size} active rental(s)...`);

        for (const doc of snapshot.docs) {
            const rental = doc.data();
            const endTime = rental.endTime?.toDate ? rental.endTime.toDate() : new Date(rental.endTime);
            const remaining = endTime - now;

            // EXPIRED
            if (remaining <= 0) {
                console.log(`🔴 EXPIRED: Room ${rental.roomNumber}`);
                
                await sendTelegram(
                    `🔴 <b>RENTAL EXPIRED!</b>\n\n` +
                    `🏨 Room: <b>${rental.roomNumber}</b>\n` +
                    `👤 Client: ${rental.clientName || 'Guest'}\n` +
                    `⏱️ Duration: ${rental.durationDisplay || rental.days + ' day(s)'}\n` +
                    `💰 Cost: ${rental.isException ? 'FREE' : (rental.totalCost || 0) + ' L.E'}\n\n` +
                    `⚠️ Please disconnect internet access!`
                );

                await doc.ref.update({ status: 'expired' });
            }

            // 5-minute warning (5 min = 300000 ms)
            if (remaining > 0 && remaining <= 300000) {
                console.log(`🟡 Warning: Room ${rental.roomNumber}`);
                
                await sendTelegram(
                    `🟡 <b>5 MINUTE WARNING!</b>\n\n` +
                    `🏨 Room: <b>${rental.roomNumber}</b>\n` +
                    `👤 Client: ${rental.clientName || 'Guest'}\n\n` +
                    `⏰ Rental ending in ${Math.ceil(remaining / 60000)} minutes!`
                );
            }
        }

        console.log('✅ Check complete');

    } catch (error) {
        console.error('❌ Error:', error.message);
    }
}

// Main
async function main() {
    console.log('🚀 Rental Monitor Starting...');
    
    if (!initFirebase()) {
        process.exit(1);
    }

    await checkRentals();
    
    console.log('✅ Done!');
    process.exit(0);
}

main().catch(console.error);
