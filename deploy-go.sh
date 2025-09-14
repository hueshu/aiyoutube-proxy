#!/bin/bash

# Deploy Go version to Google Cloud Run
# Usage: ./deploy-go.sh

set -e

PROJECT_ID="aiyoutube-proxy-1757514873"
SERVICE_NAME="aiyoutube-proxy-go"
REGION="us-west1"
IMAGE_NAME="gcr.io/$PROJECT_ID/$SERVICE_NAME"

echo "Building and deploying Go version of proxy server..."

# Build and push Docker image
echo "Building Docker image..."
docker build -f Dockerfile.go -t $IMAGE_NAME .

echo "Pushing to GCR..."
docker push $IMAGE_NAME

# Deploy to Cloud Run
echo "Deploying to Cloud Run..."
gcloud run deploy $SERVICE_NAME \
    --image $IMAGE_NAME \
    --platform managed \
    --region $REGION \
    --allow-unauthenticated \
    --port 8080 \
    --memory 256Mi \
    --cpu 0.5 \
    --max-instances 100 \
    --concurrency 80 \
    --timeout 300 \
    --quiet

# Get service URL
SERVICE_URL=$(gcloud run services describe $SERVICE_NAME --region $REGION --format="value(status.url)")

echo ""
echo "✅ Go proxy deployed successfully!"
echo "Service URL: $SERVICE_URL"
echo ""
echo "To test: curl $SERVICE_URL/health"
echo ""
echo "To compare with Node.js version:"
echo "./test-performance.sh go <api-key> $SERVICE_URL"