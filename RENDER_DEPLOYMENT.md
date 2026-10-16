# Deploy Jolie's Pizza to Render

This repository is configured as one Render Node web service. It serves the customer, staff, and admin pages together with the API, so frontend requests stay on the same domain.

## Before you deploy

1. Push this repository to a Git provider that Render can access.
2. Create a MySQL database reachable from the Render service. For a Render-hosted database, follow Render's [MySQL deployment guide](https://render.com/docs/deploy-mysql) and keep the database private to the same Render workspace. The database needs persistent storage.
3. Import the existing Jolie's Pizza database into the new MySQL database if you want to keep your current users, menu, orders, and business data. This project does not include a full SQL dump of the existing database.

## Create the Render service

1. In Render, choose **New → Blueprint** and connect this repository.
2. Render reads `render.yaml` and creates the `jolies-pizza` web service.
3. When prompted, enter `APP_BASE_URL` as the final HTTPS URL Render assigns to the service, and provide the database host, username, and password. Keep the database host private; do not expose database credentials in frontend files or commit them to Git.
4. Wait for the deploy and confirm the service health check at `/healthz` succeeds.

The Blueprint uses the `free` web service plan to make initial setup straightforward. Free web services can spin down when idle; choose a paid plan in Render if the restaurant needs the service to stay continuously available.

## Optional integrations

Add these in the Render service's **Environment** page if the matching feature is needed:

- `GOOGLE_CLIENT_ID` for Google sign-in. Add the deployed HTTPS domain to the authorized origins for that Google OAuth client.
- `GOOGLE_MAPS_API_KEY` for delivery maps. Restrict the browser key to the deployed domain and the required Maps APIs.
- `PAYMONGO_SECRET_KEY` and `PAYMONGO_WEBHOOK_SECRET` for online checkout. Configure the PayMongo webhook to use the deployed service URL.
- `GCASH_ACCOUNT_NAME`, `GCASH_ACCOUNT_NUMBER`, and `GCASH_QR_IMAGE_URL` for staff walk-in GCash instructions.

Never put secret keys in the customer, staff, or admin HTML/JavaScript files.

## Redeploying

Render deploys updates from the connected Git branch. Push changes to that branch, then review the service's deploy log if a build or startup fails. The service requires the pre-existing core MySQL tables; startup migrations add the app's newer feature tables and columns.
