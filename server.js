const express = require('express');
const cors = require('cors');
const dns = require('dns').promises;
const os = require('os');
const http = require('http');
const https = require('https');

// 优化连接池配置：因为并发=1，不需要太大的连接池
http.globalAgent.maxSockets = 10;
https.globalAgent.maxSockets = 10;
http.globalAgent.keepAlive = true;
https.globalAgent.keepAlive = true;
http.globalAgent.keepAliveMsecs = 1000;
https.globalAgent.keepAliveMsecs = 1000;

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 8080;

// Pre-warm DNS cache for Cloudflare Workers domain
const CLOUDFLARE_WORKER_DOMAIN = 'aiyoutube-backend-prod.hueshu.workers.dev';

// Pre-resolve DNS on startup to warm the cache
(async () => {
  try {
    const addresses = await dns.resolve4(CLOUDFLARE_WORKER_DOMAIN);
    if (addresses && addresses.length > 0) {
      console.log(`DNS cache warmed for ${CLOUDFLARE_WORKER_DOMAIN}: ${addresses[0]}`);
    }
  } catch (error) {
    console.log(`DNS pre-resolution failed:`, error.message);
  }
})();

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'healthy', 
    service: 'AI Image Generation Proxy',
    timestamp: new Date().toISOString(),
    dnsPreResolved: !!cloudflareWorkerHost
  });
});

// Helper function to wait
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Optimized callback function using fetch for better performance in container environments
// fetch performs much better than https.request in GCR containers (55-500ms vs 15-22s)
async function sendCallback(callbackUrl, data) {
  try {
    // Create AbortController for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 seconds timeout
    
    const response = await fetch(callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(data),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    // Don't wait for response body - just check status
    // This allows Workers to return immediately without us waiting for body
    return {
      ok: response.ok,
      status: response.status,
      text: async () => 'Response not read to improve callback speed'
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Request timeout after 30 seconds');
    }
    throw error;
  }
}

// Helper function to get system resource usage
function getResourceUsage() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memUsagePercent = ((usedMem / totalMem) * 100).toFixed(2);
  
  // CPU usage calculation
  const cpus = os.cpus();
  let totalIdle = 0;
  let totalTick = 0;
  
  cpus.forEach(cpu => {
    for (type in cpu.times) {
      totalTick += cpu.times[type];
    }
    totalIdle += cpu.times.idle;
  });
  
  const idle = totalIdle / cpus.length;
  const total = totalTick / cpus.length;
  const cpuUsagePercent = (100 - ~~(100 * idle / total)).toFixed(2);
  
  return {
    memoryMB: {
      total: (totalMem / 1024 / 1024).toFixed(0),
      used: (usedMem / 1024 / 1024).toFixed(0),
      free: (freeMem / 1024 / 1024).toFixed(0),
      percent: memUsagePercent
    },
    cpu: {
      cores: cpus.length,
      percent: cpuUsagePercent
    },
    loadAvg: os.loadavg().map(v => v.toFixed(2))
  };
}

// Track active tasks
let activeTasks = 0;
let totalProcessed = 0;

