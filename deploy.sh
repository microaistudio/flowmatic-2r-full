#!/bin/bash
echo "🚀 FlowMatic Auto-Deploy Starting..."

# 1. Push from local to Git
echo "📤 Pushing to Git..."
git add .
git commit -m "auto-deploy: $(date)"
git push origin main

# 2. SSH to VM and deploy
echo "🔄 Deploying to VM..."
gcloud compute ssh flowmatic-solo --zone=asia-southeast2-a --command="
cd /var/www/flowmatic && \
git stash && \
git pull origin main && \
npm install --production && \
pm2 restart flowmatic-staging && \
echo '✅ FlowMatic deployed successfully!' && \
pm2 status
"

echo "🎉 Deployment complete! Access: http://34.128.86.132:5050"
