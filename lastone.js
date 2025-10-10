require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const crypto = require('crypto');

// Initialize Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = admin.database();
const mediaRef = db.ref('mediaStorage');
const statsRef = db.ref('stats');
const tokensRef = db.ref('tokens');
const userAccessRef = db.ref('userAccess');
const configRef = db.ref('config');
const usersRef = db.ref('users');
const broadcastRef = db.ref('broadcasts');
const referralsRef = db.ref('referrals'); // NEW: Referrals database

// Default environment variables
let BOT_TOKEN = process.env.BOT_TOKEN;
let ALLOWED_GROUP_ID = parseInt(process.env.ALLOWED_GROUP_ID);
let OWNER_ID = parseInt(process.env.OWNER_ID);
let username = process.env.BOT_USERNAME;
let group = process.env.GROUP_LINK;
let group1 = process.env.GROUP_LINK1;
let PRIVATE_CHANNEL_1_ID = parseInt(process.env.PRIVATE_CHANNEL_1_ID);
let PRIVATE_CHANNEL_2_ID = parseInt(process.env.PRIVATE_CHANNEL_2_ID);
let AD_ENABLED = process.env.AD_ENABLED === 'true';
let EARNLINKS_API_TOKEN = process.env.EARNLINKS_API_TOKEN;
let EARNLINKS = process.env.EARNLINKS || 'earnlinks.in';
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'default-secret-change-in-production';

const app = express();
const PORT = process.env.PORT || 3000;

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Romantic loading messages
const romanticMessages = [
   "🔄 Loading your content...",
  "⚡ Preparing media...",
  "📦 Getting things ready...",
  "🎯 Almost there...",
  "✨ Setting up your view...",
  "🚀 Content loading in progress...",
  "⏳ Processing your request...",
  "🔧 Finalizing setup...",
  "📡 Connecting to media server...",
  "🎬 Preparing playback..."
];

// Function to get a random romantic loading message
function getRandomRomanticMessage() {
  return romanticMessages[Math.floor(Math.random() * romanticMessages.length)];
}

// Load configuration from Firebase
async function loadConfig() {
  try {
    const snapshot = await configRef.once('value');
    const config = snapshot.val();
    
    if (config) {
      ALLOWED_GROUP_ID = config.ALLOWED_GROUP_ID || ALLOWED_GROUP_ID;
      PRIVATE_CHANNEL_1_ID = config.PRIVATE_CHANNEL_1_ID || PRIVATE_CHANNEL_1_ID;
      PRIVATE_CHANNEL_2_ID = config.PRIVATE_CHANNEL_2_ID || PRIVATE_CHANNEL_2_ID;
      group = config.GROUP_LINK || group;
      group1 = config.GROUP_LINK1 || group1;
      AD_ENABLED = config.AD_ENABLED !== undefined ? config.AD_ENABLED : AD_ENABLED;
      EARNLINKS_API_TOKEN = config.EARNLINKS_API_TOKEN || EARNLINKS_API_TOKEN;
      EARNLINKS = config.EARNLINKS || 'earnlinks.in';
    }
  } catch (error) {
    console.error('Error loading config:', error);
  }
}

// Initialize configuration
loadConfig();

// NEW: Referral system functions
async function generateReferralCode(userId) {
  const code = Math.random().toString(36).substr(2, 8).toUpperCase();
  await referralsRef.child('codes').child(code).set({
    userId: userId,
    createdAt: Date.now(),
    uses: 0
  });
  return code;
}

async function getReferralCode(userId) {
  const snapshot = await referralsRef.child('userCodes').child(userId.toString()).once('value');
  return snapshot.val();
}

async function storeUserReferralCode(userId, code) {
  await referralsRef.child('userCodes').child(userId.toString()).set({
    code: code,
    createdAt: Date.now()
  });
}

async function validateReferral(code, newUserId) {
  try {
    const codeSnapshot = await referralsRef.child('codes').child(code).once('value');
    const codeData = codeSnapshot.val();
    
    if (!codeData) {
      return { valid: false, error: 'Invalid referral code' };
    }
    
    // Check if user is referring themselves
    if (codeData.userId === newUserId.toString()) {
      return { valid: false, error: 'Cannot use your own referral code' };
    }
    
    // Check if already used by this user
    const userRefSnapshot = await referralsRef.child('users').child(newUserId.toString()).once('value');
    if (userRefSnapshot.exists()) {
      return { valid: false, error: 'You have already used a referral code' };
    }
    
    return { valid: true, referrerId: codeData.userId };
  } catch (error) {
    return { valid: false, error: 'System error' };
  }
}

async function processSuccessfulReferral(referrerId, newUserId, code) {
  try {
    const referralId = Date.now();
    
    // Record the referral
    await referralsRef.child('users').child(newUserId.toString()).set({
      referredBy: referrerId,
      referralCode: code,
      referredAt: Date.now()
    });
    
    // Update code usage count
    await referralsRef.child('codes').child(code).transaction((current) => {
      if (current === null) return current;
      current.uses = (current.uses || 0) + 1;
      current.lastUsed = Date.now();
      return current;
    });
    
    // Update referrer's stats
    await referralsRef.child('referrers').child(referrerId.toString()).transaction((current) => {
      if (current === null) {
        return { totalReferrals: 1, lastReferral: Date.now(), codes: {} };
      }
      current.totalReferrals = (current.totalReferrals || 0) + 1;
      current.lastReferral = Date.now();
      return current;
    });
    
    // Grant 8 hours access to both users
    const expirationTime = Date.now() + (8 * 60 * 60 * 1000);
    
    // Grant access to new user
    await userAccessRef.child(newUserId.toString()).set({
      granted: true,
      expires: expirationTime,
      grantedAt: Date.now(),
      source: 'referral'
    });
    
    // Grant additional 8 hours to referrer (extend if already has access)
    const referrerSnapshot = await userAccessRef.child(referrerId.toString()).once('value');
    const referrerAccess = referrerSnapshot.val();
    
    let newExpiry;
    if (referrerAccess && referrerAccess.expires > Date.now()) {
      // Extend existing access
      newExpiry = referrerAccess.expires + (8 * 60 * 60 * 1000);
    } else {
      // New access
      newExpiry = expirationTime;
    }
    
    await userAccessRef.child(referrerId.toString()).set({
      granted: true,
      expires: newExpiry,
      grantedAt: Date.now(),
      source: 'referral_bonus'
    });
    
    return referralId;
  } catch (error) {
    console.error('Error processing referral:', error);
    throw error;
  }
}

async function notifyReferralSuccess(referrerId, newUserId, newUserName) {
  try {
    // Notify referrer
    const referrerMessage = `🎉 Referral Successful!\n\n👤 ${newUserName} joined using your referral code!\n\n✅ You both received +8 hours access!\n\nKeep inviting for more bonus time!`;
    await bot.sendMessage(referrerId, referrerMessage);
    
    // Notify new user
    const newUserMessage = `🎉 Welcome!\n\nYou joined using a referral code!\n\n✅ You received 8 hours free access!\n\nEnjoy your content! 🎬`;
    await bot.sendMessage(newUserId, newUserMessage);
    
  } catch (error) {
    console.error('Error sending referral notifications:', error);
  }
}

async function handleReferralStart(userId, referrerCode, msg) {
  try {
    const validation = await validateReferral(referrerCode, userId);
    
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }
    
    // Process successful referral
    await processSuccessfulReferral(validation.referrerId, userId, referrerCode);
    
    // Notify both users
    await notifyReferralSuccess(validation.referrerId, userId, msg.from.first_name);
    
    return { success: true, referrerId: validation.referrerId };
  } catch (error) {
    console.error('Error handling referral:', error);
    return { success: false, error: 'System error processing referral' };
  }
}

// Helper function to clean user data (remove undefined values)
function cleanUserData(userData) {
  const cleaned = {};
  for (const key in userData) {
    if (userData[key] !== undefined && userData[key] !== null) {
      cleaned[key] = userData[key];
    }
  }
  return cleaned;
}

// Track user for broadcasting
async function trackUser(userId, userData) {
  try {
    // Clean the user data to remove undefined values
    const cleanedUserData = cleanUserData({
      ...userData,
      lastSeen: Date.now(),
      firstSeen: userData.firstSeen || Date.now()
    });
    
    await usersRef.child(userId.toString()).set(cleanedUserData);
  } catch (error) {
    console.error('Error tracking user:', error);
  }
}

// NEW: Improved token generation function
function generateSecureToken(userId) {
  const timestamp = Date.now();
  // Create a unique data string with user ID, timestamp, and secret
  const data = `${userId}:${timestamp}:${TOKEN_SECRET}`;
  
  // Generate a secure hash
  const hash = crypto.createHmac('sha256', TOKEN_SECRET)
                    .update(data)
                    .digest('hex')
                    .substring(0, 16);
  
  // Format: t{timestamp}-{userId}-{hash}
  return `t${timestamp}-${userId}-${hash}`;
}

