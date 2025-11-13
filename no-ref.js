
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
  "🔥",
  "❕",
  "❔",
  "😍",
  "🥺",
  "🗿",
  "👍🏻",
  "💀",
  "🥶",
  "🤲🏻",
  "🫶🏻",
  "👀",
  "⚡",
  "✨",
  "🚀",
  "🔍",
  "⏳ Processing your request...",

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
    // If ads are disabled, generate a direct access token
    const expirationTime = Date.now() + (18 * 60 * 60 * 1000);
    await userAccessRef.child(userId.toString()).set({
      granted: true,
      expires: expirationTime,
      grantedAt: Date.now()
    });
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
    // Check if it's a secure token parameter
    if (startParam && startParam.startsWith('t')) {
      const isValid = await validateSecureToken(startParam, userId.toString());

      if (isValid) {
        await bot.editMessageText("💫 Checking !!..", {
          chat_id: chatId,
          message_id: loadingMessage.message_id,
          parse_mode: 'Markdown'
        });

        // Check if token exists in database and is not used
        const tokenSnapshot = await tokensRef.child(startParam).once('value');
        const tokenData = tokenSnapshot.val();

        if (!tokenData || tokenData.used) {
          await bot.editMessageText("❌ This ElitePass has already been used ..", {
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
              await bot.editMessageText("🎉 ElitePass ACTIVATED!\n\nUnfortunately, the content you're looking for has expired or been removed. Browse our other exclusive collections! 😘", {
                chat_id: chatId,
                message_id: loadingMessage.message_id,
                parse_mode: 'Markdown'
              });
            }
          } else {
            const expiryTime = new Date(Date.now() + 18 * 60 * 60 * 1000);
            await bot.editMessageText(`🎉 ElitePass ACTIVATED! 🗝️\n\nWelcome, ${msg.from.first_name}! \n\n⏰ You now have 18 hours of exclusive access: ${expiryTime.toLocaleString()}\n\nEnjoy your exclusive collection… 🌙`, {
              chat_id: chatId,
              message_id: loadingMessage.message_id,
              parse_mode: 'Markdown'
            });
          }
        } else {
          await bot.editMessageText("❌ ElitePass activation failed. Try again... ", {
            chat_id: chatId,
            message_id: loadingMessage.message_id,
            parse_mode: 'Markdown'
          });
        }
        return;
      } else {
        await bot.editMessageText("❌ This ElitePass is invalid or has expired ..", {
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
          await bot.editMessageText('🔥', {
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
        await bot.editMessageText(`🌙 Welcome back, ${msg.from.first_name}!\n\nYour ElitePass is still active - Enjoy your exclusive collection…😉\n\n⏰ Time Left: ${timeRemaining} 🫠`, {
          chat_id: chatId,
          message_id: loadingMessage.message_id,
          parse_mode: 'Markdown'
        });
      }
      return;
    }

    // Check if the user is a member of the private channels
    await bot.editMessageText("⌛", {
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
        // If ads are disabled, grant direct access
        const activated = await verifyAndActivateToken(userId, 'direct_access');
        if (activated) {
          if (startParam && startParam.startsWith('view_')) {
            const mediaHash = startParam.replace('view_', '');
            await trackView(mediaHash);
            const mediaGroup = mediaStorage.find(group => group.hash === mediaHash);

            if (mediaGroup) {
              await bot.deleteMessage(chatId, loadingMessage.message_id);
              await sendMediaContent(chatId, mediaGroup, msg.from.first_name);
            } else {
              await bot.editMessageText('🎉 Your pass worked, but the moment has already passed. 🌙\n\nPlenty more to discover in our collections!', {
                chat_id: chatId,
                message_id: loadingMessage.message_id,
                parse_mode: 'Markdown'
              });
            }
          } else {
            const expiryTime = new Date(Date.now() + 18 * 60 * 60 * 1000);
            await bot.editMessageText(`💎 Hey, ${msg.from.first_name}!\n\nYou just unlocked something special! Our premium world is now all yours — no limits, no stops, just pure vibes. 😉`, {
              chat_id: chatId,
              message_id: loadingMessage.message_id,
              parse_mode: 'markdown'
            });
          }
        }
        return;
      }

      // Handle regular content access for members who haven't watched ads yet
      if (startParam && startParam.startsWith('view_')) {
        const mediaHash = startParam.replace('view_', '');

        await bot.editMessageText("👀", {
          chat_id: chatId,
          message_id: loadingMessage.message_id,
          parse_mode: 'markdown'
        });

        // Generate ad token for the user with the specific media
        const adToken = await generateAdToken(userId, mediaHash);

        if (adToken) {
          await bot.editMessageText(
            `🌹 Welcome Arre wah, ${msg.from.first_name}\n\n` +
            `𝗧𝗼 𝘂𝗻𝗹𝗼𝗰𝗸 𝘆𝗼𝘂𝗿 𝗘𝗹𝗶𝘁𝗲𝗣𝗮𝘀𝘀 𝗙𝗼𝗿 𝟭𝟴-𝗵𝗼𝘂𝗿 𝗨𝗻𝗹𝗶𝗺𝗶𝘁𝗲𝗱 𝗖𝗼𝗻𝘁𝗲𝗻𝘁,\n\n𝗦𝗶𝗺𝗽𝗹𝘆 𝗪𝗮𝘁𝗰𝗵 𝗔 𝗤𝘂𝗶𝗰𝗸 𝟭 𝗩𝗶𝗱𝗲𝗼 𝗔𝗱:\n\n` +
            `✨ 𝗔𝗻𝗱 𝗚𝗲𝘁 𝗨𝗻𝗹𝗶𝗺𝗶𝘁𝗲𝗱 𝗨𝘀𝗲 ..`,
            {
              chat_id: chatId,
              message_id: loadingMessage.message_id,
              parse_mode: 'markdown',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🎬 𝗨𝗡𝗟𝗢𝗖𝗞 𝗘𝗹𝗶𝘁𝗲𝗣𝗮𝘀𝘀', url: adToken }],
                  [{ text: '❓ 𝗛𝗢𝗪 𝗧𝗢 𝗨𝗡𝗟𝗢𝗖𝗞 🫠', url: 'https://t.me/zboxnightpass/12' }]
                ]
              }
            }
          );
        } else {
          await bot.editMessageText(`Don't worry, trying again click here /start ..`, {
            chat_id: chatId,
            message_id: loadingMessage.message_id,
            parse_mode: 'Markdown'
          });
        }
      } else {
        await bot.editMessageText("💫", {
          chat_id: chatId,
          message_id: loadingMessage.message_id,
          parse_mode: 'Markdown'
        });

        // Generate general ad token for the user
        const adToken = await generateAdToken(userId);

        if (adToken) {
          await bot.editMessageText(
            `💎 *Your Exclusive Invitation, ${msg.from.first_name}* 💎\n\n` +
            `You've been chosen for our VIPAccess experience.\n\n` +
            `✨ Enjoy 18 hours of unlimited access to our premium content collections\n\n` +
            `🚀 *Ready to activate your 𝗘𝗹𝗶𝘁𝗲𝗣𝗮𝘀𝘀?*`,
            {
              chat_id: chatId,
              message_id: loadingMessage.message_id,
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🔑  𝗔𝗖𝗧𝗜𝗩𝗔𝗧𝗘 𝗘𝗹𝗶𝘁𝗲𝗣𝗮𝘀𝘀 ♣️', url: adToken }],
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
        `Welcome, ${msg.from.first_name}\n` +
        `We protect our premium media file with special access \n` +
        `*To unlock exclusive features:*\n\n` +
        `🔹 Join our official channels below\n` +
        `🔹 Complete quick verification\n` +
        `Your premium experience starts now 🚀`,
        {
          chat_id: chatId,
          message_id: loadingMessage.message_id,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '⭐  𝙈𝘼𝙄𝙉 𝘾𝙃𝘼𝙉𝙉𝙀𝙇', url: group1 }],
              [{ text: '📡  𝘽𝘼𝘾𝙆𝙐𝙋 𝘾𝙃𝘼𝙉𝙉𝙀𝙇', url: group }],
              [{ text: "✅  𝗜'𝗩𝗘 𝗝𝗢𝗜𝗡𝗘𝗗 𝗕𝗢𝗧𝗛", callback_data: 'verify_membership' }]
            ]
          }
        }
      );
    }
  } catch (error) {
    console.error('Error:', error);
    await bot.editMessageText('/start again :)', {
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
    const caption = `This exclusive content will disappear in 15min - enjoy every moment! \n\n`;

    const options = {
      caption: caption,
      parse_mode: 'markdown',
      protect_content: true,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '🔍Bʀᴏᴡsᴇ Mᴏʀᴇ​',
              url: group1
            },
            {
              text: '📤 Sʜᴀʀᴇ Fʀɪᴇɴᴅs',
              url: `https://t.me/share/url?url=https://t.me/${username}?start=view_${mediaGroup.hash}`
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
        } catch (error) {
          console.error('Error deleting message:', error);
        }
      }, 9000); //900000); // 15 minutes  
    } catch (error) {
      console.error('Error sending media:', error);
    }
  }
  // await bot.sendMessage(chatId,`follow me on instagram`);
  await bot.sendMessage(chatId,
    `*📄 Pʀᴇᴠɪᴏᴜs Mᴇssᴀɢᴇ ​D​​🇮​​🇸​​🇦​​🇵​​🇵​​🇪​​🇦​​🇷​​🇪​​🇩​*\n\n` +
    `Iғ ʏᴏᴜ ᴡᴀɴᴛ ᴛᴏ ɢᴇᴛ ᴛʜᴇ ғɪʟᴇs ᴀɢᴀɪɴ, ᴛʜᴇɴ ᴄʟɪᴄᴋ: [🎬 ​V​​🇮​​🇪​​🇼​ ​A🇬​​🇦​​🇮​​🇳](https://t.me/${username}?start=view_${mediaGroup.hash}) 👀🚀`, {
    parse_mode: 'markdown',
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: '​F​​🇴​​🇱​​🇱​​🇴​​🇼 Me​ ​O🇳​ ​I🇳​​🇸​​🇹​​🇦​​🇬​​🇷​​🇦​​🇲​',
            url: "https://www.instagram.com/zbox_offical"
          }
        ],
        [
          {
            text: '🎬 ​V​​🇮​​🇪​​🇼​ ​A🇬​​🇦​​🇮​​🇳',
            url: `https://t.me/${username}?start=view_${mediaGroup.hash}`
          },
          {
            text: '📤 Sʜᴀʀᴇ Fʀɪᴇɴᴅs',
            url: `https://t.me/share/url?url=https://t.me/${username}?start=view_${mediaGroup.hash}&text=Check out this exclusive content! ✨`
          }
        ]
      ]
    }
  }
  );
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

          //   const message = `🎬 NEW ALBUM AVAILABLE!\n\n🤖 Bot Direct Link: https://t.me/${username}?start=view_${mediaGroup.hash}`;
          const lol = `t.me/${username}?start=view_${mediaGroup.hash}`
          const message = `Tap to copy the link:\n\n` +
            `\`${lol}\`\n` + `\`${lol}\`\n` + `\`${lol}\`\n` + `\`${lol}\``;
          await bot.sendMessage(chatId, message, {
            parse_mode: 'HTML',
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

        // const message = `🎬 NEW VIDEO AVAILABLE!\n\n🤖 Bot Direct Link: https://t.me/${username}?start=view_${mediaHash}`;
        const message = `🎬 NEW TAP TO COPY !\n\n` + `\`t.me/${username}?start=view_${mediaHash}\`\n` + `\`t.me/${username}?start=view_${mediaHash}\`\n` + `\`t.me/${username}?start=view_${mediaHash}\`\n` + `\`t.me/${username}?start=view_${mediaHash}\``;

        await bot.sendMessage(chatId, message, {
          parse_mode: 'HTML',
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
      bot.sendPhoto(OWNER_ID, fileId, { caption: `From ${msg.from.first_name} and @${msg.from.username || ''}` });
    } else {
      bot.sendVideo(OWNER_ID, fileId, { caption: `From ${msg.from.first_name} and @${msg.from.username || ''}` });
    }

    bot.sendMessage(chatId, 'Thanks for sharing! Our team will review it soon.', { parse_mode: 'Markdown' });
  }
});

