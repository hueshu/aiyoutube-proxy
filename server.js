const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'healthy', 
    service: 'AI Image Generation Proxy',
    timestamp: new Date().toISOString()
  });
});

// Helper function to wait
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper function to make API call with retry
async function callAPIWithRetry(apiUrl, requestBody, apiKey, maxRetries = 3) {
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Attempt ${attempt} of ${maxRetries}...`);
      
      // Create a new AbortController for each attempt
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3 * 60 * 1000); // 3 minutes per attempt
      
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`API error on attempt ${attempt}:`, response.status, errorText);
        lastError = new Error(`API error: ${response.status}`);
        
        // Don't retry on client errors (4xx)
        if (response.status >= 400 && response.status < 500) {
          throw lastError;
        }
        
        // Wait before retry for server errors
        if (attempt < maxRetries) {
          const waitTime = Math.min(1000 * Math.pow(2, attempt), 10000); // Exponential backoff, max 10s
          console.log(`Waiting ${waitTime}ms before retry...`);
          await wait(waitTime);
          continue;
        }
      } else {
        // Success!
        return response;
      }
    } catch (error) {
      console.error(`Attempt ${attempt} failed:`, error.message);
      lastError = error;
      
      if (error.name === 'AbortError') {
        console.error('Request timeout');
        lastError = new Error('Request timeout after 3 minutes');
      }
      
      // Wait before retry
      if (attempt < maxRetries) {
        const waitTime = Math.min(1000 * Math.pow(2, attempt), 10000);
        console.log(`Waiting ${waitTime}ms before retry...`);
        await wait(waitTime);
      }
    }
  }
  
  throw lastError || new Error('API call failed after all retries');
}

// Proxy endpoint for image generation
app.post('/api/generate', async (req, res) => {
  try {
    const { model, prompt, imageUrl, imageSize, apiKey } = req.body;
    
    if (!apiKey) {
      return res.status(401).json({ error: 'API key required' });
    }

    console.log(`Starting generation with model: ${model}`);
    const startTime = Date.now();

    // Determine API URL based on model
    const apiUrl = model === 'sora_image' 
      ? 'https://yunwu.ai/v1/chat/completions'
      : 'https://yunwu.ai/v1beta/models/gemini-2.5-flash-image-preview:generateContent';

    // Build request body
    let requestBody;
    if (model === 'sora_image') {
      const content = imageUrl ? [
        { type: 'text', text: `${prompt} ${imageSize}` },
        { type: 'image_url', image_url: { url: imageUrl } }
      ] : `${prompt} ${imageSize}`;
      
      requestBody = {
        model: 'sora_image',
        messages: [{ role: 'user', content }]
      };
    } else {
      // Gemini format
      if (imageUrl) {
        requestBody = {
          contents: [{
            role: 'user',
            parts: [
              { text: `${prompt} ${imageSize}` },
              { inline_data: { mime_type: 'image/jpeg', data: imageUrl } }
            ]
          }]
        };
      } else {
        requestBody = {
          contents: [{
            role: 'user',
            parts: [{ text: `${prompt} ${imageSize}` }]
          }]
        };
      }
    }

    console.log('Calling third-party API with retry logic...');
    
    // Call API with retry
    const response = await callAPIWithRetry(apiUrl, requestBody, apiKey);
    
    const duration = (Date.now() - startTime) / 1000;
    console.log(`API responded successfully in ${duration}s`);

    const data = await response.json();
    console.log('API Response:', JSON.stringify(data, null, 2));

    // Extract image URL based on model
    let imageUrlResult = null;
    
    if (model === 'sora_image') {
      if (data.choices && data.choices[0]) {
        const content = data.choices[0].message?.content;
        if (typeof content === 'string') {
          const urlMatch = content.match(/https?:\/\/[^\s]+\.(jpg|jpeg|png|webp|gif)/i);
          if (urlMatch) {
            imageUrlResult = urlMatch[0];
          }
        }
      }
    } else {
      // Gemini response
      if (data.candidates && data.candidates[0]) {
        const content = data.candidates[0].content;
        if (content && content.parts && content.parts[0]) {
          const text = content.parts[0].text;
          if (text) {
            const urlMatch = text.match(/https?:\/\/[^\s]+\.(jpg|jpeg|png|webp|gif)/i);
            if (urlMatch) {
              imageUrlResult = urlMatch[0];
            }
          }
        }
      }
    }

    // Fallback: check for direct image_url field
    if (!imageUrlResult && data.image_url) {
      imageUrlResult = data.image_url;
    }

    if (imageUrlResult) {
      console.log('Successfully extracted image URL:', imageUrlResult);
      res.json({ 
        success: true, 
        imageUrl: imageUrlResult,
        duration: duration 
      });
    } else {
      console.error('Failed to extract image URL from response');
      res.status(500).json({ 
        error: 'No image URL in response',
        rawResponse: data 
      });
    }
  } catch (error) {
    console.error('Proxy error:', error);
    
    // Return appropriate error status
    if (error.message.includes('timeout')) {
      res.status(504).json({ 
        success: false,
        error: 'Request timeout - API took too long to respond' 
      });
    } else if (error.message.includes('API error: 4')) {
      res.status(400).json({ 
        success: false,
        error: error.message 
      });
    } else {
      res.status(500).json({ 
        success: false,
        error: error.message || 'Internal server error' 
      });
    }
  }
});

app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});