// NEW: Improved token validation function
async function validateSecureToken(token, userId) {
  try {
    console.log(`Validating token: ${token} for user: ${userId}`);
    
    // Basic format validation
    if (!token || !token.startsWith('t') || token.split('-').length !== 3) {
      console.log('Token format invalid');
      return false;
    }
    
    // Extract parts from token: t{timestamp}-{userId}-{hash}
    const parts = token.substring(1).split('-');
    const tokenTimestamp = parseInt(parts[0]);
    const tokenUserId = parts[1];
    const hashPart = parts[2];
    
    console.log(`Extracted - Timestamp: ${tokenTimestamp}, UserID: ${tokenUserId}, Hash: ${hashPart}`);
    
    // Check if user ID matches
    if (tokenUserId !== userId.toString()) {
      console.log(`User ID mismatch: expected ${userId}, got ${tokenUserId}`);
      return false;
    }
    
    // Check if token is not expired (18 hours)
    const tokenAge = Date.now() - tokenTimestamp;
    const isExpired = tokenAge > (18 * 60 * 60 * 1000);
    
    if (isExpired) {
      console.log(`Token expired. Age: ${tokenAge}ms`);
      return false;
    }
    
    // Recreate the expected hash
    const expectedData = `${tokenUserId}:${tokenTimestamp}:${TOKEN_SECRET}`;
    const expectedHash = crypto.createHmac('sha256', TOKEN_SECRET)
                              .update(expectedData)
                              .digest('hex')
                              .substring(0, 16);
    
    console.log(`Expected hash: ${expectedHash}, Actual hash: ${hashPart}`);
    
    // Check if hash is valid
    const hashValid = hashPart === expectedHash;
    
    console.log(`Hash valid: ${hashValid}, Not expired: ${!isExpired}`);
    
    return hashValid && !isExpired;
  } catch (error) {
    console.error('Token validation error:', error);
    return false;
  }
}

// Function to generate ad token
async function generateAdToken(userId, mediaHash = '') {
  if (!AD_ENABLED) {
    // When ads disabled, use referral system instead - don't grant direct access
    return null;
  }

  try {
    const secureToken = generateSecureToken(userId);
    const long_url = `https://t.me/${username}?start=${secureToken}`;
    const encoded_url = encodeURIComponent(long_url);
    const api_url = `https://${EARNLINKS}/api?api=${EARNLINKS_API_TOKEN}&url=${encoded_url}`;
    
    const response = await axios.get(api_url, { timeout: 10000 });
    const result = response.data;
    
    if (result.status === 'success') {
      // Store token info for validation
      const expirationTime = Date.now() + (18 * 60 * 60 * 1000);
      await tokensRef.child(secureToken).set({
        userId: userId,
        mediaHash: mediaHash,
        expires: expirationTime,
        createdAt: Date.now(),
        used: false
      });
      
      return result.shortenedUrl;
    } else {
      console.error('Error generating ad token:', result.message);
      return null;
    }
  } catch (error) {
    console.error('Error generating ad token:', error.message);
    return null;
  }
}

// Function to verify and activate token
async function verifyAndActivateToken(userId, token) {
  try {
    // Mark token as used
    await tokensRef.child(token).update({
      used: true,
      activatedAt: Date.now()
    });
    
    // Grant user access for 18 hours
    const expirationTime = Date.now() + (18 * 60 * 60 * 1000);
    await userAccessRef.child(userId.toString()).set({
      granted: true,
      expires: expirationTime,
      grantedAt: Date.now()
    });
    
    return true;
  } catch (error) {
    console.error('Error activating token:', error);
    return false;
  }
}

// Function to check if user has valid access
async function hasValidAccess(userId) {
  try {
    const snapshot = await userAccessRef.child(userId.toString()).once('value');
    const accessData = snapshot.val();
    
    if (!accessData || !accessData.granted) return false;
    
    // Check if access has expired
    if (Date.now() > accessData.expires) {
      await userAccessRef.child(userId.toString()).remove();
      return false;
    }
    
    return true;
  } catch (error) {
    console.error('Error checking access:', error);
    return false;
  }
}

// Track video views and shares
async function trackView(mediaHash) {
  try {
    await statsRef.child(mediaHash).transaction((current) => {
      if (current === null) {
        return { views: 1, shares: 0, createdAt: Date.now() };
      }
      current.views = (current.views || 0) + 1;
      return current;
    });
  } catch (error) {
    console.error('Error tracking view:', error);
  }
}

// Function to read media storage from Firebase
async function readMediaStorage() {
  try {
    const snapshot = await mediaRef.once('value');
    return snapshot.val() || [];
  } catch (error) {
    console.error('Error reading media storage:', error);
    return [];
  }
}

// Function to write media storage to Firebase
async function writeMediaStorage(mediaStorage) {
  try {
    await mediaRef.set(mediaStorage);
  } catch (error) {
    console.error('Error writing media storage:', error);
  }
}

// Initialize media storage
let mediaStorage = [];
readMediaStorage().then(data => {
  mediaStorage = data;
});

const generateHash = () => Math.random().toString(36).substr(2, 10);

// Send loading message
async function sendLoadingMessage(chatId, customMessage = null) {
  const message = customMessage || getRandomRomanticMessage();
  return bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
}

// Add this helper function to calculate time remaining
async function getTimeRemaining(userId) {
  try {
    const snapshot = await userAccessRef.child(userId.toString()).once('value');
    const accessData = snapshot.val();
    
    if (!accessData) return "0 hours";
    
    const remaining = accessData.expires - Date.now();
    const hours = Math.floor(remaining / (1000 * 60 * 60));
    const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
    
    return `${hours}h ${minutes}m`;
  } catch (error) {
    return "unknown time";
  }
}

