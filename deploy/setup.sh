#!/usr/bin/env bash
# One-time infrastructure setup. Safe to re-run: every step checks before creating.
# Usage: GOOGLE_CLIENT_ID=<web client id> ./deploy/setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."
source deploy/config.sh
: "${GOOGLE_CLIENT_ID:?Set GOOGLE_CLIENT_ID to the new Web OAuth client ID}"

gcloud config set project "$PROJECT_ID" >/dev/null

echo "== Enabling APIs"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com firestore.googleapis.com gmail.googleapis.com calendar-json.googleapis.com \
  drive.googleapis.com docs.googleapis.com sheets.googleapis.com

echo "== Firestore (Native mode, ${REGION})"
if ! gcloud firestore databases describe --database="(default)" >/dev/null 2>&1; then
  gcloud firestore databases create --location="$REGION" --type=firestore-native
fi
for c in cc_flows cc_codes cc_access cc_refresh; do
  gcloud firestore fields ttls update expiresAt --collection-group="$c" --enable-ttl --async >/dev/null 2>&1 || true
done

echo "== Artifact Registry"
if ! gcloud artifacts repositories describe "$REPO" --location="$REGION" >/dev/null 2>&1; then
  gcloud artifacts repositories create "$REPO" --repository-format=docker --location="$REGION"
fi
cat > /tmp/cc-cleanup.json <<'JSON'
[{"name":"keep-3","action":{"type":"Keep"},"mostRecentVersions":{"keepCount":3}},
 {"name":"delete-old","action":{"type":"Delete"},"condition":{"olderThan":"86400s"}}]
JSON
gcloud artifacts repositories set-cleanup-policies "$REPO" --location="$REGION" --policy=/tmp/cc-cleanup.json --no-dry-run >/dev/null

echo "== Runtime service account"
if ! gcloud iam service-accounts describe "$RUN_SA" >/dev/null 2>&1; then
  gcloud iam service-accounts create claude-connector-run --display-name="claude-connector runtime"
fi
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${RUN_SA}" \
  --role=roles/datastore.user --condition=None >/dev/null

echo "== Secrets"
if ! gcloud secrets describe cc-encryption-key >/dev/null 2>&1; then
  # Generated and stored without ever being printed.
  openssl rand -base64 32 | tr -d '\n' | gcloud secrets create cc-encryption-key --data-file=- --replication-policy=automatic
fi
for s in cc-google-client-secret cc-slack-client-secret; do
  if ! gcloud secrets describe "$s" >/dev/null 2>&1; then
    echo "!! Secret $s does not exist yet. Create it in the console (Security > Secret Manager), then re-run."
    exit 1
  fi
done
for s in cc-encryption-key cc-google-client-secret cc-slack-client-secret; do
  gcloud secrets add-iam-policy-binding "$s" --member="serviceAccount:${RUN_SA}" \
    --role=roles/secretmanager.secretAccessor >/dev/null
done

echo "$GOOGLE_CLIENT_ID" > deploy/.google-client-id.local
echo "== Setup complete. Next: ./deploy/deploy.sh"
