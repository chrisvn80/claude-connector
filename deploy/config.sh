# Shared settings for the deploy scripts. Not secret.
PROJECT_ID="project-3c0b73bc-f9de-4680-9a6"
PROJECT_NUMBER="366382691520"
REGION="us-east1"
SERVICE="claude-connector"
REPO="claude-connector"                       # Artifact Registry repo
RUN_SA="claude-connector-run@${PROJECT_ID}.iam.gserviceaccount.com"
BASE_URL="https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app"
OWNER_EMAIL="chris.vannoy@gmail.com"
SLACK_CLIENT_ID="11794727366977.11827306860929"
SLACK_TEAM_ID="T0BPCMDASUR"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${SERVICE}"
BUILD_SA="claude-connector-build@${PROJECT_ID}.iam.gserviceaccount.com"