// Handle /start command
bot.onText(/\/start(?: (.*))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const startParam = match[1];
  
  // Track user for broadcasting - with proper data cleaning
  await trackUser(userId, {
    id: userId,
    username: msg.from.username || '',
    firstName: msg.from.first_name || '',
    lastName: msg.from.last_name || '',
    languageCode: msg.from.language_code || '',
    isBot: msg.from.is_bot || false
  });
  
  // Send romantic loading message
  const loadingMessage = await sendLoadingMessage(chatId);
  
  try {
    // NEW: Handle referral codes (ref_ prefix)
    if (startParam && startParam.startsWith('ref_')) {
      const referrerCode = startParam.replace('ref_', '');
      const referralResult = await handleReferralStart(userId, referrerCode, msg);
      
      if (referralResult.success) {
        await bot.editMessageText(`🎉 Welcome! You joined using a referral!\n\n✅ You got 8 hours free access!\n\nEnjoy our exclusive media! 🎬`, {
          chat_id: chatId,
          message_id: loadingMessage.message_id,
          parse_mode: 'Markdown'
        });
        return;
      } else {
        await bot.editMessageText(`❌ ${referralResult.error}\n\nPlease use a valid referral link.`, {
          chat_id: chatId,
          message_id: loadingMessage.message_id,
          parse_mode: 'Markdown'
        });
        return;
      }
    }
    
    // Check if it's a secure token parameter
    if (startParam && startParam.startsWith('t')) {
      const isValid = await validateSecureToken(startParam, userId.toString());
      
      if (isValid) {
        await bot.editMessageText("⏳ Please wait a moment before making another request.", {
          chat_id: chatId,
          message_id: loadingMessage.message_id,
          parse_mode: 'Markdown'
        });
        
        // Check if token exists in database and is not used
        const tokenSnapshot = await tokensRef.child(startParam).once('value');
        const tokenData = tokenSnapshot.val();
        
        if (!tokenData || tokenData.used) {
          await bot.editMessageText("❌ This vip pass has already been used. You'll need a new one to continue our adventure... 🔄", {
            chat_id: chatId,
            message_id: loadingMessage.message_id,
            parse_mode: 'Markdown'
          });
          return;
        }
        
        // Activate the token and grant access
        const activated = await verifyAndActivateToken(userId, startParam);
        
        if (activated) {
          // If token has specific media, send it
          if (tokenData.mediaHash && tokenData.mediaHash !== 'undefined') {
            await trackView(tokenData.mediaHash);
            const mediaGroup = mediaStorage.find(group => group.hash === tokenData.mediaHash);
            
            if (mediaGroup) {
              await bot.deleteMessage(chatId, loadingMessage.message_id);
              await sendMediaContent(chatId, mediaGroup, msg.from.first_name);
            } else {
              await bot.editMessageText("🎉 𝗣𝗿𝗲𝗺𝗶𝘂𝗺 𝗣𝗮𝘀𝘀 ACTIVATED!\n\nUnfortunately, the content you're looking for has expired or been removed. Browse our other more! ", {
                chat_id: chatId,
                message_id: loadingMessage.message_id,
                parse_mode: 'Markdown'
              });
            }
          } else {
            const expiryTime = new Date(Date.now() + 18 * 60 * 60 * 1000);
            await bot.editMessageText(`🎉 𝗣𝗿𝗲𝗺𝗶𝘂𝗺 𝗣𝗮𝘀𝘀 ACTIVATED! 🗝️\n\nWelcome, ${msg.from.first_name}! \n\n⏰ You now have 18 hours of exclusive access: ${expiryTime.toLocaleString()}\n\nEnjoy tonight… 🌙`, {
              chat_id: chatId,
              message_id: loadingMessage.message_id,
              parse_mode: 'Markdown'
            });
          }
        } else {
          await bot.editMessageText("❌ 𝗣𝗿𝗲𝗺𝗶𝘂𝗺 𝗣𝗮𝘀𝘀 activation failed. Try again... ", {
            chat_id: chatId,
            message_id: loadingMessage.message_id,
            parse_mode: 'Markdown'
          });
        }
        return;
      } else {
        await bot.editMessageText("❌ This 𝗣𝗿𝗲𝗺𝗶𝘂𝗺 𝗣𝗮𝘀𝘀 is invalid or has expired. You'll need a new one to continue our adventure... 🔄", {
          chat_id: chatId,
          message_id: loadingMessage.message_id,
          parse_mode: 'Markdown'
        });
        return;
      }
    }
    
    // Check if user has valid access
    const hasAccess = await hasValidAccess(userId);
    
    if (hasAccess) {
      // Handle regular content access
      if (startParam && startParam.startsWith('view_')) {
        const mediaHash = startParam.replace('view_', '');
        await trackView(mediaHash);
        const mediaGroup = mediaStorage.find(group => group.hash === mediaHash);
        
        if (!mediaGroup) {
          await bot.editMessageText('The content you seek has disappeared... 🌙\n\n😉', {
            chat_id: chatId,
            message_id: loadingMessage.message_id,
            parse_mode: 'Markdown'
          });
          return;
        }

        await bot.deleteMessage(chatId, loadingMessage.message_id);
        await sendMediaContent(chatId, mediaGroup, msg.from.first_name);
      } else {
        const timeRemaining = await getTimeRemaining(userId);
        await bot.editMessageText(`🌙 Welcome back, ${msg.from.first_name}!\n\nYour 𝗣𝗿𝗲𝗺𝗶𝘂𝗺 𝗣𝗮𝘀𝘀 is still active - enjoy 😉\n\n⏰ Time Left: ${timeRemaining} 🫠\n`, {
          chat_id: chatId,
          message_id: loadingMessage.message_id,
          parse_mode: 'Markdown',
           reply_markup: {
              inline_keyboard: [
                [{ text: '🔔 𝗖𝗛𝗔𝗡𝗡𝗘𝗟', url: group }],
                [{ text: '👥 𝗠𝗬 𝗥𝗘𝗙𝗘𝗥𝗥𝗔𝗟𝗦', callback_data: 'my_referrals' }],
                [{ text: '❓ 𝗛𝗢𝗪 𝗜𝗧 𝗪𝗢𝗥𝗞𝗦', callback_data: 'referral_help' }],
              ]
            }
        });
      }
      return;
    }

    // Check if the user is a member of the private channels
    await bot.editMessageText("🔍 Checking access permissions...", {
      chat_id: chatId,
      message_id: loadingMessage.message_id,
      parse_mode: 'Markdown'
    });

    const [channel1Response, channel2Response] = await Promise.all([
      axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember`, {
        params: { chat_id: PRIVATE_CHANNEL_1_ID, user_id: userId },
        timeout: 5000
      }).catch(() => ({ data: { result: { status: 'not member' } } })),
      axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember`, {
        params: { chat_id: PRIVATE_CHANNEL_2_ID, user_id: userId },
        timeout: 5000
      }).catch(() => ({ data: { result: { status: 'not member' } } }))
    ]);

    const isMember = [channel1Response, channel2Response].every(res => 
      ['member', 'administrator', 'creator'].includes(res.data.result.status)
    );

    if (isMember) {
      if (!AD_ENABLED) {
        // NEW: When ads disabled, show referral system instead of direct access
        const userReferralCode = await getReferralCode(userId);
        let referralCode;
        
        if (!userReferralCode) {
          referralCode = await generateReferralCode(userId);
          await storeUserReferralCode(userId, referralCode);
        } else {
          referralCode = userReferralCode.code;
        }
        
        const referralLink = `https://t.me/${username}?start=ref_${referralCode}`;
        
        await bot.editMessageText(
          `🌙 Welcome , ${msg.from.first_name}!\n\n` +
          `🎯 *Access Requirements:*\n` +
          `Invite 1 friend to unlock 8 hours of exclusive content!\n\n` +
          `🎁 *How it works:*\n` +
          `• Share your unique referral link below\n` +
          `• When your friend joins, you BOTH get +8 hours access\n` +
          `• No limits - invite more friends for more time!\n\n` +
          `🔗 *Your Exclusive Referral Link:*\n` +
          `\`${referralLink}\`\n\n` +
          `📤 *Share this link and start your exclusive experience!*`,
          {
            chat_id: chatId,
            message_id: loadingMessage.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '📤 𝗦𝗛𝗔𝗥𝗘 𝗥𝗘𝗙𝗘𝗥𝗥𝗔𝗟 𝗟𝗜𝗡𝗞', url: `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=Join this exclusive content platform! Use my referral link for free access! 🌙` }],
                [{ text: '👥 𝗠𝗬 𝗥𝗘𝗙𝗘𝗥𝗥𝗔𝗟𝗦', callback_data: 'my_referrals' }],
                [{ text: '❓ 𝗛𝗢𝗪 𝗜𝗧 𝗪𝗢𝗥𝗞𝗦', callback_data: 'referral_help' }]
              ]
            }
          }
        );
        return;
      }

      // Handle regular content access for members who haven't watched ads yet
      if (startParam && startParam.startsWith('view_')) {
        const mediaHash = startParam.replace('view_', '');
        
        await bot.editMessageText("Loading content...🚑", {
          chat_id: chatId,
          message_id: loadingMessage.message_id,
          parse_mode: 'Markdown'
        });
        
        // Generate ad token for the user with the specific media
        const adToken = await generateAdToken(userId, mediaHash);
        
        if (adToken) {
          await bot.editMessageText(
            `🌹 Welcome Arre wah, ${msg.from.first_name}!\n\n` +
            `Access our content library with 18-hour unlimited access.\n\n` +
            `✨ Your magical journey begins now...`,
            {
              chat_id: chatId,
              message_id: loadingMessage.message_id,
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🔓𝗚𝗘𝗧 𝗣𝗥𝗘𝗠𝗜𝗨𝗠 𝗣𝗔𝗦𝗦', url: adToken }],
                  [{ text: '❓𝗛𝗘𝗟𝗣 ', url: 'https://t.me/zboxnightpass/12' }]
                ]
              }
            }
          );
        } else {
          await bot.editMessageText(`💔🙈 Oops, koi choti si glich ho gayi while getting your 𝗣𝗥𝗘𝗠𝗜𝗨𝗠 𝗣𝗔𝗦𝗦 ready. \n\nBut don't worry, trying again click here /start ..`, {
            chat_id: chatId,
            message_id: loadingMessage.message_id,
            parse_mode: 'Markdown'
          });
        }
      } else {
        await bot.editMessageText("⚡ Setting up your access...", {
          chat_id: chatId,
          message_id: loadingMessage.message_id,
          parse_mode: 'Markdown'
        });
        
        // Generate general ad token for the user
        const adToken = await generateAdToken(userId);
        
        if (adToken) {
          await bot.editMessageText(
            `🔥 Your Exclusive Invitation, ${msg.from.first_name}!\n\n` +
            `You've been selected for our premium NightPass experience.\n\n` +
            `Enjoy 18-hours of unlimited access to our most Premium content Library.\n\n` +
            `Now Active ?`,
            {
              chat_id: chatId,
              message_id: loadingMessage.message_id,
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🔑  𝗔𝗖𝗧𝗜𝗩𝗔𝗧𝗘 𝗣𝗥𝗘𝗠𝗜𝗨𝗠 𝗣𝗔𝗦𝗦 ♣️', url: adToken }],
                  [{ text: '🃏  𝗛𝗢𝗪 𝗧𝗢 𝗔𝗖𝗧𝗜𝗩𝗔𝗧𝗘 🫠', url: 'https://t.me/zboxnightpass/12' }]
                ]
              }
            }
          );
        } else {
          await bot.editMessageText('🌙 The stars aligned right now... Please try again in a moment.', {
            chat_id: chatId,
            message_id: loadingMessage.message_id,
            parse_mode: 'Markdown'
          });
        }
      }
    } else {
      await bot.editMessageText(
        `Welcome to MediaShare, ${msg.from.first_name}!\n\n` +
        `Join our channels to access the content library:\n\n` +
        `1️⃣ Join both channels below\n` +
        `2️⃣ Complete verification\n` +
        `3️⃣ Enjoy 18 hours of unlimited access\n\n` +
        `Your adventure begins tonight... `,
        {
          chat_id: chatId,
          message_id: loadingMessage.message_id,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '📢 𝗠𝗔𝗜𝗡 𝗖𝗢𝗡𝗧𝗘𝗡𝗧 𝗖𝗛𝗔𝗡𝗡𝗘𝗟', url: group1 }],
              [{ text: '🔔 𝗦𝗘𝗖𝗢𝗡𝗗𝗔𝗥𝗬 𝗖𝗛𝗔𝗡𝗡𝗘𝗟', url: group }],
              [{ text: "✅ 𝗜'𝗩𝗘 𝗝𝗢𝗜𝗡𝗘𝗗 𝗕𝗢𝗧𝗛", callback_data: 'verify_membership' }]
            ]
          }
        }
      );
    }
  } catch (error) {
    console.error('Error:', error);
    await bot.editMessageText('💔 ATMKBFTJ /start.', {
      chat_id: chatId,
      message_id: loadingMessage.message_id,
      parse_mode: 'Markdown'
    });
  }

  // Notify owner
  bot.sendMessage(OWNER_ID, `👤 New visitor: ${msg.from.first_name} (@${msg.from.username || 'lol'})`);
});

