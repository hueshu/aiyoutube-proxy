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

    console.log('Calling third-party API...');
    
    // Call third-party API with longer timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5 * 60 * 1000); // 5 minutes timeout
    
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
    
    const duration = (Date.now() - startTime) / 1000;
    console.log(`API responded in ${duration}s`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('API error:', response.status, errorText);
      return res.status(response.status).json({ 
        error: `API error: ${response.status}`,
        details: errorText 
      });
    }

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
    
    if (error.name === 'AbortError') {
      res.status(504).json({ error: 'Request timeout after 5 minutes' });
    } else {
      res.status(500).json({ 
        error: error.message || 'Internal server error' 
      });
    }
  }
});

app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});