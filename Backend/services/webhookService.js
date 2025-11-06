const { sendTextMessage, sendButtonMessage } = require('./whatsappService');
const conversationManager = require('./conversationManager');
const { getTemplate } = require('../utils/messageTemplates');
const supabaseStorageService = require('./supabaseStorageService');
const prismaService = require('./prismaService');

/**
 * Process incoming webhook payload from WhatsApp Business API
 */
async function processWebhookPayload(payload) {
  if (payload.object !== 'whatsapp_business_account') {
    console.log('📝 Not a WhatsApp Business webhook, ignoring');
    return;
  }

  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      if (change.field === 'messages' && change.value.messages) {
        for (const message of change.value.messages) {
          await handleIncomingMessage(message);
        }
      }

      // Handle message status updates (delivery, read, etc.)
      if (change.field === 'messages' && change.value.statuses) {
        for (const status of change.value.statuses) {
          handleMessageStatus(status);
        }
      }
    }
  }
}

/**
 * Handle individual incoming messages for feedback collection
 */
async function handleIncomingMessage(message) {
  try {
    console.log(`📱 Processing message from ${message.from}:`, message);

    const userPhone = message.from;
    
    // Handle "share your thoughts" trigger to start feedback flow
    if (message.type === 'text' && message.text) {
      const messageText = message.text.body.toLowerCase().trim();
      
      if (messageText === 'share your thoughts') {
        console.log(`💭 Starting feedback collection for ${userPhone}`);
        const session = await conversationManager.createSession(userPhone);
        const response = getTemplate('greeting');
        await sendTextMessage(userPhone, response);
        return;
      }
    }

    // Get current session
    const session = await conversationManager.getSession(userPhone);
    
    // Process message based on current conversation step
    switch (session.step) {
      case 1:
        await handleNameCollection(message, userPhone, session);
        break;
      case 2:
        await handleYesNoChoice(message, userPhone, session);
        break;
      case 3:
        await handleImageCollection(message, userPhone, session);
        break;
      case 4:
        await handleFeedbackCollection(message, userPhone, session);
        break;
      default:
        // Invalid step, reset to beginning
        console.log(`❌ Invalid step ${session.step} for ${userPhone}, resetting`);
        await conversationManager.resetSession(userPhone);
        const response = getTemplate('greeting');
        await sendTextMessage(userPhone, response);
    }
  } catch (error) {
    console.error('❌ Error handling incoming message:', error);
    
    // Send error message to user
    try {
      const errorResponse = getTemplate('systemError');
      await sendTextMessage(message.from, errorResponse);
    } catch (sendError) {
      console.error('❌ Failed to send error message:', sendError);
    }
    
    throw error;
  }
}

/**
 * Handle name collection (Step 1 → Step 2)
 */
async function handleNameCollection(message, userPhone, session) {
  if (message.type !== 'text' || !message.text) {
    // Wrong input type - expect text
    const response = getTemplate('needText');
    await sendTextMessage(userPhone, response);
    return;
  }

  const name = message.text.body.trim();
  console.log(`📝 Collected name: "${name}" from ${userPhone}`);
  
  // Update session with name and advance to step 2
  await conversationManager.updateSession(userPhone, { name });
  await conversationManager.advanceStep(userPhone);
  
  // Ask if they want to share profile picture with buttons
  const messageText = `Nice to meet you, ${name}! Are you ready to share your profile picture?`;
  const buttons = [
    { id: 'yes', title: 'Yes' },
    { id: 'no', title: 'No' }
  ];
  await sendButtonMessage(userPhone, messageText, buttons);
}

/**
 * Handle Yes/No choice for profile picture (Step 2 → Step 3 or 4)
 */
async function handleYesNoChoice(message, userPhone, session) {
  let choice = '';
  
  // Handle button response
  if (message.type === 'interactive' && message.interactive?.button_reply) {
    choice = message.interactive.button_reply.id.toLowerCase();
    console.log(`🔘 User clicked button: "${choice}" from ${userPhone}`);
  }
  // Handle text response (fallback)
  else if (message.type === 'text' && message.text) {
    choice = message.text.body.toLowerCase().trim();
    console.log(`💬 User typed choice: "${choice}" from ${userPhone}`);
  } else {
    // Wrong input type - expect button or text
    const response = `Please click one of the buttons or reply with "Yes" or "No".`;
    await sendTextMessage(userPhone, response);
    return;
  }
  
  if (choice === 'yes' || choice === 'y') {
    // User wants to share profile picture
    await conversationManager.advanceStep(userPhone); // Go to step 3 (image collection)
    const response = getTemplate('profilePictureYes');
    await sendTextMessage(userPhone, response);
  } else if (choice === 'no' || choice === 'n') {
    // User doesn't want to share profile picture, skip to feedback
    await conversationManager.updateSession(userPhone, { step: 4 }); // Skip to step 4 (feedback)
    const response = getTemplate('profilePictureNo', session.name);
    await sendTextMessage(userPhone, response);
  } else {
    // Invalid choice, ask again with buttons
    const messageText = `Please choose one of the options:`;
    const buttons = [
      { id: 'yes', title: 'Yes' },
      { id: 'no', title: 'No' }
    ];
    await sendButtonMessage(userPhone, messageText, buttons);
  }
}