// Update the media content sending function
async function sendMediaContent(chatId, mediaGroup, userName) {
  for (const media of mediaGroup.media) {
    const caption = `Content expires in 16 minutes ⏰\n\n` + `Enjoy! 📹`;
    
    const options = {
      caption: caption,
      parse_mode: 'Markdown',
      protect_content: true,
      reply_markup: {
        inline_keyboard: [
          [
            { 
              text: '📺 𝗠𝗢𝗥𝗘 𝗖𝗢𝗡𝗧𝗘𝗡𝗧', 
              url: group1 
            },
            { 
              text: '📥 𝗦𝗛𝗔𝗥𝗘', 
              url: `https://t.me/share/url?url=t.me/${username}?start=view_${mediaGroup.hash}`
            }
          ]
        ]
      }
    };

    try {
      let sentMessage;
      if (media.type === 'photo') {
        sentMessage = await bot.sendPhoto(chatId, media.file_id, options);
      } else if (media.type === 'video') {
        sentMessage = await bot.sendVideo(chatId, media.file_id, options);
      }

      // Schedule deletion
      setTimeout(async () => {
        try {
          await bot.deleteMessage(chatId, sentMessage.message_id);
//           await bot.sendMessage(chatId, 
//             `🔄 Content refreshed\n\n`+
//             `⭐ Your access continues\n` +
//             `⏰ *Time Left:* ${await getTimeRemaining(chatId)}`,
//     {
//         parse_mode: 'Markdown',
//         reply_markup: {
//             inline_keyboard: [
//                 [
//                     {
//                         text: '☘️ 𝙎𝙃𝘼𝙍𝙀 𝙒𝙄𝙏𝙃 𝙁𝙍𝙄𝙀𝙉𝘿𝙎',
//                         url: `https://t.me/share/url?url=https://t.me/${username}?start=view_${mediaGroup.hash}&text=Check out this exclusive content! 🔥`
//                     }
//                 ],
//                 [
//                     {
//                         text: '🔁 𝙒𝘼𝙏𝘾𝙃 𝘼𝙂𝘼𝙄𝙉',
//                         url: `https://t.me/${username}?start=view_${mediaGroup.hash}`
//                     },
//                     {
//                         text: '🎬 𝘽𝙍𝙊𝙒𝙎𝙀 𝙈𝙊𝙍𝙀',
//                         url: group
//                     }
//                 ]
//             ]
//         }
//     }
// );
        } catch (error) {
          console.error('Error deleting message:', error);
        }
      }, 900000); // 15 minutes  
    } catch (error) {
      console.error('Error sending media:', error);
    }
  }
}

// Handle media messages in allowed group
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  // Track user for broadcasting with proper data cleaning
  if (msg.from) {
    await trackUser(userId, {
      id: userId,
      username: msg.from.username || '',
      firstName: msg.from.first_name || '',
      lastName: msg.from.last_name || '',
      languageCode: msg.from.language_code || '',
      isBot: msg.from.is_bot || false
    });
  }

  if (chatId === ALLOWED_GROUP_ID) {
    if (msg.photo || msg.video || msg.media_group_id) {
      const mediaType = msg.photo ? 'photo' : 'video';
      const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.video.file_id;

      if (msg.media_group_id) {
        let mediaGroup = mediaStorage.find(group => group.groupId === msg.media_group_id);

        if (!mediaGroup) {
          const mediaHash = generateHash();
          mediaGroup = {
            groupId: msg.media_group_id,
            hash: mediaHash,
            media: [],
            linkSent: false
          };
          mediaStorage.push(mediaGroup);
          await writeMediaStorage(mediaStorage);
        }

        mediaGroup.media.push({ type: mediaType, file_id: fileId });
        await writeMediaStorage(mediaStorage);

        if (!mediaGroup.linkSent) {
          mediaGroup.linkSent = true;
          await writeMediaStorage(mediaStorage);
          const lol = `t.me/${username}?start=view_${mediaGroup.hash}`
           const message = `Tap to copy the link:\n\n` +
               `\`${lol}\`\n` + `\`${lol}\`\n` + `\`${lol}\`\n` + `\`${lol}\``;
          
          await bot.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🤖 Open in Bot', url: `https://t.me/${username}?start=view_${mediaGroup.hash}` }]
              ]
            }
          });
        }
      } else {
        const mediaHash = generateHash();
        mediaStorage.push({
          groupId: null,
          hash: mediaHash,
          media: [{ type: mediaType, file_id: fileId }],
        });
        await writeMediaStorage(mediaStorage);
        
        const message = `🎬 NEW TAP TO COPY !\n\n` + `\`t.me/${username}?start=view_${mediaHash}\`\n` + `\`t.me/${username}?start=view_${mediaHash}\`\n` + `\`t.me/${username}?start=view_${mediaHash}\`\n` + `\`t.me/${username}?start=view_${mediaHash}\``;
        
        await bot.sendMessage(chatId, message, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🤖 Open in Bot', url: `https://t.me/${username}?start=view_${mediaHash}` }]
            ]
          }
        });
      }
    }
  } else if (msg.photo || msg.video) {
    const mediaType = msg.photo ? 'photo' : 'video';
    const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.video.file_id;
    
    if (mediaType === 'photo') {
      bot.sendPhoto(OWNER_ID, fileId, { caption: `From @${msg.from.username || 'unknown'}` });
    } else {
      bot.sendVideo(OWNER_ID, fileId, { caption: `From @${msg.from.username || 'unknown'}` });
    }
    
    bot.sendMessage(chatId, 'Thanks for sharing! Our team will review it soon.', { parse_mode: 'Markdown' });
  }
});

