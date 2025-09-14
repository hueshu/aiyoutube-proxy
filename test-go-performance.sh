#!/bin/bash

# Go版本性能测试脚本
# 用法: ./test-go-performance.sh [服务URL]

set -e

# 设置服务URL
GO_URL=${1:-"https://aiyoutube-proxy-go-255548119160.us-west1.run.app"}
NODE_URL="https://aiyoutube-proxy-255548119160.us-west1.run.app"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}========================================"
echo "       性能对比测试"
echo "========================================${NC}"
echo ""

# 函数：测试响应时间
test_response_time() {
    local url=$1
    local name=$2
    local count=${3:-10}

    echo -e "${YELLOW}测试 $name ($count 次请求)${NC}"
    echo "URL: $url"
    echo ""

    local total_time=0
    local min_time=999999
    local max_time=0

    for i in $(seq 1 $count); do
        # 测量响应时间
        response_time=$(curl -s -o /dev/null -w "%{time_total}" "$url/health" 2>/dev/null || echo "0")

        # 转换为毫秒
        response_ms=$(echo "$response_time * 1000" | bc)

        echo "  请求 $i: ${response_ms}ms"

        # 计算统计数据
        total_time=$(echo "$total_time + $response_time" | bc)

        # 更新最小值
        if (( $(echo "$response_time < $min_time" | bc -l) )); then
            min_time=$response_time
        fi

        # 更新最大值
        if (( $(echo "$response_time > $max_time" | bc -l) )); then
            max_time=$response_time
        fi

        # 避免过快请求
        sleep 0.1
    done

    # 计算平均值
    avg_time=$(echo "scale=3; $total_time / $count" | bc)
    avg_ms=$(echo "$avg_time * 1000" | bc)
    min_ms=$(echo "$min_time * 1000" | bc)
    max_ms=$(echo "$max_time * 1000" | bc)

    echo ""
    echo -e "${GREEN}统计结果:${NC}"
    echo "  平均响应时间: ${avg_ms}ms"
    echo "  最小响应时间: ${min_ms}ms"
    echo "  最大响应时间: ${max_ms}ms"
    echo ""

    # 返回平均时间用于比较
    echo $avg_ms > /tmp/${name}_avg.txt
}

# 1. 测试Go版本
echo -e "${BLUE}1. Go版本测试${NC}"
echo "----------------------------------------"
test_response_time "$GO_URL" "Go版本"

# 2. 测试Node.js版本
echo -e "${BLUE}2. Node.js版本测试${NC}"
echo "----------------------------------------"
test_response_time "$NODE_URL" "Node版本"

# 3. 并发测试（如果安装了ab）
if command -v ab &> /dev/null; then
    echo -e "${BLUE}3. 并发压力测试${NC}"
    echo "----------------------------------------"

    echo -e "${YELLOW}Go版本并发测试 (100请求, 10并发)${NC}"
    ab -n 100 -c 10 -g /tmp/go_ab.tsv "$GO_URL/health" 2>&1 | grep -E "(Requests per second|Time per request|Transfer rate)"

    echo ""
    echo -e "${YELLOW}Node版本并发测试 (100请求, 10并发)${NC}"
    ab -n 100 -c 10 -g /tmp/node_ab.tsv "$NODE_URL/health" 2>&1 | grep -E "(Requests per second|Time per request|Transfer rate)"
fi

# 4. 对比总结
echo ""
echo -e "${BLUE}========================================"
echo "          测试总结"
echo "========================================${NC}"

if [ -f /tmp/Go版本_avg.txt ] && [ -f /tmp/Node版本_avg.txt ]; then
    go_avg=$(cat /tmp/Go版本_avg.txt)
    node_avg=$(cat /tmp/Node版本_avg.txt)

    # 计算性能提升百分比
    if (( $(echo "$node_avg > 0" | bc -l) )); then
        improvement=$(echo "scale=2; (($node_avg - $go_avg) / $node_avg) * 100" | bc)

        echo -e "${GREEN}响应时间对比:${NC}"
        echo "  Go版本平均:   ${go_avg}ms"
        echo "  Node版本平均: ${node_avg}ms"

        if (( $(echo "$improvement > 0" | bc -l) )); then
            echo -e "  ${GREEN}性能提升: ${improvement}%${NC}"
        else
            echo -e "  ${RED}性能下降: ${improvement}%${NC}"
        fi
    fi
fi

# 5. 资源使用对比
echo ""
echo -e "${BLUE}5. 资源使用情况${NC}"
echo "----------------------------------------"

echo -e "${YELLOW}Go版本资源:${NC}"
curl -s "$GO_URL/health" 2>/dev/null | python3 -m json.tool 2>/dev/null | grep -E "(memory|cpu|goroutines|tasks)" || echo "  健康检查端点未实现"

echo ""
echo -e "${YELLOW}Node版本资源:${NC}"
curl -s "$NODE_URL/health" 2>/dev/null | python3 -m json.tool 2>/dev/null | grep -E "(memory|cpu|tasks)" || echo "  健康检查端点未实现"

# 清理临时文件
rm -f /tmp/Go版本_avg.txt /tmp/Node版本_avg.txt /tmp/go_ab.tsv /tmp/node_ab.tsv

echo ""
echo -e "${GREEN}✅ 测试完成！${NC}"