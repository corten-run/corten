ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.64.1-noble
FROM ${PLAYWRIGHT_IMAGE}

# Git documents this Ubuntu PPA for the latest stable upstream release.
# Noble's original Git does not support the immutable-source no-lazy-fetch gate.
RUN apt-get update -qq \
    && apt-get install -y -qq --no-install-recommends ca-certificates software-properties-common \
    && add-apt-repository -y ppa:git-core/ppa \
    && apt-get update -qq \
    && apt-get install -y -qq --no-install-recommends git \
    && git --no-replace-objects --no-lazy-fetch --version \
    && rm -rf /var/lib/apt/lists/*