// Update the callback query handler
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;
  const data = callbackQuery.data;

  try {
    if (data === 'verify_membership') {
      const loadingMessage = await sendLoadingMessage(chatId, "🔍 Checking your access 🌿Thoda wait karo....,");
      
      const [channel1Response, channel2Response] = await Promise.all([
        axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember`, {
          params: { chat_id: PRIVATE_CHANNEL_1_ID, user_id: userId },
          timeout: 5000
        }).catch(() => ({ data: { result: { status: 'not member' } } })),
        axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember`, {
          params: { chat_id: PRIVATE_CHANNEL_2_ID, user_id: userId },
          timeout: 5000
        }).catch(() => ({ data: { result: { status: 'not member' } } }))
      ]);

      const isMember = [channel1Response, channel2Response].every(res => 
        ['member', 'administrator', 'creator'].includes(res.data.result.status)
      );

      if (isMember) {
        if (!AD_ENABLED) {
          // Show referral options when ads are disabled
          const userReferralCode = await getReferralCode(userId);
          let referralCode;
          
          if (!userReferralCode) {
            referralCode = await generateReferralCode(userId);
            await storeUserReferralCode(userId, referralCode);
          } else {
            referralCode = userReferralCode.code;
          }
          
          const referralLink = `https://t.me/${username}?start=ref_${referralCode}`;
          
          await bot.editMessageText(
            `📋 *Referral Program*\n\n` +
            `Invite friends to get free access!\n\n` +
            `🎁 *Benefits:*\n` +
            `• You get +8 hours per referral\n` +
            `• Your friend gets +8 hours\n` +
            `• Unlimited referrals!\n\n` +
            `🔗 *Your Referral Link:*\n` +
            `\`${referralLink}\`\n\n` +
            `Share this link with friends to start earning!`,
            {
              chat_id: chatId,
              message_id: loadingMessage.message_id,
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🚀 𝗦𝗛𝗔𝗥𝗘 𝗟𝗜𝗡𝗞 ', url: `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=Join this platform using my referral link!` }],
                  [{ text: '⬅️ 𝗕𝗔𝗖𝗞', callback_data: 'back_to_main' }]
                ]
              }
            }
          );
          return;
        }

        await bot.editMessageText("💫 Preparing Pre-p.a.s.s..", {
          chat_id: chatId,
          message_id: loadingMessage.message_id,
          parse_mode: 'Markdown'
        });
        
        const adToken = await generateAdToken(userId);
        
        if (adToken) {
          await bot.editMessageText('✅ Access verified! Jaldi se ek chhota sa ad dekho, taaki tumhara NightPass activate ho jaye aur tum apna exclusive experience shuru kar sako.', {
            chat_id: chatId,
            message_id: loadingMessage.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔓 𝗚𝗘𝗧 𝗣𝗥𝗘𝗠𝗜𝗨𝗠 𝗣𝗔𝗦𝗦', url: adToken }],
                [{ text: '🃏  𝗛𝗢𝗪 𝗧𝗢 𝗔𝗖𝗧𝗜𝗩𝗔𝗧𝗘 ', url: 'https://t.me/zboxnightpass/12' }]
              ]
            }
          });
        } else {
          await bot.editMessageText('Let me try again...', {
            chat_id: chatId,
            message_id: loadingMessage.message_id,
            parse_mode: 'Markdown'
          });
        }
      } else {
        await bot.editMessageText(`❌ You need to join OUR both channels click to join\n\n*${group1}*\n*${group}* \n...`, {
          chat_id: chatId,
          message_id: loadingMessage.message_id,
          parse_mode: 'Markdown'
        });
      }
    }
    else if (data === 'my_referrals') {
      // Show user's referral stats
      const referralsSnapshot = await referralsRef.child('referrers').child(userId.toString()).once('value');
      const referralStats = referralsSnapshot.val();
      
      const totalReferrals = referralStats ? (referralStats.totalReferrals || 0) : 0;
      const userReferralCode = await getReferralCode(userId);
      
      let message = `👥 *Your Referral Stats*\n\n`;
      message += `📊 Total Referrals: ${totalReferrals}\n`;
      message += `🔗 Your Code: \`${userReferralCode ? userReferralCode.code : 'Generating...'}\`\n\n`;
      message += `🎁 *Earn 8 hours free access for each successful referral!*`;
      
      await bot.answerCallbackQuery(callbackQuery.id);
      await bot.editMessageText(message, {
        chat_id: chatId,
        message_id: callbackQuery.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📤 𝗦𝗛𝗔𝗥𝗘 𝗥𝗘𝗙𝗘𝗥𝗥𝗔𝗟', callback_data: 'share_referral' }],
            [{ text: '⬅️ 𝗕𝗔𝗖𝗞', callback_data: 'back_to_main' }]
          ]
        }
      });
    }
    else if (data === 'share_referral') {
      const userReferralCode = await getReferralCode(userId);
      if (userReferralCode) {
        const referralLink = `https://t.me/${username}?start=ref_${userReferralCode.code}`;
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: 'Referral link ready! Share it with friends.',
          show_alert: false
        });
      }
    }
    else if (data === 'referral_help') {
      const helpMessage = `❓ *How Referrals Work*\n\n` +
        `1. Share your unique referral link with friends\n` +
        `2. Friends click your link and join the platform\n` +
        `3. Both you and your friend get +8 hours exclusive access\n` +
        `4. No limits - refer unlimited friends!\n\n` +
        `💡 *Pro Tip:* Share your link in groups and with friends to maximize your free access time!`;
      
      await bot.answerCallbackQuery(callbackQuery.id);
      await bot.editMessageText(helpMessage, {
        chat_id: chatId,
        message_id: callbackQuery.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ 𝗕𝗔𝗖𝗞', callback_data: 'back_to_main' }]
          ]
        }
      });
    }
else if (data === 'back_to_main') {
  // Show loading animation
  await bot.editMessageText("🔄 Returning to main menu...", {
    chat_id: chatId,
    message_id: callbackQuery.message.message_id,
    parse_mode: 'Markdown'
  });
  
  // Short delay for better UX
  await new Promise(resolve => setTimeout(resolve, 800));
  
  // Show main menu options
  await bot.editMessageText(
    "🎯 *Main Menu*\n\n" +
    "Choose an option below:",
    {
      chat_id: chatId,
      message_id: callbackQuery.message.message_id,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: "📤 GET MY SHARE LINK", callback_data: "get_share_link" }],
          [{ text: "👥 MY REFERRALS", callback_data: "my_referrals" }],
          [{ text: "❓ HOW IT WORKS", callback_data: "referral_help" }]
        ]
      }
    }
  );
}

else if (data === 'get_share_link') {
  // Show generating animation
  await bot.editMessageText("⚡ Generating your unique share link...", {
    chat_id: chatId,
    message_id: callbackQuery.message.message_id,
    parse_mode: 'Markdown'
  });
  
  // Short delay for animation effect
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Generate referral code
  const userReferralCode = await getReferralCode(userId);
  let referralCode;
  
  if (!userReferralCode) {
    referralCode = await generateReferralCode(userId);
    await storeUserReferralCode(userId, referralCode);
  } else {
    referralCode = userReferralCode.code;
  }
  
  const referralLink = `https://t.me/${username}?start=ref_${referralCode}`;
  
  // Show final share interface
  await bot.editMessageText(
    "✅ *Link Generated!*\n\n" +
    "🔗 *Your Personal Share Link:*\n" +
    `\`${referralLink}\`\n\n` +
    "📤 *Share with friends and both get 8 hours free access!*",
    {
      chat_id: chatId,
      message_id: callbackQuery.message.message_id,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ 
            text: '📤 SHARE NOW', 
            url: `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=Join this amazing platform! Get free access using my link! 🎉` 
          }],
          [{ 
            text: '📝 COPY LINK', 
            callback_data: 'copy_link' 
          }],
          [{ 
            text: '🔙 BACK TO MENU', 
            callback_data: 'back_to_main' 
          }]
        ]
      }
    }
  );
}

else if (data === 'main_menu') {
  // Show loading animation
  await bot.editMessageText("Loading main features...", {
    chat_id: chatId,
    message_id: callbackQuery.message.message_id,
    parse_mode: 'Markdown'
  });
  
  // Short delay
  await new Promise(resolve => setTimeout(resolve, 800));
  
  // Show welcome message with options
  await bot.editMessageText(
    "🌟 *Welcome Back!*\n\n" +
    "What would you like to do?",
    {
      chat_id: chatId,
      message_id: callbackQuery.message.message_id,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: "📤 GET SHARE LINK", callback_data: "get_share_link" }],
          [{ text: "👥 VIEW REFERRALS", callback_data: "my_referrals" }],
          [{ text: "🎬 BROWSE CONTENT", url: `https://t.me/${username}?start=start` }]
        ]
      }
    }
  );
}
else if (data === 'share_referral') {
  const userReferralCode = await getReferralCode(userId);
  if (userReferralCode) {
    const referralLink = `https://t.me/${username}?start=ref_${userReferralCode.code}`;
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: 'Share link ready! Tap "Share Now" to send to friends.',
      show_alert: false
    });
    
    await bot.editMessageText(
      `📤 *Ready to Share!*\n\n` +
      `Your personal link is ready to share with friends!\n\n` +
      `🔗 *Your Link:*\n\`${referralLink}\``,
      {
        chat_id: chatId,
        message_id: callbackQuery.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📤 SHARE NOW', url: `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=Join this amazing platform! Get free access using my link! 🎉` }],
            [{ text: '🔙 BACK TO STATS', callback_data: 'my_referrals' }]
          ]
        }
      }
    );
  }
}
  } catch (error) {
    console.error('Callback error:', error);
    bot.answerCallbackQuery(callbackQuery.id, {
      text: '💔 Our connection was interrupted... Please try again.',
      show_alert: true
    });
  }
});

