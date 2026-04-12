FROM ensemblorg/ensembl-vep:release_101.0

RUN apt-get update && apt-get install -y curl && \
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash && \
    export NVM_DIR="$HOME/.nvm" && \
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && \
    nvm install 20.11.1 && \
    nvm use 20.11.1 && \
    nvm alias default 20.11.1 && \
    ln -sf $(which node) /usr/local/bin/node && \
    ln -sf $(which npm) /usr/local/bin/npm && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

RUN apt-get update && apt-get install -y \
    bedtools \
    vcftools \
    samtools \
    tabix \
    bcftools \
    wget \
    less \
    unzip \
    curl \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN export NVM_DIR="$HOME/.nvm" && \
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && \
    npm install -g pm2 && \
    ln -sf $(which pm2) /usr/local/bin/pm2 && \
    ln -sf $(which pm2-runtime) /usr/local/bin/pm2-runtime

WORKDIR /app

COPY package*.json ./
RUN npm install --legacy-peer-deps

COPY . .
RUN npm run build

EXPOSE 3001

CMD ["pm2-runtime", "dist/main.js"]
