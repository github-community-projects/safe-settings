# See here for image contents: https://github.com/microsoft/vscode-dev-containers/tree/v0.195.0/containers/javascript-node/.devcontainer/base.Dockerfile
# [Choice] Node.js version/variant (use -bookworm variants on local arm64/Apple Silicon): e.g. 22-bookworm, 20-bookworm, 18-bookworm
ARG VARIANT=22-bookworm
FROM mcr.microsoft.com/devcontainers/javascript-node:1-${VARIANT}

# [Optional] Uncomment this section to install additional OS packages.
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
     && apt-get -y install --no-install-recommends python3 python3-pip

# [Optional] Uncomment if you want to install an additional version of node using nvm
# ARG EXTRA_NODE_VERSION=10
# RUN su node -c "umask 0002 && ./usr/local/share/nvm/nvm.sh && nvm install ${EXTRA_NODE_VERSION}"

# [Optional] Uncomment if you want to install more global node modules
# RUN su node -c "npm install -g <your-package-list-here>"

# Install aws cli
RUN curl "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o "awscliv2.zip" && \
  unzip awscliv2.zip && \
  sudo ./aws/install && \
  rm -rf ./aws && \
  rm awscliv2.zip
# Install sam cli
RUN ARCH_RAW=$(uname -m) && \
  ARCH=$ARCH_RAW && \
  if [ "$ARCH_RAW" = "aarch64" ]; then ARCH="arm64"; fi && \
  curl -L "https://github.com/aws/aws-sam-cli/releases/latest/download/aws-sam-cli-linux-${ARCH}.zip" -o "aws-sam-cli.zip" && \
  unzip aws-sam-cli.zip -d sam-installation && \
  sudo ./sam-installation/install && \
  rm -rf ./sam-installation && \
  rm aws-sam-cli.zip