// Helper function to make API call with retry
async function callAPIWithRetry(apiUrl, requestBody, apiKey, maxRetries = 3, taskId = 'unknown') {
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[${taskId}] Attempt ${attempt} of ${maxRetries}...`);

      // Create a new AbortController for each attempt
      console.log(`[${taskId}] Creating AbortController with 4-minute timeout`);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        console.log(`[${taskId}] TIMEOUT: Aborting request after 4 minutes`);
        controller.abort();
      }, 4 * 60 * 1000); // 4 minutes per attempt

      console.log(`[${taskId}] Sending POST request to ${apiUrl}`);
      const fetchStartTime = Date.now();

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });

      const fetchDuration = ((Date.now() - fetchStartTime) / 1000).toFixed(2);
      console.log(`[${taskId}] Response received after ${fetchDuration}s, status: ${response.status}`);

      clearTimeout(timeoutId);
      console.log(`[${taskId}] Timeout cleared`);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`API error on attempt ${attempt}:`, response.status, errorText);
        
        // Parse error text if it's JSON
        let errorMessage = `API error: ${response.status}`;
        try {
          const errorData = JSON.parse(errorText);
          // Extract error message from various possible formats
          errorMessage = errorData.error || errorData.message || errorData.error_description || errorText;
        } catch (e) {
          // If not JSON, use the raw text
          errorMessage = errorText || `API error: ${response.status}`;
        }
        
        // Include full response in error message instead of as a property
        if (errorText && errorText !== errorMessage) {
          errorMessage = `${errorMessage}\n\nFull Response: ${errorText}`;
        }
        
        lastError = new Error(errorMessage);
        
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
      console.error(`[${taskId}] Attempt ${attempt} failed:`, error.message);
      console.error(`[${taskId}] Error name: ${error.name}, Stack: ${error.stack?.split('\n')[0]}`);
      lastError = error;

      if (error.name === 'AbortError') {
        console.error(`[${taskId}] Request aborted - timeout after 4 minutes`);
        lastError = new Error('Request timeout after 4 minutes');
      }

      // Wait before retry
      if (attempt < maxRetries) {
        const waitTime = Math.min(1000 * Math.pow(2, attempt), 10000);
        console.log(`[${taskId}] Waiting ${waitTime}ms before retry...`);
        await wait(waitTime);
      } else {
        console.log(`[${taskId}] All ${maxRetries} attempts failed`);
      }
    }
  }
  
  throw lastError || new Error('API call failed after all retries');
}

// Test endpoint to measure callback speed from GCR to Cloudflare
app.get('/api/test-callback', async (req, res) => {
  console.log('Testing callback speed to Cloudflare Workers...');
  const startTime = Date.now();
  
  try {
    const testUrl = 'https://aiyoutube-backend-prod.hueshu.workers.dev/api/v1/generation/callback';
    
    const response = await fetch(testUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        taskId: `speed-test-${Date.now()}`,
        parentTaskId: 'test',
        status: 'test',
        imageUrl: 'https://example.com/test.jpg'
      })
    });
    
    const elapsed = Date.now() - startTime;
    const responseText = await response.text();
    
    console.log(`Callback test completed in ${elapsed}ms`);
    
    res.json({
      success: true,
      elapsed_ms: elapsed,
      response_status: response.status,
      response_body: responseText,
      test_time: new Date().toISOString()
    });
  } catch (error) {
    const elapsed = Date.now() - startTime;
    console.error(`Callback test failed after ${elapsed}ms:`, error.message);
    
    res.status(500).json({
      success: false,
      elapsed_ms: elapsed,
      error: error.message
    });
  }
});

// Proxy endpoint for image generation (立即返回，后台处理)
app.post('/api/generate/async', async (req, res) => {
  try {
    const { model, prompt, imageUrl, imageUrls, imageSize, apiKey, taskId, parentTaskId } = req.body;
    // callbackUrl removed - using polling instead
    
    if (!apiKey) {
      return res.status(401).json({ error: 'API key required' });
    }

    console.log(`Starting async generation with model: ${model}, taskId: ${taskId}`);
    // Callback logging removed - using polling instead
    
    // 立即返回 taskId，让客户端轮询
    res.json({ 
      success: true, 
      taskId: taskId,
      message: 'Generation started'
    });
    
    // 使用 setImmediate 确保响应先发送，然后在下一个事件循环中处理
    setImmediate(async () => {
      try {
        await processGeneration(model, prompt, imageUrl, imageUrls, imageSize, apiKey, taskId, parentTaskId);
      } catch (error) {
        console.error('Background processing error:', error);
      }
    });
  } catch (error) {
    console.error('Async endpoint error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// 将后台处理逻辑移到独立函数
async function processGeneration(model, prompt, imageUrl, imageUrls, imageSize, apiKey, taskId, parentTaskId) {
  const startTime = Date.now();  // Move outside try block for finally block access
  try {
    activeTasks++;
    totalProcessed++;
    
    // Log resource usage at start
    const startResources = getResourceUsage();
    console.log(`[RESOURCE_START] Task ${taskId} | Active: ${activeTasks} | Total: ${totalProcessed} | Memory: ${startResources.memoryMB.used}/${startResources.memoryMB.total}MB (${startResources.memoryMB.percent}%) | CPU: ${startResources.cpu.percent}% | Load: [${startResources.loadAvg.join(', ')}]`);

    // Determine API URL based on model
    const apiUrl = model === 'sora_image' 
      ? 'https://yunwu.zeabur.app/v1/chat/completions'
      : 'https://yunwu.zeabur.app/v1beta/models/gemini-2.5-flash-image-preview:generateContent';

    // Handle multiple image URLs - prioritize imageUrls array, fallback to single imageUrl
    const allImageUrls = imageUrls || (imageUrl ? [imageUrl] : []);
    console.log(`[${taskId}] Processing generation with ${allImageUrls.length} images`);
    console.log(`[${taskId}] Model: ${model}, Size: ${imageSize}`);
    
    // Build request body
    let requestBody;
    if (model === 'sora_image') {
      // Build content array with all images
      const content = [];
      content.push({ type: 'text', text: `${prompt} ${imageSize}` });
      
      // Add all images to the content
      for (const imgUrl of allImageUrls) {
        content.push({ type: 'image_url', image_url: { url: imgUrl } });
      }
      
      // If no images, just use text
      const finalContent = allImageUrls.length > 0 ? content : `${prompt} ${imageSize}`;
      
      requestBody = {
        model: 'sora_image',
        messages: [{ role: 'user', content: finalContent }]
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

    console.log(`[${taskId}] Calling third-party API with retry logic...`);

    // Call API with retry
    const response = await callAPIWithRetry(apiUrl, requestBody, apiKey, 3, taskId);
    
    const duration = (Date.now() - startTime) / 1000;
    console.log(`[${taskId}] API call completed successfully in ${duration}s`);

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
      
      // Callback removed - using polling instead
      // Workers will poll /api/status/:taskId to get the result
    } else {
      console.error('Failed to extract image URL from response for taskId:', taskId);
      console.error('Full response data:', JSON.stringify(data, null, 2));
      
      // Extract error message from API response
      let errorMessage = 'No image URL in response';
      
      // Try to extract error from Sora API response
      if (data.choices && data.choices[0] && data.choices[0].message) {
        const content = data.choices[0].message.content;
        if (typeof content === 'string') {
          // Extract failure reason from content (e.g., "生成失败 ❌\n失败原因：input_moderation")
          if (content.includes('生成失败')) {
            errorMessage = content;  // Use the full error message from API
          }
        }
      }
      
      await storeResult(taskId, { 
        success: false, 
        error: errorMessage, 
        rawResponse: data 
      });
      
      // Failure callback removed - using polling instead
    }
  } catch (error) {
    console.error('Proxy error for taskId', taskId, ':', error);
    
    // Get error message - it already includes full response if we modified it above
    const errorMessage = error.message || 'Internal server error';
    
    // 存储错误状态
    if (taskId) {
      await storeResult(taskId, { 
        success: false, 
        error: errorMessage,
        timestamp: new Date().toISOString()
      });
      
      // Error callback removed - using polling instead
    }
    
    // Note: Response already sent, so we can't send error response here
    // The error is stored and will be available via status endpoint
  } finally {
    // Log resource usage at end
    activeTasks--;
    const endResources = getResourceUsage();
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[RESOURCE_END] Task ${taskId} | Duration: ${duration}s | Active: ${activeTasks} | Memory: ${endResources.memoryMB.used}/${endResources.memoryMB.total}MB (${endResources.memoryMB.percent}%) | CPU: ${endResources.cpu.percent}% | Load: [${endResources.loadAvg.join(', ')}]`);
    
    // Warning if resources are high
    if (parseFloat(endResources.memoryMB.percent) > 80) {
      console.warn(`[RESOURCE_WARNING] High memory usage: ${endResources.memoryMB.percent}%`);
    }
    if (parseFloat(endResources.cpu.percent) > 80) {
      console.warn(`[RESOURCE_WARNING] High CPU usage: ${endResources.cpu.percent}%`);
    }
    if (activeTasks > 50) {
      console.warn(`[RESOURCE_WARNING] High concurrent tasks: ${activeTasks}`);
    }
  }
}

