package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// Constants
const (
	DefaultTimeout     = 4 * time.Minute
	MaxRetries        = 3
	MaxConcurrency    = 10
	DefaultPort       = "8080"
	MemoryMB          = 512
)

// Global metrics
var (
	activeTasks    int32
	totalProcessed int64
	taskResults    = &sync.Map{} // In-memory storage for task results
	httpClient     *http.Client  // Global HTTP client with proper configuration
)

// Request structures matching Node.js version
type GenerateRequest struct {
	Model        string   `json:"model"`
	Prompt       string   `json:"prompt"`
	ImageURL     string   `json:"imageUrl,omitempty"`
	ImageURLs    []string `json:"imageUrls,omitempty"`
	ImageSize    string   `json:"imageSize,omitempty"`
	APIKey       string   `json:"apiKey"`
	TaskID       string   `json:"taskId"`
	ParentTaskID string   `json:"parentTaskId,omitempty"`
	CallbackURL  string   `json:"callbackUrl,omitempty"`
}

type GenerateResponse struct {
	Success  bool   `json:"success"`
	TaskID   string `json:"taskId,omitempty"`
	ImageURL string `json:"imageUrl,omitempty"`
	Error    string `json:"error,omitempty"`
	Message  string `json:"message,omitempty"`
}

type TaskResult struct {
	Success     bool            `json:"success"`
	ImageURL    string          `json:"imageUrl,omitempty"`
	Error       string          `json:"error,omitempty"`
	RawResponse json.RawMessage `json:"rawResponse,omitempty"`
	Timestamp   string          `json:"timestamp"`
}

type CallbackPayload struct {
	TaskID       string `json:"taskId"`
	ParentTaskID string `json:"parentTaskId,omitempty"`
	Status       string `json:"status"`
	ImageURL     string `json:"imageUrl,omitempty"`
	Error        string `json:"error,omitempty"`
}

// Resource monitoring
type ResourceUsage struct {
	MemoryMB struct {
		Used    float64 `json:"used"`
		Total   float64 `json:"total"`
		Percent float64 `json:"percent"`
	} `json:"memoryMB"`
	CPU struct {
		Percent float64 `json:"percent"`
	} `json:"cpu"`
	LoadAvg []float64 `json:"loadAvg"`
}

func getResourceUsage() ResourceUsage {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)

	usage := ResourceUsage{}
	usage.MemoryMB.Used = float64(m.Alloc) / 1024 / 1024
	usage.MemoryMB.Total = float64(MemoryMB)
	usage.MemoryMB.Percent = (usage.MemoryMB.Used / usage.MemoryMB.Total) * 100

	// Note: CPU percentage and load average would require additional libraries
	// For now, we'll use goroutine count as a proxy
	usage.CPU.Percent = float64(runtime.NumGoroutine())

	return usage
}

