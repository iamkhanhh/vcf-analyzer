FROM ensemblorg/ensembl-vep:release_114.0

USER root

RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

RUN apt-get update && apt-get install -y \
    bedtools \
    vcftools \
    samtools \
    tabix \
    bcftools \
    less \
    unzip \
    wget \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN npm install -g pm2

WORKDIR /app

COPY package*.json ./
RUN npm install --legacy-peer-deps

COPY . .
RUN npm run build

EXPOSE 3001

CMD ["pm2-runtime", "dist/main.js"]
