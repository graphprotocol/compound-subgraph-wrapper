FROM node:10

# Add the repository sources to the image
COPY . /compound-subgraph-wrapper
WORKDIR /compound-subgraph-wrapper

# Install dependencies and build server
RUN yarn --pure-lockfile && yarn prepublish

ENTRYPOINT ["node", "dist/index.js"]
