#!/usr/bin/env bash
# Build the container with Cloud Build and deploy it to Cloud Run.
set -euo pipefail
cd "$(dirname "$0")/.."
source deploy/config.sh
GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-$(cat deploy/.google-client-id.local 2>/dev/null || true)}"
: "${GOOGLE_CLIENT_ID:?Set GOOGLE_CLIENT_ID}"
TAG="${TAG:-$(git rev-parse --short HEAD 2>/dev/null || date +%s)}"

gcloud config set project "$PROJECT_ID" >/dev/null
gcloud builds submit --config deploy/build-only.yaml --substitutions="_IMAGE=${IMAGE}:${TAG}" \
  --service-account="projects/${PROJECT_ID}/serviceAccounts/${BUILD_SA}" .

gcloud run deploy "$SERVICE" \
  --image "${IMAGE}:${TAG}" \
  --region "$REGION" \
  --service-account "$RUN_SA" \
  --allow-unauthenticated \
  --min-instances 0 --max-instances 2 \
  --cpu 1 --memory 512Mi --concurrency 20 --timeout 300 \
  --set-env-vars "BASE_URL=${BASE_URL},OWNER_EMAIL=${OWNER_EMAIL},GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID},SLACK_CLIENT_ID=${SLACK_CLIENT_ID},SLACK_TEAM_ID=${SLACK_TEAM_ID},STORE_BACKEND=firestore" \
  --set-secrets "ENCRYPTION_KEY=cc-encryption-key:latest,GOOGLE_CLIENT_SECRET=cc-google-client-secret:latest,SLACK_CLIENT_SECRET=cc-slack-client-secret:latest"

# Cloud Run serves both a legacy and the deterministic URL; BASE_URL is the deterministic one.
echo "Deployed: $BASE_URL"
curl -fsS "$BASE_URL/health" && echo