// 使用文件系统存储结果（简单的持久化方案）
const fs = require('fs').promises;
const path = require('path');

// 创建临时存储目录
const STORAGE_DIR = path.join('/tmp', 'aiyoutube-results');
fs.mkdir(STORAGE_DIR, { recursive: true }).catch(console.error);

async function storeResult(taskId, result) {
  try {
    const filePath = path.join(STORAGE_DIR, `${taskId}.json`);
    await fs.writeFile(filePath, JSON.stringify({
      ...result,
      timestamp: new Date().toISOString()
    }));
    
    // 30分钟后自动清理
    setTimeout(async () => {
      try {
        await fs.unlink(filePath);
      } catch (err) {
        // File might already be deleted
      }
    }, 30 * 60 * 1000);
  } catch (error) {
    console.error('Failed to store result:', error);
  }
}

async function getResult(taskId) {
  try {
    const filePath = path.join(STORAGE_DIR, `${taskId}.json`);
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    // File doesn't exist or error reading
    return null;
  }
}

// 查询结果端点
app.get('/api/status/:taskId', async (req, res) => {
  const { taskId } = req.params;
  const result = await getResult(taskId);
  
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
      ? 'https://yunwu.zeabur.app/v1/chat/completions'
      : 'https://yunwu.zeabur.app/v1beta/models/gemini-2.5-flash-image-preview:generateContent';

    // Handle multiple image URLs - prioritize imageUrls array, fallback to single imageUrl
    const allImageUrls = imageUrls || (imageUrl ? [imageUrl] : []);
    console.log(`[${taskId}] Processing generation with ${allImageUrls.length} images`);
    console.log(`[${taskId}] Model: ${model}, Size: ${imageSize}`);
    
    // Build request body
    let requestBody;
    if (model === 'sora_image') {
      // Build content array with all images
      const content = [];
      content.push({ type: 'text', text: `${prompt} ${imageSize}` });
      
      // Add all images to the content
      for (const imgUrl of allImageUrls) {
        content.push({ type: 'image_url', image_url: { url: imgUrl } });
      }
      
      // If no images, just use text
      const finalContent = allImageUrls.length > 0 ? content : `${prompt} ${imageSize}`;
      
      requestBody = {
        model: 'sora_image',
        messages: [{ role: 'user', content: finalContent }]
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

    console.log(`[${taskId}] Calling third-party API with retry logic...`);

    // Call API with retry
    const response = await callAPIWithRetry(apiUrl, requestBody, apiKey, 3, taskId);
    
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Proxy server running on http://0.0.0.0:${PORT}`);
});