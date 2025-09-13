# Google Cloud Run 部署指南

## 概述
本指南说明如何将 AIYOUTUBE 代理服务从 Render.com 迁移到 Google Cloud Run。

## 前置要求

1. **Google Cloud 账号**
   - 创建 GCP 账号：https://cloud.google.com/
   - 创建一个新项目或使用现有项目

2. **安装 gcloud CLI**
   ```bash
   # macOS
   brew install google-cloud-sdk
   
   # 或下载安装包
   # https://cloud.google.com/sdk/docs/install
   ```

3. **安装 Docker**
   - Docker Desktop: https://www.docker.com/products/docker-desktop

4. **认证和配置**
   ```bash
   # 登录 Google Cloud
   gcloud auth login
   
   # 设置项目 ID
   export PROJECT_ID=your-project-id
   gcloud config set project $PROJECT_ID
   ```

## 部署步骤

### 方法 1: 使用部署脚本（推荐）

```bash
# 进入项目目录
cd aiyoutube-vercel-proxy

# 设置项目 ID
export PROJECT_ID=your-gcp-project-id

# 运行部署脚本
./deploy.sh
```

### 方法 2: 手动部署

1. **构建 Docker 镜像**
   ```bash
   docker build -t gcr.io/$PROJECT_ID/aiyoutube-proxy .
   ```

2. **推送到 Google Container Registry**
   ```bash
   # 配置 Docker 认证
   gcloud auth configure-docker
   
   # 推送镜像
   docker push gcr.io/$PROJECT_ID/aiyoutube-proxy
   ```

3. **部署到 Cloud Run**
   ```bash
   gcloud run deploy aiyoutube-proxy \
     --image gcr.io/$PROJECT_ID/aiyoutube-proxy \
     --platform managed \
     --region us-central1 \
     --allow-unauthenticated \
     --port 3000 \
     --memory 512Mi \
     --cpu 1 \
     --timeout 300 \
     --max-instances 10
   ```

### 方法 3: 使用 Cloud Build（CI/CD）

1. **连接 GitHub 仓库**
   ```bash
   # 在 Google Cloud Console 中设置 Cloud Build 触发器
   # 或使用命令行
   gcloud builds submit --config cloudbuild.yaml
   ```

## 配置说明

### Cloud Run 配置参数

| 参数 | 值 | 说明 |
|------|-----|------|
| Memory | 512Mi | 内存配置，可根据需要调整 |
| CPU | 1 | CPU 配置 |
| Timeout | 300s | 请求超时时间（5分钟） |
| Port | 3000 | 服务监听端口 |
| Max Instances | 10 | 最大实例数 |
| Min Instances | 0 | 最小实例数（0 表示可以缩容到零） |

### 环境变量

Cloud Run 会自动设置 `PORT` 环境变量，服务需要监听这个端口。当前代码已经支持：

```javascript
const PORT = process.env.PORT || 3000;
```

## 更新 Cloudflare Workers

部署成功后，需要更新 Cloudflare Workers 的环境变量：

1. **获取 Cloud Run 服务 URL**
   ```bash
   gcloud run services describe aiyoutube-proxy \
     --platform managed \
     --region us-central1 \
     --format 'value(status.url)'
   ```

2. **更新 wrangler.toml**
   ```toml
   [env.production.vars]
   PROXY_URL = "https://aiyoutube-proxy-xxxxx-uc.a.run.app"
   ```

3. **重新部署 Workers**
   ```bash
   cd ../aiyoutube-backend
   npx wrangler deploy --env production
   ```

## 监控和日志

### 查看日志
```bash
# 实时日志
gcloud logs tail --service=aiyoutube-proxy

# 查看最近的日志
gcloud logging read "resource.type=cloud_run_revision \
  AND resource.labels.service_name=aiyoutube-proxy" \
  --limit 50
```

### 查看指标
```bash
# 在 Google Cloud Console 中查看
# https://console.cloud.google.com/run
```

## 成本优化

1. **使用最小实例数为 0**
   - 没有请求时不产生费用
   - 冷启动时间约 2-5 秒

2. **配置并发数**
   ```bash
   gcloud run services update aiyoutube-proxy \
     --concurrency=100 \
     --region=us-central1
   ```

3. **选择合适的区域**
   - us-central1 通常最便宜
   - 考虑用户地理位置选择就近区域

## 故障排除

### 常见问题

1. **部署失败：权限不足**
   ```bash
   # 确保启用了必要的 API
   gcloud services enable run.googleapis.com
   gcloud services enable containerregistry.googleapis.com
   ```

2. **镜像推送失败**
   ```bash
   # 重新配置 Docker 认证
   gcloud auth configure-docker
   ```

3. **服务无法访问**
   - 检查是否设置了 `--allow-unauthenticated`
   - 检查防火墙规则

### 回滚

如果需要回滚到上一个版本：

```bash
# 列出所有版本
gcloud run revisions list --service=aiyoutube-proxy

# 回滚到特定版本
gcloud run services update-traffic aiyoutube-proxy \
  --to-revisions=aiyoutube-proxy-00001-abc=100
```

## 安全建议

1. **使用 Secret Manager 管理 API 密钥**
   ```bash
   # 创建 secret
   echo -n "your-api-key" | gcloud secrets create api-key --data-file=-
   
   # 在 Cloud Run 中使用
   gcloud run services update aiyoutube-proxy \
     --set-secrets=API_KEY=api-key:latest
   ```

2. **启用 VPC 连接器**（如果需要访问内部资源）

3. **配置 Cloud Armor**（DDoS 防护）

## 相关链接

- [Cloud Run 文档](https://cloud.google.com/run/docs)
- [Cloud Run 定价](https://cloud.google.com/run/pricing)
- [最佳实践](https://cloud.google.com/run/docs/tips)
- [配额和限制](https://cloud.google.com/run/quotas)