// NEW: Improved admin command with help
bot.onText(/\/admin(?: (.+))?/, async (msg, match) => {
  const userId = msg.from.id;
  if (userId !== OWNER_ID) {
    bot.sendMessage(msg.chat.id, "❌ You are not authorized to use this command.", { parse_mode: 'Markdown' });
    return;
  }

  const command = match[1];
  
  // If no command provided, show help
  if (!command) {
    const helpMessage = `
🤖 *Admin Commands Help* 🤖

*Basic Commands:*
/ad_enable - Enable ads
/ad_disable - Disable ads
/status - Show bot status
/stats - Show bot statistics
/referral_stats - Show referral analytics

*Configuration Commands:*
/set_channel1 [ID] - Set Channel 1 ID
/set_channel2 [ID] - Set Channel 2 ID
/set_group_link [URL] - Set group link
/set_group_link1 [URL] - Set group link 1
/set_earnlinks_token [TOKEN] - Set EarnLinks token
/set_pro [DOMAIN] - Set ads provider domain

*Broadcast Commands:*
/broadcast [MESSAGE] - Broadcast message to all users

*Examples:*
/admin set_channel1 -100123456789
/admin broadcast Hello everyone!
/admin status
/admin referral_stats
    `;
    
    bot.sendMessage(msg.chat.id, helpMessage, { parse_mode: 'Markdown' });
    return;
  }

  const parts = command.split(' ');
  const action = parts[0];
  const value = parts.slice(1).join(' ');

  try {
    switch (action) {
      case 'ad_enable':
        AD_ENABLED = true;
        await configRef.update({ AD_ENABLED: true });
        bot.sendMessage(msg.chat.id, "✅ Ads enabled successfully.", { parse_mode: 'Markdown' });
        break;
      
      case 'ad_disable':
        AD_ENABLED = false;
        await configRef.update({ AD_ENABLED: false });
        bot.sendMessage(msg.chat.id, "✅ Ads disabled successfully.", { parse_mode: 'Markdown' });
        break;
      
      case 'set_channel1':
        PRIVATE_CHANNEL_1_ID = parseInt(value);
        await configRef.update({ PRIVATE_CHANNEL_1_ID: parseInt(value) });
        bot.sendMessage(msg.chat.id, `✅ Channel 1 ID set to: ${value}`, { parse_mode: 'Markdown' });
        break;
      
      case 'set_channel2':
        PRIVATE_CHANNEL_2_ID = parseInt(value);
        await configRef.update({ PRIVATE_CHANNEL_2_ID: parseInt(value) });
        bot.sendMessage(msg.chat.id, `✅ Channel 2 ID set to: ${value}`, { parse_mode: 'Markdown' });
        break;
      
      case 'set_group1':
        group = value;
        await configRef.update({ GROUP_LINK: value });
        bot.sendMessage(msg.chat.id, `✅ Group link set to: ${value}`, { parse_mode: 'Markdown' });
        break;
      
      case 'set_group2':
        group1 = value;
        await configRef.update({ GROUP_LINK1: value });
        bot.sendMessage(msg.chat.id, `✅ Group link 1 set to: ${value}`, { parse_mode: 'Markdown' });
        break;
      
      case 'set_pro_token':
        EARNLINKS_API_TOKEN = value;
        await configRef.update({ EARNLINKS_API_TOKEN: value });
        bot.sendMessage(msg.chat.id, "✅ EarnLinks API token updated.", { parse_mode: 'Markdown' });
        break;
     
      case 'set_pro':
        EARNLINKS = value;
        await configRef.update({ EARNLINKS: value });
        bot.sendMessage(msg.chat.id, "✅ Ads provider updated.", { parse_mode: 'Markdown' });
        break;
      
      case 'status':
        const status = `
📊 *Bot Status:*
- *Ads Enabled:* ${AD_ENABLED}
- *Channel 1 ID:* ${PRIVATE_CHANNEL_1_ID}
- *Channel 2 ID:* ${PRIVATE_CHANNEL_2_ID}
- *EarnLinks Token:* ${EARNLINKS_API_TOKEN ? 'Set' : 'Not Set'}
- *Group Link1:* ${group}
- *Group Link2:* ${group1}
- *Ad Pro Url:* ${EARNLINKS}
- *Mode:* ${AD_ENABLED ? 'Ads' : 'Referral System'}
        `;
        bot.sendMessage(msg.chat.id, status, { parse_mode: 'Markdown' });
        break;
      
      case 'broadcast':
        // Broadcast to all users
        const broadcastMessage = value;
        if (!broadcastMessage) {
          bot.sendMessage(msg.chat.id, "❌ Please provide a message to broadcast. Usage: /admin broadcast Your message here", { parse_mode: 'Markdown' });
          return;
        }
        
        const broadcastResult = await sendBroadcast(broadcastMessage);
        bot.sendMessage(msg.chat.id, `📢 Broadcast sent to ${broadcastResult.success} users. ${broadcastResult.failed} failed.`, { parse_mode: 'Markdown' });
        break;
      
      case 'stats':
        const userCount = await getUserCount();
        const activeUsers = await getActiveUserCount();
        const statsMessage = `
📈 *Bot Statistics:*
- *Total Users:* ${userCount}
- *Active Users (last 30 days):* ${activeUsers}
- *Media Files:* ${mediaStorage.length}
        `;
        bot.sendMessage(msg.chat.id, statsMessage, { parse_mode: 'Markdown' });
        break;

      case 'referral_stats':
        const referralsSnapshot = await referralsRef.child('referrers').once('value');
        const referrers = referralsSnapshot.val() || {};
        const totalReferrals = Object.values(referrers).reduce((sum, ref) => sum + (ref.totalReferrals || 0), 0);
        const topReferrers = Object.entries(referrers)
          .sort((a, b) => (b[1].totalReferrals || 0) - (a[1].totalReferrals || 0))
          .slice(0, 5);
        
        let referralStatsMessage = `📊 *Referral Analytics*\n\n`;
        referralStatsMessage += `👥 Total Referrals: ${totalReferrals}\n`;
        referralStatsMessage += `🏆 Top Referrers:\n`;
        
        topReferrers.forEach(([userId, data], index) => {
          referralStatsMessage += `${index + 1}. User ${userId}: ${data.totalReferrals || 0} referrals\n`;
        });
        
        bot.sendMessage(msg.chat.id, referralStatsMessage, { parse_mode: 'Markdown' });
        break;
      
      case 'help':
        const helpMessage = `
🤖 *Admin Commands Help* 🤖

*Basic Commands:*
/ad_enable - Enable ads
/ad_disable - Disable ads
/status - Show bot status
/stats - Show bot statistics
/referral_stats - Show referral analytics

*Configuration Commands:*
/set_channel1 [ID] - Set Channel 1 ID
/set_channel2 [ID] - Set Channel 2 ID
/set_group1 [URL] - Set group link
/set_group2 [URL] - Set group link 1
/set_pro_token [TOKEN] - Set EarnLinks token
/set_pro [DOMAIN] - Set ads provider domain

*Broadcast Commands:*
/broadcast [MESSAGE] - Broadcast message to all users

*Examples:*
/admin set_channel1 -100123456789
/admin broadcast Hello everyone!
/admin status
/admin referral_stats
        `;
        bot.sendMessage(msg.chat.id, helpMessage, { parse_mode: 'Markdown' });
        break;
      
      default:
        bot.sendMessage(msg.chat.id, "❌ Unknown command. Type /admin help for available commands.", { parse_mode: 'Markdown' });
    }
  } catch (error) {
    console.error('Admin command error:', error);
    bot.sendMessage(msg.chat.id, "❌ Error executing command.", { parse_mode: 'Markdown' });
  }
});

// Function to send broadcast to all users
async function sendBroadcast(message) {
  let success = 0;
  let failed = 0;
  
  try {
    const usersSnapshot = await usersRef.once('value');
    const users = usersSnapshot.val();
    
    if (!users) {
      return { success: 0, failed: 0, total: 0 };
    }
    
    const userIds = Object.keys(users);
    
    // Store broadcast in history
    const broadcastId = Date.now();
    await broadcastRef.child(broadcastId).set({
      message: message,
      sentAt: Date.now(),
      totalUsers: userIds.length
    });
    
    // Send to each user with delay to avoid rate limiting
    for (const userId of userIds) {
      try {
        await bot.sendMessage(userId, `${message}`, { parse_mode: 'MarkdownV2' });
        success++;
        
        // Update broadcast status
        await broadcastRef.child(broadcastId).child('recipients').child(userId).set({
          sent: true,
          timestamp: Date.now()
        });
        
        // Add delay to avoid hitting rate limits
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        failed++;
        
        // Update broadcast status
        await broadcastRef.child(broadcastId).child('recipients').child(userId).set({
          sent: false,
          error: error.message,
          timestamp: Date.now()
        });
        
        console.error(`Failed to send broadcast to user ${userId}:`, error.message);
      }
    }
    
    // Update broadcast with final stats
    await broadcastRef.child(broadcastId).update({
      completedAt: Date.now(),
      success: success,
      failed: failed
    });
    
    return { success, failed, total: userIds.length };
  } catch (error) {
    console.error('Broadcast error:', error);
    return { success, failed, total: 0, error: error.message };
  }
}

// Get total user count
async function getUserCount() {
  try {
    const snapshot = await usersRef.once('value');
    return snapshot.numChildren();
  } catch (error) {
    console.error('Error getting user count:', error);
    return 0;
  }
}