// Helper function to extract image URL from response
func extractImageURL(data json.RawMessage, model string) (string, error) {
	// Handle OpenAI/Sora format
	if model == "sora" || model == "sora_image" {
		var openAIResp struct {
			Choices []struct {
				Message struct {
					Content string `json:"content"`
				} `json:"message"`
			} `json:"choices"`
		}
		if err := json.Unmarshal(data, &openAIResp); err == nil && len(openAIResp.Choices) > 0 {
			content := openAIResp.Choices[0].Message.Content
			// Extract URL from content using regex-like pattern
			if content != "" {
				// Check if generation failed (云雾API error format)
				if findSubstring(content, "生成失败") != -1 || findSubstring(content, "失败原因") != -1 {
					// Return the error message as an error
					return "", fmt.Errorf("generation failed: %s", content)
				}

				// Look for URL pattern in content
				startIdx := -1
				endIdx := -1

				// Find https:// or http://
				if idx := findSubstring(content, "https://"); idx != -1 {
					startIdx = idx
				} else if idx := findSubstring(content, "http://"); idx != -1 {
					startIdx = idx
				}

				if startIdx != -1 {
					// Find the end of URL (space, parenthesis, or end of string)
					for i := startIdx; i < len(content); i++ {
						if content[i] == ' ' || content[i] == '\n' || content[i] == '"' || content[i] == '\'' ||
						   content[i] == ']' || content[i] == '}' || content[i] == ')' || content[i] == '(' {
							endIdx = i
							break
						}
					}
					if endIdx == -1 {
						endIdx = len(content)
					}

					url := content[startIdx:endIdx]
					// Check if it looks like an image URL
					if findSubstring(url, ".jpg") != -1 || findSubstring(url, ".jpeg") != -1 ||
					   findSubstring(url, ".png") != -1 || findSubstring(url, ".webp") != -1 ||
					   findSubstring(url, ".gif") != -1 {
						return url, nil
					}
				}
			}
		}
	}

	// Handle Gemini format
	if model == "gemini" {
		var geminiResp struct {
			Candidates []struct {
				Content struct {
					Parts []struct {
						Text       string `json:"text,omitempty"`
						InlineData struct {
							MimeType string `json:"mimeType"`
							Data     string `json:"data"`
						} `json:"inlineData,omitempty"`
					} `json:"parts"`
				} `json:"content"`
			} `json:"candidates"`
		}
		if err := json.Unmarshal(data, &geminiResp); err == nil && len(geminiResp.Candidates) > 0 {
			for _, part := range geminiResp.Candidates[0].Content.Parts {
				// Check for base64 image data
				if part.InlineData.Data != "" && part.InlineData.MimeType != "" {
					// Return as data URL
					return fmt.Sprintf("data:%s;base64,%s", part.InlineData.MimeType, part.InlineData.Data), nil
				}
				// Check text for URLs
				if part.Text != "" {
					// Try to extract URL from text
					if idx := findSubstring(part.Text, "https://"); idx != -1 {
						startIdx := idx
						endIdx := len(part.Text)
						for i := startIdx; i < len(part.Text); i++ {
							if part.Text[i] == ' ' || part.Text[i] == '\n' {
								endIdx = i
								break
							}
						}
						url := part.Text[startIdx:endIdx]
						if findSubstring(url, ".jpg") != -1 || findSubstring(url, ".png") != -1 {
							return url, nil
						}
					}
				}
			}
		}
	}

	return "", fmt.Errorf("no image URL found in response")
}

// Helper function to find substring
func findSubstring(s, substr string) int {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return i
		}
	}
	return -1
}

// Send callback to Workers
func sendCallback(callbackURL string, payload CallbackPayload) error {
	if callbackURL == "" {
		return nil
	}

	log.Printf("[%s] Sending callback to %s", payload.TaskID, callbackURL)
	startTime := time.Now()

	jsonData, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal callback payload: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "POST", callbackURL, bytes.NewBuffer(jsonData))
	if err != nil {
		return fmt.Errorf("failed to create callback request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("callback request failed: %w", err)
	}
	defer resp.Body.Close()

	duration := time.Since(startTime).Milliseconds()
	log.Printf("[%s] Callback %s in %dms", payload.TaskID, resp.Status, duration)

	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("callback returned error %d: %s", resp.StatusCode, string(body))
	}

	return nil
}

// Call API with retry logic
func callAPIWithRetry(apiURL string, requestBody map[string]interface{}, apiKey string, taskID string) (json.RawMessage, error) {
	var lastError error

	for attempt := 1; attempt <= MaxRetries; attempt++ {
		log.Printf("[%s] Attempt %d of %d...", taskID, attempt, MaxRetries)

		// Create timeout context
		ctx, cancel := context.WithTimeout(context.Background(), DefaultTimeout)
		defer cancel()

		log.Printf("[%s] Creating context with 4-minute timeout", taskID)
		log.Printf("[%s] Sending POST request to %s", taskID, apiURL)

		startTime := time.Now()

		// Prepare request body
		jsonData, err := json.Marshal(requestBody)
		if err != nil {
			lastError = fmt.Errorf("failed to marshal request: %w", err)
			continue
		}

		// Create request with context
		req, err := http.NewRequestWithContext(ctx, "POST", apiURL, bytes.NewBuffer(jsonData))
		if err != nil {
			lastError = fmt.Errorf("failed to create request: %w", err)
			continue
		}

		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", apiKey))

		// Send request
		resp, err := httpClient.Do(req)

		duration := time.Since(startTime).Seconds()

		if err != nil {
			if ctx.Err() == context.DeadlineExceeded {
				log.Printf("[%s] TIMEOUT: Request aborted after 4 minutes", taskID)
				lastError = fmt.Errorf("request timeout after 4 minutes")
			} else {
				lastError = fmt.Errorf("request failed: %w", err)
			}

			// Retry on timeout or network error
			if attempt < MaxRetries {
				waitTime := time.Duration(attempt) * 2 * time.Second
				log.Printf("[%s] Retrying after %v...", taskID, waitTime)
				time.Sleep(waitTime)
				continue
			}
			continue
		}
		defer resp.Body.Close()

		log.Printf("[%s] Response received after %.2fs, status: %d", taskID, duration, resp.StatusCode)

		// Read response body
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			lastError = fmt.Errorf("failed to read response: %w", err)
			continue
		}

		// Check status code
		if resp.StatusCode >= 400 {
			errorMsg := fmt.Sprintf("API returned error %d: %s", resp.StatusCode, string(body))
			log.Printf("[%s] %s", taskID, errorMsg)

			// Don't retry on client errors (4xx)
			if resp.StatusCode >= 400 && resp.StatusCode < 500 {
				return nil, fmt.Errorf(errorMsg)
			}

			lastError = fmt.Errorf(errorMsg)

			// Retry on server errors
			if attempt < MaxRetries {
				waitTime := time.Duration(attempt) * 2 * time.Second
				log.Printf("[%s] Retrying after %v...", taskID, waitTime)
				time.Sleep(waitTime)
				continue
			}
		}

		// Success
		return json.RawMessage(body), nil
	}

	return nil, fmt.Errorf("all retry attempts failed: %w", lastError)
}

