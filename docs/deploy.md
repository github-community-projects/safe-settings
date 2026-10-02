# Deployment

## Deployment Environment Variables

To deploy the app anywhere, you will need 3 key environment variables:

- `APP_ID`: the ID of the app, which you can get from the [app settings page](https://github.com/settings/apps).

- `WEBHOOK_SECRET`: the **Webhook Secret** that you generated when you created the app.

  And one of:

- `PRIVATE_KEY`: (preferred approach) the contents of the private key you downloaded after creating the app, and base64 encode it ...or
- `PRIVATE_KEY_PATH`: the path to a private key file. This will require modification for different environments to make sure the file is available. E.g. For Docker: modify the Dockerfile to COPY the file into the container.

> [!NOTE]
> `PRIVATE_KEY` takes precedence over `PRIVATE_KEY_PATH`.

## Deploy the app

### Prepare the source code
You will first need to clone the source code to your local environment that will run the **Docker** container.

Note: If running locally without Docker, ensure that Node 18.x or later is installed (Node 20.x LTS recommended).

- Clone the codebase
  - `git clone https://github.com/github/safe-settings.git` or `git clone <this repo>`

- Change directory to inside the code base
  - `cd safe-settings/`

- Run `npm install` to build the code

- The easiest way to create the Github App is using the [manifest flow](https://docs.github.com/en/developers/apps/building-github-apps/creating-a-github-app-from-a-manifest#using-probot-to-implement-the-github-app-manifest-flow). To set up the app in an org, provide the `GH_ORG` env variable in the .env file

- If using the `manifest` flow, create `.env` from `.env.example` and set the `GH_ORG` variable if installing the app in an org.

- Start the app, `npm run dev` if running locally, or `npm run prod`

- If using the manifest flow, follow the steps [here](https://docs.github.com/en/developers/apps/building-github-apps/creating-a-github-app-from-a-manifest)

- If not using the `manifest flow` then follow the steps in [Create the GitHub App](#create-the-github-app)

- Create `.env` from `.env.example`

  - `cp .env.example .env`

- Update the `.env` with the fields outlined in the [Deployment Environment Variables](#deployment-environment-variables) section

Optional values in the .env file can be found under the [Environment variables](../README.md#environment-variables) section. Additionally, you can set:
- `NODE_TLS_REJECT_UNAUTHORIZED`: `0` for ignoring SSL validation and errors
- `GHE_HOST`: This is a required field for **GitHub Enterprise Server** implementations (_Example: github.mycompany.com_)
- `WEBHOOK_PROXY_URL`: SMEE Url for testing locally

Once you have the `.env` file configured, you are ready to start the building of the container.

## Docker
### Build the Docker container
Once you have configured the **GitHub App** and updated the source code, you should be ready to build the container.
- Change directory to inside the code base
  - `cd safe-settings/`
- Build the container
  - `docker build -t safe-settings .`
- This process should complete successfully and you will then have a **Docker** container ready for deployment

### Run the Docker container
Once the container has been successfully built, you can deploy it and start utilizing the **GitHub App**.

### Start the container with docker-compose
If you have docker-compose installed, you can simply start and stop the **Docker** container with:
- `cd safe-settings/; docker-compose --env-file .env up -d`
This will start the container in the background and detached.

### Start Docker container Detached in background
- Start the container detached with port assigned (*Assuming port 3000 for the webhook*)
  - `docker run -d -p 3000:3000 safe-settings`
- You should now have the container running in the background and can validate it running with the command:
  - `docker ps`
- This should show the `safe-settings` alive and running

### Start Docker container attached in foreground (Debug)
- If you need to run the container in interactive mode to validate connectivity and functionality:
  - `docker run -it -p 3000:3000 safe-settings`
- You will now have the log of the container showing to your terminal, and can validate connectivity and functionality.

### Connect to running Docker container (Debug)
- If you need to connect to the container thats already running, you can run the following command:
  - `docker exec -it safe-settings /bin/sh`
- You will now be inside the running **Docker** container and can perform any troubleshooting needed

### Troubleshooting Docker Build and Runtime Issues
For detailed guidance on debugging Docker image builds, runtime failures, and comparing local vs. GHCR images, see [docker-debugging.md](docker-debugging.md).

## Deploy the app to AWS Lambda

### Production-Ready Template 

For a complete, production-ready AWS Lambda deployment, use the [SafeSettings-Template](https://github.com/bheemreddy181/SafeSettings-Template):

- **🚀 Quick Start**: Click "Use this template" to get started immediately
- **🏗️ Modern Architecture**: Docker-based deployment with dual Lambda functions
- **🧪 Full CI/CD**: GitHub Actions with automated testing and deployment
- **📊 Smart Routing**: Handles both webhooks and scheduled sync operations
- **⚡ Serverless**: Auto-scaling with pay-per-execution pricing

See the [AWS Lambda Deployment Guide](awslambda.md) for detailed setup instructions.

### Alternative: Serverless Framework

For the original Serverless Framework approach, see [AWS-README.md](AWS-README.md).

### Proxy Support
The AWS Lambda handler, `handler.js` uses a custom  `Octokit` factory that creates Octokit with ___Proxied fetch___ instead of the regular ___fetch___ when the `http_proxy`/`https_proxy` env variables are set.

In the future we can use the same pattern to support proxy in all deployments of the app.

## Deploy the app in Kubernetes

### __Deploying using kubectl__
- Create and push your image to a container registry
- Create a `imagePullSecret`
  - For e.g.
	   `kubectl create secret docker-registry regcred --docker-server=DOCKER_REGISTRY_SERVER --docker-username=DOCKER_USER --docker-password=DOCKER_PASSWORD --docker-email=DOCKER_EMAIL`
- Create app secrets from the `.env` file
    `kubectl create secret generic app-env --from-env-file=.env`
- Deploy the app
    `kubectl apply -f safe-settings.yaml`
> **_NOTE:_**  If your secrets' names are different; modify them in the deployment yaml.
- Expose the app using a service
    `kubectl apply -f svc-safe-settings.yaml`

### __Deploying using [helm](https://docs.helm.sh/using_helm/#Install-Helm)__

[Helm](https://helm.sh/) must be installed to use the charts. Please refer to Helm's [documentation](https://helm.sh/docs/) to get started.

Once Helm is set up properly, view the latest Helm chart version:

```bash
helm show chart oci://ghcr.io/github/helm-charts/safe-settings
```

__Configure required values__

See the values that can be configured.
```bash
helm show values oci://ghcr.io/github/helm-charts/safe-settings
```

Make sure to set the [Deployment Environment Variables](#deployment-environment-variables) in a `myvalues.yaml` file.

Optionally, you can set other values like LOG_LEVEL. See [Environment variables](../README.md#environment-variables) for more details.

You can also override the `deploymentConfig` value.

__Install the chart__

Set the values using `--values` (preferred approach)
```bash
helm install safe-settings oci://ghcr.io/github/helm-charts/safe-settings --values myvalues.yaml
```

Set the with values using `--set`

```bash
helm install safe-settings oci://ghcr.io/github/helm-charts/safe-settings --set appEnv.APP_ID="\"0000\"" --set appEnv.PRIVATE_KEY="TFM...==" --set appEnv.WEBHOOK_SECRET="ZjZlYTFjN...=="
```

> [!NOTE]
> Setting up Ingress controller is out of scope of this doc, but is recommended.


__If not doing an install using Helm. Generate Kubernetes YAMLs__
```bash
helm template safe-settings oci://ghcr.io/github/helm-charts/safe-settings --values myvalues.yaml
```

*See [helm repo](https://helm.sh/docs/helm/helm_repo/) for command documentation.*

**Consider using a custom image**

For production use cases one should consider to build a custom safe-settings app image which conforms to your org standards.

Follow the instructions [here](#build-the-docker-container) on how to do it.


> [!NOTE]
> If you want a reproducible build then you should specify a non floating tag for the image `ghcr.io/github/safe-settings:2.1.13` .

Once you built the image and pushed it to your registry you can specify it in your `values` file like this:

```yaml
image:
  repository: custom-registry/safe-settings
  pullPolicy: IfNotPresent
  # Overrides the image tag whose default is the chart appVersion.
  tag: ""
```

In case you are using a private registry you can use `imagePullSecretName` to specify the name of the secret to use when pulling the image:

```yaml
imagePullSecrets: [regcred]
```

### Glitch

Glitch lets you host node applications for free and edit them directly in your browser. It’s great for experimentation and entirely sufficient for simple apps.

1. [Create a new app on Glitch](https://glitch.com/edit/#!/new-project).
2. Click on your app name on the top-right, press on advanced options and then on `Import from GitHub` (You will need to login with your GitHub account to enable that option). Enter the full repository name you want to import, e.g. for the [welcome app](https://github.com/behaviorbot/new-issue-welcome) it would be `behaviorbot/new-issue-welcome`. The `new-issue-welcome` app is a great template to get started with your own app, too!
3. Next open the `.env` file and replace its content with
   ```
   APP_ID=<your app id>
   WEBHOOK_SECRET=<your app secret>
   PRIVATE_KEY_PATH=.data/private-key.pem
   NODE_ENV=production
   ```
   Replace the two `<...>` placeholders with the values from your app. The `.env` file cannot be accessed or seen by others.
4. Press the `New File` button and enter `.data/private-key.pem`. Paste the content of your GitHub App’s `private-key.pem` in there and save it. Files in the `.data` folder cannot be seen or accessed by others, so your private key is safe.
5. That’s it, your app should have already started :thumbsup: Press on the `Show` button on top and paste the URL as the value of `Webhook URL`. Ensure that you remove `/probot` from the end of the `Webhook URL` that was just pasted.

Enjoy!

**Bonus:** You can deploy your app using [glitch-deploy](https://github.com/gr2m/glitch-deploy) directly from your terminal or as [continuous deployment](https://github.com/gr2m/glitch-deploy#deploy-from-ci).

### Heroku

Probot runs like [any other Node app](https://devcenter.heroku.com/articles/deploying-nodejs) on Heroku. After [creating the GitHub App](#create-the-github-app):

1.  Make sure you have the [Heroku CLI](https://devcenter.heroku.com/articles/heroku-cli) client installed.

2.  Clone the app that you want to deploy. e.g. `git clone https://github.com/probot/stale`

3.  Create the Heroku app with the `heroku create` command:

        $ heroku create
        Creating arcane-lowlands-8408... done, stack is cedar
        http://arcane-lowlands-8408.herokuapp.com/ | git@heroku.com:arcane-lowlands-8408.git
        Git remote heroku added

4.  Go back to your [app settings page](https://github.com/settings/apps) and update the **Webhook URL** to the "${URL_of_your_deployment}/api/github/webhooks", e.g. `http://arcane-lowlands-8408.herokuapp.com/api/github/webhooks`.

5.  Configure the Heroku app, replacing the `APP_ID` and `WEBHOOK_SECRET` with the values for those variables, and setting the path for the `PRIVATE_KEY`:

        $ heroku config:set APP_ID=aaa \
            WEBHOOK_SECRET=bbb \
            PRIVATE_KEY="$(cat ~/Downloads/*.private-key.pem)"

6.  Deploy the app to heroku with `git push`:

        $ git push heroku master
        ...
        -----> Node.js app detected
        ...
        -----> Launching... done
              http://arcane-lowlands-8408.herokuapp.com deployed to Heroku

7.  Your app should be up and running! To verify that your app
    is receiving webhook data, you can tail your app's logs:

         $ heroku config:set LOG_LEVEL=trace
         $ heroku logs --tail

8. SSL [Optional]: If you want to secure webhook payloads, go to Heroku app settings => Configure SSL => Automatic Certificate Management (ACM) which uses Let's encrypt (or upload your own). Then go to the GitHub app settings, and update the url to use https:// instead

9. Cron [Optional]: You can configure this app to run on a schedule using the var (CRON), you can set it in the app settings in the UI, or using `heroku config:set CRON='0 * * * *'` to run every hour for ex.

## Create the GitHub App

Every deployment will need an [App](https://developer.github.com/apps/).

1. The easiest way to create the Github App is using the [manifest flow](https://docs.github.com/en/developers/apps/building-github-apps/creating-a-github-app-from-a-manifest#using-probot-to-implement-the-github-app-manifest-flow). If you set up the app using the `manifest flow`, congrats, you are DONE!
2. [Create a new GitHub App](https://github.com/settings/apps/new) with:
   - **Homepage URL**: the URL to the GitHub repository for your app
   - **Webhook URL**: Use `https://example.com/` for now, we'll come back in a minute to update this with the URL of your deployed app.
   - **Webhook Secret**: Generate a unique secret with `openssl rand -base64 32` and save it because you'll need it in a minute to configure your deployed app.

## Permissions & events

1. Set the correct **Permissions & events** for the GitHub Integration:

### Permissions

#### Repository Permissions

- Actions: **Read-only**
- Administration: **Read & Write**
- Checks: **Read & Write**
- Commit statuses: **Read & Write**
- Contents: **Read & Write**
- Custom properties: **Read & Write**
- Environments: **Read & Write**
- Issues: **Read & Write**
- Metadata: **Read-only**
- Pull requests: **Read & Write**
- Variables: **Read & Write**

#### Organization Permissions

- Administration: **Read & Write**
- Custom organization roles: **Read-only**
- Custom properties: **Admin**
- Members: **Read & Write**

### Events

- Branch protection rule
- Check run
- Check suite
- Create
- Custom property values
- Member
- Pull request
- Push
- Repository
- Repository ruleset
- Team

1. Download the private key from the app.

2. Make sure that you click the green **Install** button on the top left of the app page. This gives you an option of installing the app on all or a subset of your repositories. __**Important: Install this App for `All` repos in the Org**__



## Share the app

The Probot website includes a list of [featured apps](https://probot.github.io/apps). Consider [adding your app to the website](https://github.com/probot/probot.github.io/blob/master/CONTRIBUTING.md#adding-your-app) so others can discover and use it.

## Combining apps

To deploy multiple apps in one instance, create a new app that has the existing apps listed as dependencies in `package.json`:

```json
{
  "name": "my-probot-app",
  "private": true,
  "dependencies": {
    "probot-autoresponder": "probot/autoresponder",
    "probot-settings": "probot/settings"
  },
  "scripts": {
    "start": "probot run"
  },
  "probot": {
    "apps": ["probot-autoresponder", "probot-settings"]
  }
}
```
