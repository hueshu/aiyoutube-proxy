# AIYouTube Proxy Server

This proxy server handles long-running AI image generation requests that exceed Cloudflare's timeout limits.

## Deployment to Render.com

1. Push this code to a GitHub repository
2. Go to [Render.com](https://render.com) and sign up/login
3. Click "New +" → "Web Service"
4. Connect your GitHub account and select this repository
5. Configure:
   - **Name**: aiyoutube-proxy
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free
6. Click "Create Web Service"

## Usage

After deployment, your Cloudflare Worker should call this proxy instead of the third-party API directly:

```javascript
// Instead of calling yunwu.ai directly
const PROXY_URL = 'https://your-render-service.onrender.com/api/generate';

const response = await fetch(PROXY_URL, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    model: 'sora_image',
    prompt: 'your prompt',
    imageUrl: 'optional image url',
    imageSize: '[16:9]',
    apiKey: 'your-api-key'
  })
});
```

## Features

- 15-minute timeout (Render free tier)
- Handles both Sora and Gemini models
- Extracts image URLs from responses
- CORS enabled for browser requests
- Health check endpoint at `/`