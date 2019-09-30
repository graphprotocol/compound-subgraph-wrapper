FROM node:10

# Replace this with the Git branch you want to build the image from;
# Note: Docker Hub substitutes this automatically using their hooks/post_checkout script.
ENV SOURCE_BRANCH "master"

# Add the repository sources to the image
COPY . /compound-subgraph-wrapper

RUN ls -la /compound-subgraph-wrapper

# Install dependencies and build server
RUN cd /compound-subgraph-wrapper \
    && git checkout "$SOURCE_BRANCH" \
    && yarn --pure-lockfile \
    && yarn prepublish

WORKDIR /compound-subgraph-wrapper

ENTRYPOINT ["node", "dist/index.js"]
