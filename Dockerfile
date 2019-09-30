FROM node:10

# Replace this with the Git branch you want to build the image from;
# Note: Docker Hub substitutes this automatically using their hooks/post_checkout script.
ENV SOURCE_BRANCH "master"

# Add the repository sources to the image
COPY . /compound-subgraph-wrapper
WORKDIR /compound-subgraph-wrapper

# Install dependencies and build server
RUN git checkout "$SOURCE_BRANCH" \
    && yarn --pure-lockfile \
    && yarn prepublish

ENTRYPOINT ["node", "dist/index.js"]
