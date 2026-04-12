FROM ensemblorg/ensembl-vep:release_101.0

USER root

RUN apt-get update && apt-get install -y wget && \
    wget -q https://nodejs.org/dist/v18.20.4/node-v18.20.4-linux-x64.tar.gz && \
    tar -xzf node-v18.20.4-linux-x64.tar.gz -C /usr/local --strip-components=1 && \
    rm node-v18.20.4-linux-x64.tar.gz && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

RUN apt-get update && apt-get install -y \
    bedtools \
    vcftools \
    samtools \
    tabix \
    bcftools \
    less \
    unzip \
    curl \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN npm install -g pm2

WORKDIR /app

COPY package*.json ./
RUN npm install --legacy-peer-deps

COPY . .
RUN npm run build

EXPOSE 3001

CMD ["pm2-runtime", "dist/main.js"]
