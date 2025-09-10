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

// Proxy endpoint for image generation (立即返回，后台处理)
app.post('/api/generate/async', async (req, res) => {
  try {
    const { model, prompt, imageUrl, imageSize, apiKey, taskId } = req.body;
    
    if (!apiKey) {
      return res.status(401).json({ error: 'API key required' });
    }

    console.log(`Starting async generation with model: ${model}, taskId: ${taskId}`);
    
    // 立即返回 taskId，让客户端轮询
    res.json({ 
      success: true, 
      taskId: taskId,
      message: 'Generation started'
    });
    
    // 后台继续处理（不阻塞响应）
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
        // Convert image URL to base64 for Gemini
        let base64Data = imageUrl;
        if (imageUrl.startsWith('http')) {
          try {
            console.log('Converting image URL to base64 for Gemini:', imageUrl);
            const imageResponse = await fetch(imageUrl);
            const buffer = await imageResponse.arrayBuffer();
            base64Data = Buffer.from(buffer).toString('base64');
            console.log('Successfully converted to base64, length:', base64Data.length);
          } catch (error) {
            console.error('Failed to convert image to base64:', error);
            // Fall back to using URL directly
            base64Data = imageUrl;
          }
        }
        
        requestBody = {
          contents: [{
            role: 'user',
            parts: [
              { text: `${prompt} ${imageSize}` },
              { inline_data: { mime_type: 'image/jpeg', data: base64Data } }
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
    console.log(`API responded successfully in ${duration}s for taskId: ${taskId}`);

    const data = await response.json();
    // 保存原始响应
    console.log('API Response for taskId', taskId, ':', JSON.stringify(data, null, 2));
    
    // 先存储原始响应，方便调试
    await storeResult(taskId, { 
      success: true, 
      rawResponse: data,
      timestamp: new Date().toISOString()
    });

    // 处理不同模型的响应格式
    let imageUrlResult = null;
    
    if (model === 'sora_image') {
      // Sora 模型返回格式
      if (data.choices && data.choices[0]) {
        const content = data.choices[0].message?.content;
        console.log('Sora content:', content);
        
        if (typeof content === 'string') {
          // 提取URL - 确保匹配完整的URL
          const urlMatch = content.match(/https?:\/\/[^\s\]}"']+\.(jpg|jpeg|png|webp|gif)/i);
          if (urlMatch) {
            imageUrlResult = urlMatch[0];
            console.log('Extracted Sora image URL:', imageUrlResult);
          }
        }
      }
    } else {
      // Gemini 模型返回格式
      console.log('Processing Gemini response...');
      if (data.candidates && data.candidates[0]) {
        const candidate = data.candidates[0];
        console.log('Gemini candidate preview:', JSON.stringify(candidate).substring(0, 500) + '...');
        
        if (candidate.content && candidate.content.parts) {
          for (const part of candidate.content.parts) {
            // 检查是否有base64图片数据（Gemini返回的格式）
            if (part.inlineData && part.inlineData.data && part.inlineData.mimeType) {
              console.log('Found Gemini base64 image data with mimeType:', part.inlineData.mimeType);
              
              // 将base64数据保存为data URL
              const base64Data = part.inlineData.data;
              const mimeType = part.inlineData.mimeType;
              imageUrlResult = `data:${mimeType};base64,${base64Data}`;
              console.log('Created data URL for Gemini image (length):', imageUrlResult.length);
              break;
            }
            // 如果有文本，也记录下来
            else if (part.text) {
              console.log('Gemini text part:', part.text);
              // 尝试从文本中提取图片URL（备用）
              const urlMatch = part.text.match(/https?:\/\/[^\s\]}"']+\.(jpg|jpeg|png|webp|gif)/i);
              if (urlMatch && !imageUrlResult) {
                imageUrlResult = urlMatch[0];
                console.log('Extracted Gemini image URL from text:', imageUrlResult);
              }
            }
          }
        }
      }
    }

    // 最终结果处理
    if (imageUrlResult) {
      console.log('Successfully extracted image URL for taskId', taskId, ':', imageUrlResult);
      // 更新存储结果
      await storeResult(taskId, { 
        success: true, 
        imageUrl: imageUrlResult,
        rawResponse: data 
      });
    } else {
      console.error('Failed to extract image URL from response for taskId:', taskId);
      console.error('Full response data:', JSON.stringify(data, null, 2));
      await storeResult(taskId, { 
        success: false, 
        error: 'No image URL in response', 
        rawResponse: data 
      });
    }
  } catch (error) {
    console.error('Proxy error for taskId', taskId, ':', error);
    // 存储错误状态
    if (taskId) {
      await storeResult(taskId, { 
        success: false, 
        error: error.message || 'Internal server error' 
      });
    }
    
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

// 存储结果的简单内存存储（生产环境应该用 Redis 或数据库）
const results = new Map();

function storeResult(taskId, result) {
  results.set(taskId, {
    ...result,
    timestamp: new Date().toISOString()
  });
  // 30分钟后自动清理
  setTimeout(() => results.delete(taskId), 30 * 60 * 1000);
}

// 查询结果端点
app.get('/api/status/:taskId', (req, res) => {
  const { taskId } = req.params;
  const result = results.get(taskId);
  
  if (!result) {
    res.json({ 
      success: false, 
      status: 'processing',
      message: 'Still generating...'
    });
  } else if (result.success) {
    res.json({ 
      success: true,
      status: 'completed',
      imageUrl: result.imageUrl 
    });
  } else {
    res.json({ 
      success: false,
      status: 'failed',
      error: result.error 
    });
  }
});

// 同步生成端点（保留兼容性）
app.post('/api/generate', async (req, res) => {
  try {
    const { model, prompt, imageUrl, imageSize, apiKey } = req.body;
    
    if (!apiKey) {
      return res.status(401).json({ error: 'API key required' });
    }

    console.log(`Starting sync generation with model: ${model}`);
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
        // Convert image URL to base64 for Gemini
        let base64Data = imageUrl;
        if (imageUrl.startsWith('http')) {
          try {
            console.log('Converting image URL to base64 for Gemini:', imageUrl);
            const imageResponse = await fetch(imageUrl);
            const buffer = await imageResponse.arrayBuffer();
            base64Data = Buffer.from(buffer).toString('base64');
            console.log('Successfully converted to base64, length:', base64Data.length);
          } catch (error) {
            console.error('Failed to convert image to base64:', error);
            // Fall back to using URL directly
            base64Data = imageUrl;
          }
        }
        
        requestBody = {
          contents: [{
            role: 'user',
            parts: [
              { text: `${prompt} ${imageSize}` },
              { inline_data: { mime_type: 'image/jpeg', data: base64Data } }
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

    // 处理不同模型的响应格式
    let imageUrlResult = null;
    
    if (model === 'sora_image') {
      // Sora 模型返回格式
      if (data.choices && data.choices[0]) {
        const content = data.choices[0].message?.content;
        console.log('Sora content:', content);
        
        if (typeof content === 'string') {
          // 提取URL - 确保匹配完整的URL
          const urlMatch = content.match(/https?:\/\/[^\s\]}"']+\.(jpg|jpeg|png|webp|gif)/i);
          if (urlMatch) {
            imageUrlResult = urlMatch[0];
            console.log('Extracted Sora image URL:', imageUrlResult);
          }
        }
      }
    } else {
      // Gemini 模型返回格式
      console.log('Processing Gemini response...');
      if (data.candidates && data.candidates[0]) {
        const candidate = data.candidates[0];
        console.log('Gemini candidate preview:', JSON.stringify(candidate).substring(0, 500) + '...');
        
        if (candidate.content && candidate.content.parts) {
          for (const part of candidate.content.parts) {
            // 检查是否有base64图片数据（Gemini返回的格式）
            if (part.inlineData && part.inlineData.data && part.inlineData.mimeType) {
              console.log('Found Gemini base64 image data with mimeType:', part.inlineData.mimeType);
              
              // 将base64数据保存为data URL
              const base64Data = part.inlineData.data;
              const mimeType = part.inlineData.mimeType;
              imageUrlResult = `data:${mimeType};base64,${base64Data}`;
              console.log('Created data URL for Gemini image (length):', imageUrlResult.length);
              break;
            }
            // 如果有文本，也记录下来
            else if (part.text) {
              console.log('Gemini text part:', part.text);
              // 尝试从文本中提取图片URL（备用）
              const urlMatch = part.text.match(/https?:\/\/[^\s\]}"']+\.(jpg|jpeg|png|webp|gif)/i);
              if (urlMatch && !imageUrlResult) {
                imageUrlResult = urlMatch[0];
                console.log('Extracted Gemini image URL from text:', imageUrlResult);
              }
            }
          }
        }
      }
    }

    // 最终结果处理
    if (imageUrlResult) {
      console.log('Successfully extracted image URL:', imageUrlResult);
      res.json({ 
        success: true, 
        imageUrl: imageUrlResult,
        duration: duration,
        rawResponse: data 
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