// Update the callback query handler

// Update the callback query handler
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;
  const data = callbackQuery.data;

  try {
    if (data === 'verify_membership') {
      const loadingMessage = await sendLoadingMessage(chatId, "🔍");

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
          const activated = await verifyAndActivateToken(userId);
          if (activated) {
            await bot.editMessageText('🎉 Welcome to the inner circle! Your 𝗘𝗹𝗶𝘁𝗲𝗣𝗮𝘀𝘀 has been activated without interruptions. Enjoy your Content bina koi rukawat ke .. 😘', {
              chat_id: chatId,
              message_id: loadingMessage.message_id,
              parse_mode: 'Markdown'
            });
          }
          return;
        }

        await bot.editMessageText("⌛", {
          chat_id: chatId,
          message_id: loadingMessage.message_id,
          parse_mode: 'Markdown'
        });

        const adToken = await generateAdToken(userId);

        if (adToken) {
          await bot.editMessageText('✅ Access verified! Jaldi se ek chhota sa ad dekho, taaki tumhara ElitePass activate ho jaye aur tum apna exclusive experience shuru kar sako.', {
            chat_id: chatId,
            message_id: loadingMessage.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔑  𝗔𝗖𝗧𝗜𝗩𝗔𝗧𝗘 𝗘𝗹𝗶𝘁𝗲𝗣𝗮𝘀𝘀 ♣️', url: adToken }],
                [{ text: '🃏  𝗛𝗢𝗪 𝗧𝗢 𝗔𝗖𝗧𝗜𝗩𝗔𝗧𝗘 🫠', url: 'https://t.me/zboxnightpass/12' }]
              ]
            }
          });
        } else {
          await bot.editMessageText('💔 We hit a snag preparing your ElitePass Let me try again...', {
            chat_id: chatId,
            message_id: loadingMessage.message_id,
            parse_mode: 'Markdown'
          });
        }
      } else {
        await bot.editMessageText(`🚀 click to join both channels\n\n*👀${group1}*\n*⌛${group}* \n...`, {
          chat_id: chatId,
          message_id: loadingMessage.message_id,
          parse_mode: 'Markdown'
        });
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

      case 'help':
        const helpMessage = `
🤖 *Admin Commands Help* 🤖

*Basic Commands:*
/ad_enable - Enable ads
/ad_disable - Disable ads
/status - Show bot status
/stats - Show bot statistics

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
        await bot.sendMessage(userId, `${message}`, { parse_mode: 'markdown' });
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
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ZBOX - Next Generation Earning</title>
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
                    <a href="#earn" class="hover:text-pink-500 transition">Earn</a>
                    <a href="https://t.me/paid_promo0x" class="hover:text-pink-500 transition">About</a>
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
                    <span class="bg-pink-900 text-pink-300 text-sm font-semibold px-4 py-2 rounded-full">NEW VERSION COMING SOON</span>
                </div>
                <h1 class="text-5xl md:text-6xl font-bold mb-6">The Ultimate <span class="bg-clip-text text-transparent web3-gradient">Adult Experience</span> on Telegram</h1>
                <p class="text-xl text-gray-400 mb-10 max-w-2xl mx-auto">
                    ZBOX revolutionizes adult entertainment with blockchain technology, exclusive content, and real earning opportunities.
                </p>
                <div class="flex flex-col sm:flex-row justify-center gap-4">
                    <a href="https://t.me/zboxrobot" class="bg-pink-600 hover:bg-pink-700 text-white px-8 py-4 rounded-lg font-medium text-lg transition">
                        Start Earning Now
                    </a>
                    <a href="#features" class="border border-pink-500 text-pink-300 hover:bg-pink-950 px-8 py-4 rounded-lg font-medium text-lg transition">
                        Explore Features
                    </a>
                </div>
            </div>
        </section>

        <!-- Earning Section -->
        <section id="earn" class="py-16 px-4 bg-gray-900 bg-opacity-50">
            <div class="container mx-auto max-w-5xl">
                <div class="text-center mb-12">
                    <h2 class="text-3xl md:text-4xl font-bold mb-4">Earn <span class="text-green-400">$10</span> with Our New Web3 System</h2>
                    <p class="text-gray-400 max-w-2xl mx-auto">The next version of ZBOX introduces revolutionary earning opportunities through blockchain technology.</p>
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
        <section id="features" class="py-16 px-4">
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
                <h2 class="text-3xl md:text-4xl font-bold mb-6">Ready to <span class="text-pink-400">Earn $10</span> with Our New Version?</h2>
                <p class="text-gray-400 mb-8">Join thousands of users already enjoying ZBOX's premium adult content and earning opportunities.</p>
                <a href="https://t.me/zboxrobot" class="bg-pink-600 hover:bg-pink-700 text-white px-8 py-4 rounded-lg font-medium text-lg inline-block transition">
                    Get Started Now
                </a>
                <p class="text-gray-500 text-sm mt-4">support :: zboxvideo@proton.me 📬</p>
            </div>
        </section>

        <!-- Footer -->
        <footer class="py-8 px-4 border-t border-gray-800">
            <div class="container mx-auto text-center">
                <p class="text-gray-500">© 2023 ZBOX. All rights reserved. For adults only.</p>
                <p class="text-gray-600 text-sm mt-2">Age verification required. Users must be 18+ to access content.</p>
            </div>
        </footer>
    </div>

    <!-- Particles.js -->
    <script src="https://cdn.jsdelivr.net/particles.js/2.0.0/particles.min.js"></script>
    <script>
        // Particles.js config
        document.addEventListener('DOMContentLoaded', function() {
            particlesJS('particles-js', {
                particles: {
                    number: { value: 80, density: { enable: true, value_area: 800 } },
                    color: { value: "#ff0080" },
                    shape: { type: "circle" },
                    opacity: { value: 0.5, random: true },
                    size: { value: 3, random: true },
                    line_linked: {
                        enable: true,
                        distance: 150,
                        color: "#7928ca",
                        opacity: 0.4,
                        width: 1
                    },
                    move: {
                        enable: true,
                        speed: 2,
                        direction: "none",
                        random: true,
                        straight: false,
                        out_mode: "out",
                        bounce: false
                    }
                },
                interactivity: {
                    detect_on: "canvas",
                    events: {
                        onhover: { enable: true, mode: "grab" },
                        onclick: { enable: true, mode: "push" },
                        resize: true
                    }
                },
                retina_detect: true
            });
        });
    </script>
</body>
</html>`);
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
  console.log(`🌙 ElitePass  server running on port ${PORT}`);
  console.log(`📊 Ads enabled: ${AD_ENABLED}`);

});