// Process generation in background
func processGeneration(req GenerateRequest) {
	startTime := time.Now()
	taskID := req.TaskID

	// Update metrics
	atomic.AddInt32(&activeTasks, 1)
	atomic.AddInt64(&totalProcessed, 1)
	defer atomic.AddInt32(&activeTasks, -1)

	// Log resource usage at start
	resources := getResourceUsage()
	log.Printf("[RESOURCE_START] Task %s | Active: %d | Total: %d | Memory: %.2f/%.2fMB (%.2f%%) | Goroutines: %d",
		taskID, atomic.LoadInt32(&activeTasks), atomic.LoadInt64(&totalProcessed),
		resources.MemoryMB.Used, resources.MemoryMB.Total, resources.MemoryMB.Percent,
		runtime.NumGoroutine())

	// Determine API endpoint based on model
	var apiURL string
	var requestBody map[string]interface{}

	switch req.Model {
	case "sora", "sora_image":
		// Use the same endpoint as Node.js version
		apiURL = "https://yunwu.zeabur.app/v1/chat/completions"

		// Build content array with images if provided
		var content interface{}
		allImageURLs := req.ImageURLs
		if len(allImageURLs) == 0 && req.ImageURL != "" {
			allImageURLs = []string{req.ImageURL}
		}

		if len(allImageURLs) > 0 {
			// Build content array with text and images
			contentArray := []map[string]interface{}{
				{"type": "text", "text": fmt.Sprintf("%s %s", req.Prompt, req.ImageSize)},
			}
			for _, imgURL := range allImageURLs {
				contentArray = append(contentArray, map[string]interface{}{
					"type": "image_url",
					"image_url": map[string]string{"url": imgURL},
				})
			}
			content = contentArray
		} else {
			// Just text if no images
			content = fmt.Sprintf("%s %s", req.Prompt, req.ImageSize)
		}

		// OpenAI format request
		requestBody = map[string]interface{}{
			"model": "sora_image",
			"messages": []map[string]interface{}{
				{"role": "user", "content": content},
			},
		}

	case "gemini":
		// Gemini uses different endpoint and format
		apiURL = "https://yunwu.zeabur.app/v1beta/models/gemini-2.5-flash-image-preview:generateContent"

		// Prepare images array
		images := req.ImageURLs
		if len(images) == 0 && req.ImageURL != "" {
			images = []string{req.ImageURL}
		}

		// Build Gemini format request
		parts := []map[string]interface{}{
			{"text": fmt.Sprintf("%s %s", req.Prompt, req.ImageSize)},
		}

		// Note: For Gemini, we'd need to convert images to base64
		// For now, we'll just use the URL format
		for _, imgURL := range images {
			parts = append(parts, map[string]interface{}{
				"inline_data": map[string]string{
					"mime_type": "image/jpeg",
					"data":      imgURL, // This should be base64, but keeping URL for now
				},
			})
		}

		requestBody = map[string]interface{}{
			"contents": []map[string]interface{}{
				{
					"role":  "user",
					"parts": parts,
				},
			},
		}

	default:
		// Other models (flux, etc.) - use sora endpoint with model name
		apiURL = "https://yunwu.zeabur.app/v1/chat/completions"

		// OpenAI format request
		requestBody = map[string]interface{}{
			"model": req.Model,
			"messages": []map[string]interface{}{
				{"role": "user", "content": fmt.Sprintf("%s %s", req.Prompt, req.ImageSize)},
			},
		}
	}

	log.Printf("[%s] Processing %s generation | Prompt length: %d | Image size: %s",
		taskID, req.Model, len(req.Prompt), req.ImageSize)

	// Call API with retry
	responseData, err := callAPIWithRetry(apiURL, requestBody, req.APIKey, taskID)

	if err != nil {
		errorMsg := fmt.Sprintf("API call failed: %v", err)
		log.Printf("[%s] %s", taskID, errorMsg)

		// Store error result
		taskResults.Store(taskID, TaskResult{
			Success:   false,
			Error:     errorMsg,
			Timestamp: time.Now().Format(time.RFC3339),
		})

		// Send failure callback
		if req.CallbackURL != "" {
			sendCallback(req.CallbackURL, CallbackPayload{
				TaskID:       taskID,
				ParentTaskID: req.ParentTaskID,
				Status:       "failed",
				Error:        errorMsg,
			})
		}

		// Log resource usage at end
		endResources := getResourceUsage()
		duration := time.Since(startTime)
		log.Printf("[RESOURCE_END] Task %s | Duration: %v | Memory: %.2f/%.2fMB (%.2f%%) | Goroutines: %d | Result: FAILED",
			taskID, duration, endResources.MemoryMB.Used, endResources.MemoryMB.Total,
			endResources.MemoryMB.Percent, runtime.NumGoroutine())

		return
	}

	// Extract image URL
	imageURL, err := extractImageURL(responseData, req.Model)

	if err != nil {
		log.Printf("[%s] Failed to extract image URL: %v", taskID, err)
		log.Printf("[%s] Full response: %s", taskID, string(responseData))

		// Extract detailed error message
		errorMsg := err.Error()

		// Store error result with raw response and detailed error
		taskResults.Store(taskID, TaskResult{
			Success:     false,
			Error:       errorMsg,
			RawResponse: responseData,
			Timestamp:   time.Now().Format(time.RFC3339),
		})

		// Send failure callback with detailed error
		if req.CallbackURL != "" {
			sendCallback(req.CallbackURL, CallbackPayload{
				TaskID:       taskID,
				ParentTaskID: req.ParentTaskID,
				Status:       "failed",
				Error:        errorMsg,
			})
		}
	} else {
		log.Printf("[%s] Successfully extracted image URL: %s", taskID, imageURL)

		// Store success result
		taskResults.Store(taskID, TaskResult{
			Success:     true,
			ImageURL:    imageURL,
			RawResponse: responseData,
			Timestamp:   time.Now().Format(time.RFC3339),
		})

		// Send success callback
		if req.CallbackURL != "" {
			err := sendCallback(req.CallbackURL, CallbackPayload{
				TaskID:       taskID,
				ParentTaskID: req.ParentTaskID,
				Status:       "completed",
				ImageURL:     imageURL,
			})

			if err != nil {
				log.Printf("[%s] Callback failed: %v", taskID, err)
			} else {
				log.Printf("[%s] Callback sent successfully", taskID)
			}
		}
	}

	// Log resource usage at end
	endResources := getResourceUsage()
	duration := time.Since(startTime)
	status := "SUCCESS"
	if err != nil {
		status = "FAILED"
	}

	log.Printf("[RESOURCE_END] Task %s | Duration: %v | Memory: %.2f/%.2fMB (%.2f%%) | Goroutines: %d | Result: %s",
		taskID, duration, endResources.MemoryMB.Used, endResources.MemoryMB.Total,
		endResources.MemoryMB.Percent, runtime.NumGoroutine(), status)
}

