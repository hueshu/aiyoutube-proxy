# Go Version - AI YouTube Proxy

Go语言版本的代理服务器，作为Node.js版本的高性能替代方案。

## 特性对比

| 特性 | Node.js版本 | Go版本 |
|------|------------|--------|
| 内存占用 | 512MB | 256MB (预期降低50%) |
| 冷启动时间 | ~3s | <1s (预期提升70%) |
| 并发处理 | Event Loop | Goroutines |
| 超时控制 | AbortController | Context |
| 回调响应时间 | 57-329ms | 预期<100ms |

## 功能完整性

✅ 已实现的功能：
- HTTP代理转发
- 云雾AI调用（Sora、Flux、Gemini）
- 4分钟超时控制
- 回调机制（fetch优化）
- 增强日志（带taskId前缀）
- 异步/同步双模式
- 任务状态查询
- 资源监控
- 健康检查

## 文件结构

```
go-version分支/
├── main.go          # Go主程序
├── go.mod          # Go模块定义
├── go.sum          # 依赖校验和
├── Dockerfile.go   # Docker构建文件
├── deploy-go.sh    # 部署脚本
├── test-performance.sh # 性能测试脚本
└── README-GO.md    # 本文档
```

## 本地开发

### 前置要求
- Go 1.21+
- Docker（可选）

### 安装依赖
```bash
go mod download
```

### 运行服务
```bash
# 开发模式
go run main.go

# 生产模式
GIN_MODE=release go run main.go

# 指定端口
PORT=3000 go run main.go
```

### 构建二进制
```bash
go build -o proxy main.go
./proxy
```

## Docker部署

### 构建镜像
```bash
docker build -f Dockerfile.go -t aiyoutube-proxy-go .
```

### 运行容器
```bash
docker run -p 8080:8080 -e GIN_MODE=release aiyoutube-proxy-go
```

## 部署到Google Cloud Run

使用提供的部署脚本：
```bash
./deploy-go.sh
```

或手动部署：
```bash
# 构建并推送镜像
docker build -f Dockerfile.go -t gcr.io/aiyoutube-proxy-1757514873/aiyoutube-proxy-go .
docker push gcr.io/aiyoutube-proxy-1757514873/aiyoutube-proxy-go

# 部署到Cloud Run
gcloud run deploy aiyoutube-proxy-go \
    --image gcr.io/aiyoutube-proxy-1757514873/aiyoutube-proxy-go \
    --platform managed \
    --region us-west1 \
    --allow-unauthenticated \
    --port 8080 \
    --memory 256Mi \
    --cpu 0.5 \
    --max-instances 100 \
    --concurrency 80
```

## 性能测试

使用测试脚本对比Node.js和Go版本：

```bash
# 测试Node.js版本
./test-performance.sh node <api-key> https://aiyoutube-proxy-255548119160.us-west1.run.app

# 测试Go版本
./test-performance.sh go <api-key> https://aiyoutube-proxy-go-255548119160.us-west1.run.app
```

## API接口

完全兼容Node.js版本的所有接口：

### 1. 健康检查
```bash
GET /health
```

### 2. 同步生成
```bash
POST /api/generate
{
    "model": "flux-schnell",
    "prompt": "A beautiful sunset",
    "imageSize": "1024x1024",
    "apiKey": "your-api-key",
    "taskId": "optional-task-id"
}
```

### 3. 异步生成
```bash
POST /api/generate/async
{
    "model": "sora",
    "prompt": "A futuristic city",
    "imageSize": "1920x1080",
    "apiKey": "your-api-key",
    "taskId": "task-123",
    "callbackUrl": "https://your-callback-url.com/webhook"
}
```

### 4. 查询状态
```bash
GET /api/status/:taskId
```

## 性能优化

Go版本的优化点：

1. **内存管理**：
   - 使用sync.Map代替普通map，线程安全
   - 定期清理过期任务结果（10分钟）
   - 更小的内存占用（256MB vs 512MB）

2. **并发处理**：
   - Goroutines替代Event Loop
   - 原生并发，无需额外库
   - 更好的CPU利用率

3. **网络优化**：
   - HTTP客户端连接池复用
   - Context超时控制更精确
   - 二进制协议效率更高

4. **冷启动**：
   - 编译后的二进制文件
   - 无需加载Node.js运行时
   - 启动时间<1秒

## 监控指标

通过`/health`端点获取：
- 活跃任务数（activeTasks）
- 总处理数（totalProcessed）
- 内存使用（memoryMB）
- Goroutine数量

## 问题排查

1. **任务丢失问题**：
   - Go版本使用goroutines，每个任务独立栈空间
   - 不会出现Node.js的内存泄漏问题
   - Context超时控制更可靠

2. **回调失败**：
   - 检查日志中的`[taskId] Callback`前缀
   - 确认callbackUrl可访问
   - 查看具体错误信息

3. **性能问题**：
   - 检查`/health`的goroutine数量
   - 确认内存使用率<80%
   - 查看Cloud Run的CPU使用率

## 下一步计划

- [ ] 添加Prometheus指标
- [ ] 实现分布式追踪
- [ ] 添加速率限制
- [ ] 支持WebSocket推送
- [ ] 添加Redis缓存层