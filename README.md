# wyjk网页变动监控器

## 🚀 功能特点
- 定时检测
- PushDeer推送
- 服务端常驻运行
- 状态变动实时推送

## 🐳 Docker部署
Docker Run
```
docker run -d --name wyjk -p 6822:6822 -v $(pwd)/data:/app/data -e TZ=Asia/Shanghai -e PORT=6822 --restart unless-stopped cunpeng/wyjk:1.02
```

## 📝 更新日志
- v1.00 (2026-04-24)
- v1.01 (2026-04-24)
- v1.02 (2026-04-25)上下文版本

## ⭐ 项目地址
- https://github.com/cunpeng/wyjk

## ✨ 合作交流
- QQ群333628217

## 👨‍💻 赞赏作者
- https://github.com/user-attachments/assets/0926f261-1b00-4d8b-b9d3-49dcc980143b