// Get active user count (last 30 days)
async function getActiveUserCount() {
  try {
    const snapshot = await usersRef.once('value');
    const users = snapshot.val();
    if (!users) return 0;
    
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    return Object.values(users).filter(user => user.lastSeen > thirtyDaysAgo).length;
  } catch (error) {
    console.error('Error getting active user count:', error);
    return 0;
  }
}

// Web interface with admin panel
app.use(bodyParser.json());
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.send(`
 <!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ZBOX - Premium Adult Experience</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
    <style>
        body {
            font-family: 'Inter', sans-serif;
            background: #0a0a0f;
            color: #e2e8f0;
            overflow-x: hidden;
        }
        .gradient-bg {
            background: linear-gradient(135deg, #0f0f23 0%, #1a1a2e 50%, #16213e 100%);
        }
        .web3-gradient {
            background: linear-gradient(90deg, #ff0080 0%, #7928ca 50%, #0070f3 100%);
        }
        .neon-border {
            border: 1px solid rgba(255, 0, 128, 0.5);
            box-shadow: 0 0 10px rgba(255, 0, 128, 0.3);
        }
        .pulse {
            animation: pulse 2s infinite;
        }
        @keyframes pulse {
            0% { transform: scale(1); }
            50% { transform: scale(1.05); }
            100% { transform: scale(1); }
        }
        #particles-js {
            position: absolute;
            width: 100%;
            height: 100%;
            z-index: 0;
        }
        .content {
            position: relative;
            z-index: 1;
        }
        .card-hover {
            transition: all 0.3s ease;
        }
        .card-hover:hover {
            transform: translateY(-5px);
            box-shadow: 0 10px 25px rgba(255, 0, 128, 0.2);
        }
        .popular-plan {
            border: 2px solid #ff0080;
            transform: scale(1.05);
        }
        .plan-card {
            transition: all 0.3s ease;
        }
        .plan-card:hover {
            transform: translateY(-10px);
        }
    </style>
</head>
<body class="gradient-bg min-h-screen">
    <!-- Particles Background -->
    <div id="particles-js"></div>
    
    <div class="content relative">
        <!-- Navigation -->
        <nav class="border-b border-gray-800 py-4">
            <div class="container mx-auto px-4 flex justify-between items-center">
                <div class="flex items-center">
                    <div class="w-10 h-10 rounded-lg web3-gradient flex items-center justify-center mr-3">
                        <span class="text-white font-bold">Z</span>
                    </div>
                    <span class="text-xl font-bold bg-clip-text text-transparent web3-gradient">ZBOX</span>
                </div>
                <div class="hidden md:flex space-x-8">
                    <a href="#features" class="hover:text-pink-500 transition">Features</a>
                    <a href="#subscriptions" class="hover:text-pink-500 transition">Subscriptions</a>
                    <a href="#earn" class="hover:text-pink-500 transition">Earn</a>
                    <a href="https://t.me/paid_promo0x" class="hover:text-pink-500 transition">Support</a>
                </div>
                <a href="https://t.me/zboxrobot" class="bg-pink-600 hover:bg-pink-700 text-white px-6 py-2 rounded-lg font-medium transition">
                    Launch Bot
                </a>
            </div>
        </nav>

        <!-- Hero Section -->
        <section class="py-20 px-4">
            <div class="container mx-auto max-w-4xl text-center">
                <div class="pulse inline-block mb-6">
                    <span class="bg-pink-900 text-pink-300 text-sm font-semibold px-4 py-2 rounded-full">PREMIUM ADULT CONTENT</span>
                </div>
                <h1 class="text-5xl md:text-6xl font-bold mb-6">Ultimate <span class="bg-clip-text text-transparent web3-gradient">Adult Experience</span> on Telegram</h1>
                <p class="text-xl text-gray-400 mb-10 max-w-2xl mx-auto">
                    ZBOX delivers premium adult entertainment with exclusive content, AI companions, and revolutionary earning opportunities.
                </p>
                <div class="flex flex-col sm:flex-row justify-center gap-4">
                    <a href="#subscriptions" class="bg-pink-600 hover:bg-pink-700 text-white px-8 py-4 rounded-lg font-medium text-lg transition">
                        Get Premium Access
                    </a>
                    <a href="#features" class="border border-pink-500 text-pink-300 hover:bg-pink-950 px-8 py-4 rounded-lg font-medium text-lg transition">
                        Explore Features
                    </a>
                </div>
            </div>
        </section>

        <!-- Ads Subscription Plans -->
        <section id="subscriptions" class="py-16 px-4 bg-gray-900 bg-opacity-50">
            <div class="container mx-auto max-w-6xl">
                <div class="text-center mb-12">
                    <h2 class="text-3xl md:text-4xl font-bold mb-4">Premium <span class="text-green-400">Ads Subscription</span> Plans</h2>
                    <p class="text-gray-400 max-w-2xl mx-auto">Choose your premium ad-free experience with uninterrupted access to exclusive adult content</p>
                </div>
                
                <div class="grid md:grid-cols-4 gap-6">
                    <!-- Rush Plan -->
                    <div class="bg-gray-800 bg-opacity-50 p-6 rounded-xl neon-border plan-card popular-plan">
                        <div class="text-center mb-4">
                            <span class="bg-red-500 text-white text-xs font-bold px-3 py-1 rounded-full">RUSH PLAN</span>
                        </div>
                        <h3 class="text-2xl font-bold text-center mb-4">🚀 24/7 Rush</h3>
                        <div class="text-center mb-6">
                            <span class="text-4xl font-bold text-green-400">$15</span>
                            <span class="text-gray-400">/5 days</span>
                        </div>
                        <ul class="space-y-3 mb-6">
                            <li class="flex items-center">
                                <span class="text-green-400 mr-2">✓</span>
                                <span>24/7 Ads-Free Access</span>
                            </li>
                            <li class="flex items-center">
                                <span class="text-green-400 mr-2">✓</span>
                                <span>5 Days Unlimited Content</span>
                            </li>
                            <li class="flex items-center">
                                <span class="text-green-400 mr-2">✓</span>
                                <span>Priority Support</span>
                            </li>
                            <li class="flex items-center">
                                <span class="text-green-400 mr-2">✓</span>
                                <span>Exclusive Collections</span>
                            </li>
                        </ul>
                        <button onclick="selectPlan('rush')" class="w-full bg-red-600 hover:bg-red-700 text-white py-3 rounded-lg font-semibold transition">
                            Get Rush Access
                        </button>
                    </div>

                    <!-- Weekly Plan -->
                    <div class="bg-gray-800 bg-opacity-50 p-6 rounded-xl neon-border plan-card">
                        <h3 class="text-2xl font-bold text-center mb-4">⭐ Weekly Pro</h3>
                        <div class="text-center mb-6">
                            <span class="text-4xl font-bold text-blue-400">$25</span>
                            <span class="text-gray-400">/7 days</span>
                        </div>
                        <ul class="space-y-3 mb-6">
                            <li class="flex items-center">
                                <span class="text-green-400 mr-2">✓</span>
                                <span>7 Days Ads-Free</span>
                            </li>
                            <li class="flex items-center">
                                <span class="text-green-400 mr-2">✓</span>
                                <span>All Premium Content</span>
                            </li>
                            <li class="flex items-center">
                                <span class="text-green-400 mr-2">✓</span>
                                <span>Early Access Features</span>
                            </li>
                            <li class="flex items-center">
                                <span class="text-green-400 mr-2">✓</span>
                                <span>VIP Community Access</span>
                            </li>
                        </ul>
                        <button onclick="selectPlan('weekly')" class="w-full bg-blue-600 hover:bg-blue-700 text-white py-3 rounded-lg font-semibold transition">
                            Get Weekly Pro
                        </button>
                    </div>

                    <!-- Monthly Plan -->
                    <div class="bg-gray-800 bg-opacity-50 p-6 rounded-xl neon-border plan-card">
                        <h3 class="text-2xl font-bold text-center mb-4">💎 Monthly Elite</h3>
                        <div class="text-center mb-6">
                            <span class="text-4xl font-bold text-purple-400">$45</span>
                            <span class="text-gray-400">/30 days</span>
                        </div>
                        <ul class="space-y-3 mb-6">
                            <li class="flex items-center">
                                <span class="text-green-400 mr-2">✓</span>
                                <span>30 Days Unlimited Access</span>
                            </li>
                            <li class="flex items-center">
                                <span class="text-green-400 mr-2">✓</span>
                                <span>All Exclusive Collections</span>
                            </li>
                            <li class="flex items-center">
                                <span class="text-green-400 mr-2">✓</span>
                                <span>Priority Content Updates</span>
                            </li>
                            <li class="flex items-center">
                                <span class="text-green-400 mr-2">✓</span>
                                <span>Personal AI Companion</span>
                            </li>
                        </ul>
                        <button onclick="selectPlan('monthly')" class="w-full bg-purple-600 hover:bg-purple-700 text-white py-3 rounded-lg font-semibold transition">
                            Get Monthly Elite
                        </button>
                    </div>

                    <!-- Quarterly Plan -->
                    <div class="bg-gray-800 bg-opacity-50 p-6 rounded-xl neon-border plan-card">
                        <h3 class="text-2xl font-bold text-center mb-4">👑 Quarterly VIP</h3>
                        <div class="text-center mb-6">
                            <span class="text-4xl font-bold text-yellow-400">$99</span>
                            <span class="text-gray-400">/90 days</span>
                        </div>
                        <ul class="space-y-3 mb-6">
                            <li class="flex items-center">
                                <span class="text-green-400 mr-2">✓</span>
                                <span>90 Days Premium Access</span>
                            </li>
                            <li class="flex items-center">
                                <span class="text-green-400 mr-2">✓</span>
                                <span>All Features Unlocked</span>
                            </li>
                            <li class="flex items-center">
                                <span class="text-green-400 mr-2">✓</span>
                                <span>Custom Content Requests</span>
                            </li>
                            <li class="flex items-center">
                                <span class="text-green-400 mr-2">✓</span>
                                <span>24/7 Dedicated Support</span>
                            </li>
                        </ul>
                        <button onclick="selectPlan('quarterly')" class="w-full bg-yellow-600 hover:bg-yellow-700 text-white py-3 rounded-lg font-semibold transition">
                            Get VIP Access
                        </button>
                    </div>
                </div>

                <!-- Payment Methods -->
                <div class="text-center mt-12">
                    <p class="text-gray-400 mb-4">Accepted Payment Methods:</p>
                    <div class="flex justify-center space-x-6">
                        <span class="text-lg">💳 Credit Card</span>
                        <span class="text-lg">₿ Bitcoin</span>
                        <span class="text-lg">Ξ Ethereum</span>
                        <span class="text-lg">💎 USDT</span>
                    </div>
                </div>
            </div>
        </section>

        <!-- Earning Section -->
        <section id="earn" class="py-16 px-4">
            <div class="container mx-auto max-w-5xl">
                <div class="text-center mb-12">
                    <h2 class="text-3xl md:text-4xl font-bold mb-4">Earn <span class="text-green-400">$10</span> with Our Web3 System</h2>
                    <p class="text-gray-400 max-w-2xl mx-auto">Revolutionary earning opportunities through blockchain technology and premium content.</p>
                </div>
                <div class="grid md:grid-cols-3 gap-8">
                    <div class="bg-gray-800 bg-opacity-50 p-6 rounded-xl neon-border card-hover">
                        <div class="w-12 h-12 rounded-full web3-gradient flex items-center justify-center mb-4">
                            <span class="text-white text-2xl">1</span>
                        </div>
                        <h3 class="text-xl font-semibold mb-2">Complete Tasks</h3>
                        <p class="text-gray-400">Engage with premium content and complete simple tasks to earn rewards.</p>
                    </div>
                    <div class="bg-gray-800 bg-opacity-50 p-6 rounded-xl neon-border card-hover">
                        <div class="w-12 h-12 rounded-full web3-gradient flex items-center justify-center mb-4">
                            <span class="text-white text-2xl">2</span>
                        </div>
                        <h3 class="text-xl font-semibold mb-2">Refer Friends</h3>
                        <p class="text-gray-400">Invite friends and earn commissions from their activities on the platform.</p>
                    </div>
                    <div class="bg-gray-800 bg-opacity-50 p-6 rounded-xl neon-border card-hover">
                        <div class="w-12 h-12 rounded-full web3-gradient flex items-center justify-center mb-4">
                            <span class="text-white text-2xl">3</span>
                        </div>
                        <h3 class="text-xl font-semibold mb-2">Withdraw Earnings</h3>
                        <p class="text-gray-400">Cash out your earnings directly to your crypto wallet with no hassle.</p>
                    </div>
                </div>
            </div>
        </section>

        <!-- Features Section -->
        <section id="features" class="py-16 px-4 bg-gray-900 bg-opacity-50">
            <div class="container mx-auto max-w-5xl">
                <div class="text-center mb-12">
                    <h2 class="text-3xl md:text-4xl font-bold mb-4">Premium <span class="text-purple-400">Features</span></h2>
                    <p class="text-gray-400 max-w-2xl mx-auto">Experience the next generation of adult entertainment with ZBOX's exclusive features.</p>
                </div>
                <div class="grid md:grid-cols-2 gap-8">
                    <div class="bg-gray-800 bg-opacity-50 p-6 rounded-xl neon-border card-hover">
                        <h3 class="text-xl font-semibold mb-2">Exclusive Content</h3>
                        <p class="text-gray-400">Access premium adult content curated for the most discerning tastes.</p>
                    </div>
                    <div class="bg-gray-800 bg-opacity-50 p-6 rounded-xl neon-border card-hover">
                        <h3 class="text-xl font-semibold mb-2">Private Communities</h3>
                        <p class="text-gray-400">Join exclusive communities of like-minded adults for intimate interactions.</p>
                    </div>
                    <div class="bg-gray-800 bg-opacity-50 p-6 rounded-xl neon-border card-hover">
                        <h3 class="text-xl font-semibold mb-2">Web3 Integration</h3>
                        <p class="text-gray-400">Leverage blockchain technology for secure, private transactions and earnings.</p>
                    </div>
                    <div class="bg-gray-800 bg-opacity-50 p-6 rounded-xl neon-border card-hover">
                        <h3 class="text-xl font-semibold mb-2">AI Companions</h3>
                        <p class="text-gray-400">Interact with AI-powered companions for personalized adult experiences.</p>
                    </div>
                </div>
            </div>
        </section>

        <!-- CTA Section -->
        <section class="py-16 px-4">
            <div class="container mx-auto max-w-3xl text-center bg-gray-800 bg-opacity-50 rounded-2xl p-10 neon-border">
                <h2 class="text-3xl md:text-4xl font-bold mb-6">Ready for <span class="text-pink-400">Premium Access</span>?</h2>
                <p class="text-gray-400 mb-8">Join thousands of users enjoying ZBOX's premium adult content and exclusive features.</p>
                <div class="flex flex-col sm:flex-row justify-center gap-4">
                    <a href="#subscriptions" class="bg-pink-600 hover:bg-pink-700 text-white px-8 py-4 rounded-lg font-medium text-lg transition">
                        View Subscription Plans
                    </a>
                    <a href="https://t.me/zboxrobot" class="border border-pink-500 text-pink-300 hover:bg-pink-950 px-8 py-4 rounded-lg font-medium text-lg transition">
                        Launch Free Bot
                    </a>
                </div>
                <p class="text-gray-500 text-sm mt-4">support :: zboxvideo@proton.me 📬</p>
            </div>
        </section>

        <!-- Footer -->
        <footer class="py-8 px-4 border-t border-gray-800">
            <div class="container mx-auto text-center">
                <p class="text-gray-500">© 2024 ZBOX. All rights reserved. For adults only.</p>
                <p class="text-gray-600 text-sm mt-2">Age verification required. Users must be 18+ to access content.</p>
            </div>
        </footer>
    </div>

    <!-- Payment Modal -->
    <div id="paymentModal" class="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center hidden z-50">
        <div class="bg-gray-800 rounded-xl p-8 max-w-md w-full mx-4 neon-border">
            <h3 class="text-2xl font-bold mb-4 text-center" id="modalTitle">Select Payment Method</h3>
            <div class="space-y-4 mb-6">
                <button onclick="processPayment('crypto')" class="w-full bg-blue-600 hover:bg-blue-700 text-white py-3 rounded-lg font-semibold transition">
                    Pay with Crypto
                </button>
                <button onclick="processPayment('card')" class="w-full bg-green-600 hover:bg-green-700 text-white py-3 rounded-lg font-semibold transition">
                    Pay with Credit Card
                </button>
            </div>
            <button onclick="closeModal()" class="w-full bg-gray-600 hover:bg-gray-700 text-white py-3 rounded-lg font-semibold transition">
                Cancel
            </button>
        </div>
    </div>
    <script src="https://cdn.jsdelivr.net/particles.js/2.0.0/particles.min.js"></script>
<script src="lol.js"></script>
</body>
</html> `);
});

app.get('/stats', async (req, res) => {
  try {
    const userCount = await getUserCount();
    const activeUsers = await getActiveUserCount();
    res.json({ userCount, activeUsers });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

app.listen(PORT, () => {
  console.log(`🌙 NightPass server running on port ${PORT}`);
  console.log(`📊 Ads enabled: ${AD_ENABLED}`);
  console.log(`🔗 Referral System: ${AD_ENABLED ? 'Ads Mode' : 'Active'}`);
});
