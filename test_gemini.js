const fetch = require('node-fetch');

async function testGemini() {
  const apiKey = 'sk-PqOD3XwLGQC8bOqhMSuQQJQgMSo1XjJeXwjCy9DpVCPxHy5t';
  const apiUrl = 'https://yunwu.ai/v1beta/models/gemini-2.5-flash-image-preview:generateContent';
  
  const requestBody = {
    contents: [{
      role: 'user',
      parts: [{ text: '生成一张可爱的猫咪图片 [16:9]' }]
    }]
  };
  
  console.log('Testing Gemini API...');
  console.log('Request:', JSON.stringify(requestBody, null, 2));
  
  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody)
    });
    
    const data = await response.json();
    console.log('Response:', JSON.stringify(data, null, 2));
    
    // Extract text from response
    if (data.candidates && data.candidates[0]) {
      const candidate = data.candidates[0];
      if (candidate.content && candidate.content.parts) {
        for (const part of candidate.content.parts) {
          if (part.text) {
            console.log('\nExtracted text:', part.text);
            // Try to find URL
            const urlMatch = part.text.match(/https?:\/\/[^\s\]}"']+\.(jpg|jpeg|png|webp|gif)/i);
            if (urlMatch) {
              console.log('Found image URL:', urlMatch[0]);
            } else {
              console.log('No image URL found in text');
            }
          }
        }
      }
    }
  } catch (error) {
    console.error('Error:', error);
  }
}

testGemini();