/**
 * Handle feedback collection (Step 4 → Complete)
 */
async function handleFeedbackCollection(message, userPhone, session) {
  if (message.type !== 'text' || !message.text) {
    // Wrong input type - expect text
    const response = getTemplate('needText');
    await sendTextMessage(userPhone, response);
    return;
  }

  const feedback = message.text.body.trim();
  console.log(`💬 Collected feedback: "${feedback.substring(0, 50)}..." from ${userPhone}`);
  
  // Update session with feedback
  await conversationManager.updateSession(userPhone, { feedback });
  
  // Complete the session
  const completedSession = await conversationManager.completeSession(userPhone);
  
  // Send completion message
  const response = getTemplate('completed', session.name);
  await sendTextMessage(userPhone, response);
}

/**
 * Handle image collection (Step 3 → Step 4)
 */
async function handleImageCollection(message, userPhone, session) {
  if (message.type !== 'image' || !message.image) {
    // Wrong input type - expect image
    const response = getTemplate('needImage');
    await sendTextMessage(userPhone, response);
    return;
  }

  const whatsappImageId = message.image.id; // WhatsApp image ID
  console.log(`📸 Collected image: ${whatsappImageId} from ${userPhone}`);
  
  // Update session with WhatsApp image ID and advance to step 4
  await conversationManager.updateSession(userPhone, { 
    whatsappImageId: whatsappImageId,
    profileImageUrl: null // Will be updated after Supabase upload
  });
  await conversationManager.advanceStep(userPhone);
  
  // Ask for feedback
  const response = getTemplate('profilePictureReceived');
  await sendTextMessage(userPhone, response);
  
  // Process image upload in background (don't wait for completion)
  processImageUploadAsync(whatsappImageId, userPhone, session);
}

/**
 * Process image upload to Supabase Storage asynchronously
 * This runs in the background while user continues with feedback
 */
async function processImageUploadAsync(whatsappImageId, userPhone, session) {
  try {
    console.log(`🔄 Starting background image processing for ${userPhone}`);
    
    // Don't complete session here - it will be completed after feedback collection
    // Just process the image upload
    
    // Upload image to Supabase Storage with temporary filename
    console.log(`📤 Uploading image to Supabase for ${userPhone}`);
    const uploadResult = await supabaseStorageService.uploadWhatsAppImage(
      whatsappImageId, 
      userPhone, 
      `temp_${Date.now()}` // Temporary ID until feedback is completed
    );
    
    if (uploadResult.success) {
      // Update session with Supabase image URL
      await conversationManager.updateSession(userPhone, {
        profileImageUrl: uploadResult.publicUrl
      });
      
      console.log(`✅ Image processing completed for ${userPhone}: ${uploadResult.publicUrl}`);
    } else {
      console.error(`❌ Image upload failed for ${userPhone}:`, uploadResult.error);
      
      // Update session with error info
      await conversationManager.updateSession(userPhone, {
        profileImageUrl: `error: ${uploadResult.error}`
      });
    }
    
  } catch (error) {
    console.error(`❌ Error in background image processing for ${userPhone}:`, error);
  }
}



/**
 * Handle message status updates (delivery, read, etc.)
 */
function handleMessageStatus(status) {
  console.log('📊 Message status update:', {
    messageId: status.id,
    recipientId: status.recipient_id,
    status: status.status,
    timestamp: status.timestamp
  });
}

/**
 * Simulate webhook for testing feedback collection
 */
async function simulateWebhook(testMessage, phoneNumber) {
  const mockPayload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'test-entry',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: {
            display_phone_number: process.env.WHATSAPP_PHONE_NUMBER_ID || '15550617327',
            phone_number_id: process.env.WHATSAPP_PHONE_NUMBER_ID || '158282837372377'
          },
          messages: [{
            id: `test-message-${Date.now()}`,
            from: phoneNumber,
            timestamp: Math.floor(Date.now() / 1000).toString(),
            text: { body: testMessage },
            type: 'text'
          }]
        }
      }]
    }]
  };

  console.log('🧪 Simulating feedback collection webhook');
  await processWebhookPayload(mockPayload);
  
  return {
    success: true,
    message: 'Feedback collection test completed',
    testMessage,
    phoneNumber,
    timestamp: new Date().toISOString()
  };
}

/**
 * Simulate image message for testing
 */
async function simulateImageWebhook(phoneNumber, imageId = 'test-image-123') {
  const mockPayload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'test-entry',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: {
            display_phone_number: process.env.WHATSAPP_PHONE_NUMBER_ID || '15550617327',
            phone_number_id: process.env.WHATSAPP_PHONE_NUMBER_ID || '158282837372377'
          },
          messages: [{
            id: `test-image-${Date.now()}`,
            from: phoneNumber,
            timestamp: Math.floor(Date.now() / 1000).toString(),
            type: 'image',
            image: { id: imageId }
          }]
        }
      }]
    }]
  };

  console.log('🧪 Simulating image webhook');
  await processWebhookPayload(mockPayload);
  
  return {
    success: true,
    message: 'Image webhook test completed',
    phoneNumber,
    imageId,
    timestamp: new Date().toISOString()
  };
}

module.exports = {
  processWebhookPayload,
  handleIncomingMessage,
  handleMessageStatus,
  simulateWebhook,
  simulateImageWebhook
};