func main() {
	// Initialize HTTP client with custom DNS resolver
	// Use Google's public DNS to avoid Cloud Run DNS issues
	resolver := &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
			d := net.Dialer{
				Timeout: time.Second * 5,
			}
			// Use Google's public DNS servers
			return d.DialContext(ctx, network, "8.8.8.8:53")
		},
	}

	httpClient = &http.Client{
		Timeout: 5 * time.Minute, // Increased from 30 seconds to 5 minutes
		Transport: &http.Transport{
			DialContext: (&net.Dialer{
				Timeout:   30 * time.Second,
				KeepAlive: 30 * time.Second,
				Resolver:  resolver,
			}).DialContext,
			TLSHandshakeTimeout:   10 * time.Second,
			ResponseHeaderTimeout: 4 * time.Minute, // Increased from 10 seconds to 4 minutes
			ExpectContinueTimeout: 1 * time.Second,
			MaxIdleConns:          200,
			MaxIdleConnsPerHost:   100, // Increased from 10 to 100 for better concurrency
		},
	}

	// Set Gin mode from environment
	if os.Getenv("GIN_MODE") == "" {
		gin.SetMode(gin.ReleaseMode)
	}

	// Create router
	router := gin.Default()

	// Health check endpoint
	router.GET("/health", func(c *gin.Context) {
		resources := getResourceUsage()
		c.JSON(http.StatusOK, gin.H{
			"status":     "healthy",
			"tasks":      atomic.LoadInt32(&activeTasks),
			"processed":  atomic.LoadInt64(&totalProcessed),
			"resources":  resources,
			"goroutines": runtime.NumGoroutine(),
		})
	})

	// Synchronous generation endpoint
	router.POST("/api/generate", func(c *gin.Context) {
		var req GenerateRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, GenerateResponse{
				Success: false,
				Error:   err.Error(),
			})
			return
		}

		// Validate API key
		if req.APIKey == "" {
			c.JSON(http.StatusUnauthorized, GenerateResponse{
				Success: false,
				Error:   "API key required",
			})
			return
		}

		// Generate task ID if not provided
		if req.TaskID == "" {
			req.TaskID = uuid.New().String()
		}

		log.Printf("Starting sync generation with model: %s, taskId: %s", req.Model, req.TaskID)

		// Process synchronously with timeout
		ctx, cancel := context.WithTimeout(context.Background(), DefaultTimeout)
		defer cancel()

		done := make(chan bool)

		go func() {
			processGeneration(req)
			done <- true
		}()

		select {
		case <-done:
			// Get result from storage
			if result, ok := taskResults.Load(req.TaskID); ok {
				taskResult := result.(TaskResult)
				if taskResult.Success {
					c.JSON(http.StatusOK, GenerateResponse{
						Success:  true,
						TaskID:   req.TaskID,
						ImageURL: taskResult.ImageURL,
					})
				} else {
					c.JSON(http.StatusInternalServerError, GenerateResponse{
						Success: false,
						Error:   taskResult.Error,
					})
				}
			} else {
				c.JSON(http.StatusInternalServerError, GenerateResponse{
					Success: false,
					Error:   "Task result not found",
				})
			}

		case <-ctx.Done():
			c.JSON(http.StatusGatewayTimeout, GenerateResponse{
				Success: false,
				Error:   "Request timeout",
			})
		}
	})

	// Asynchronous generation endpoint
	router.POST("/api/generate/async", func(c *gin.Context) {
		var req GenerateRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, GenerateResponse{
				Success: false,
				Error:   err.Error(),
			})
			return
		}

		// Validate API key
		if req.APIKey == "" {
			c.JSON(http.StatusUnauthorized, GenerateResponse{
				Success: false,
				Error:   "API key required",
			})
			return
		}

		// Generate task ID if not provided
		if req.TaskID == "" {
			req.TaskID = uuid.New().String()
		}

		log.Printf("Starting async generation with model: %s, taskId: %s", req.Model, req.TaskID)
		if req.CallbackURL != "" {
			log.Printf("Callback URL: %s", req.CallbackURL)
		}

		// Return immediately
		c.JSON(http.StatusOK, GenerateResponse{
			Success: true,
			TaskID:  req.TaskID,
			Message: "Generation started",
		})

		// Process in background
		go processGeneration(req)
	})

	// Status endpoint for polling
	router.GET("/api/status/:taskId", func(c *gin.Context) {
		taskID := c.Param("taskId")

		if result, ok := taskResults.Load(taskID); ok {
			taskResult := result.(TaskResult)
			c.JSON(http.StatusOK, taskResult)
		} else {
			c.JSON(http.StatusNotFound, gin.H{
				"error": "Task not found",
			})
		}
	})

	// Clean up old results periodically
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()

		for range ticker.C {
			count := 0
			taskResults.Range(func(key, value interface{}) bool {
				result := value.(TaskResult)
				taskTime, _ := time.Parse(time.RFC3339, result.Timestamp)
				if time.Since(taskTime) > 10*time.Minute {
					taskResults.Delete(key)
					count++
				}
				return true
			})
			if count > 0 {
				log.Printf("Cleaned up %d old task results", count)
			}
		}
	}()

	// Start server
	port := os.Getenv("PORT")
	if port == "" {
		port = DefaultPort
	}

	log.Printf("Starting Go proxy server on port %s", port)
	log.Printf("Memory limit: %dMB", MemoryMB)
	log.Printf("Max concurrency: %d", MaxConcurrency)
	log.Printf("Timeout: %v", DefaultTimeout)

	if err := router.Run(":" + port); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}